// room-recording.ts — RT-R9 per-DO raw-SFU recording orchestrator, extracted from room.ts so that file
// stays under the file-size gate (E-ROOMS P4 added the presence layer). Behavior is unchanged: this is the
// same class the RoomDO holds; type-only imports from ./room.js keep the split cycle-free.
import { selectEncoder } from "./encoders/factory.js";
import { R2Sink } from "./encoders/recording-sink.js";
import type { RecordingResult } from "./recording-writer.js";
import type { EncoderEnv, EncoderHandle, RecordingEncoder } from "./encoders/encoder.js";
import type { RoomDOEnv, RoomStorage, TrackKind } from "./room.js";

/**
 * RT-R9 — per-DO raw-SFU recording orchestrator. Holds the lazily-built recording encoder + one EncoderHandle
 * per SFU sessionId, and persists each handle's hibernation meta (handle.toMeta()) so a DO eviction mid-session
 * can resume. DORMANT for the live "managed" path (its handle has no onPublish + a null toMeta — nothing held);
 * only an ◆-armed RT_ENCODER="container" opens real taps. Every method is fail-open: a recording error NEVER
 * propagates up the publish/leave path (media-safety > recording, design §4).
 */
export class RoomRecording {
  private encoder: RecordingEncoder | null = null;
  /** sessionId → live EncoderHandle (one raw-SFU recording per participant SFU session). */
  private readonly handles = new Map<string, EncoderHandle>();

  constructor(
    private readonly env: RoomDOEnv,
    private readonly storage: RoomStorage,
  ) {}

  private static metaKey(sessionId: string): string {
    return `rt:recorder:${sessionId}`;
  }

  /** Lazily construct the encoder (selectEncoder) — DisarmedEncoder unless RT_RECORD="1". Injectable for tests. */
  private getEncoder(): RecordingEncoder {
    if (!this.encoder) {
      this.encoder = this.env.__recordingEncoder ?? selectEncoder(this.env as unknown as EncoderEnv);
    }
    return this.encoder;
  }

  /**
   * A track published in `org`'s room for participant SFU `sessionId`. Begins the recording handle for that
   * session on first publish, then forwards onPublish(trackName,kind). Persists the handle's hibernation meta.
   * Fail-open: any error is swallowed (recording is best-effort, never blocks the publish).
   */
  async onPublish(org: string, sessionId: string, room: string, trackName: string, kind: TrackKind): Promise<void> {
    try {
      let handle = this.handles.get(sessionId);
      if (!handle) {
        const begun = await this.getEncoder().begin({ org, room, sessionId });
        if (!begun) return; // disarmed / unconfigured → records nothing (loud-warned inside the encoder)
        handle = begun;
        this.handles.set(sessionId, handle);
      }
      if (handle.onPublish) await handle.onPublish(trackName, kind);
      await this.persist(sessionId, handle);
    } catch {
      /* fail-open — recording never blocks publish */
    }
  }

  /**
   * #151 HOSTED path: stream a finalized WebM/Matroska container (produced by the self-host werift recorder,
   * containers/rt-recorder) into the ONE canonical R2 object for (org, sessionId). The DO is the SINGLE WRITER
   * (this method runs in the RoomDO): `R2Sink` lazy-begins on the first byte (container magic → the right
   * extension), appends the rest, finalizes → {key,bytes,container}. Returns null when nothing was streamed or
   * no RT_RECORDINGS bucket is bound. NOT fail-open — unlike the best-effort frame tap, the recorder needs the
   * receipt (this stream IS the recording), so a write error propagates as a real failure the ingest surfaces.
   */
  async ingestContainer(org: string, sessionId: string, body: ReadableStream<Uint8Array>): Promise<RecordingResult | null> {
    const bucket = this.env.RT_RECORDINGS;
    if (!bucket) return null; // no SKIP sink bound → nothing to write (loud 501/422 upstream, never a silent ok)
    const sink = new R2Sink(bucket, { org, sessionId });
    const reader = body.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value && value.length > 0) await sink.write(value);
      }
      return await sink.finalize(); // one canonical object; null if zero bytes (never a 0-byte object)
    } catch (e) {
      await sink.abort();
      throw e;
    }
  }

  /** Feed ONE decoded WS media frame to the tap for (sessionId, trackName) — used by the Worker recorder route. */
  async feedFrame(sessionId: string, trackName: string, frame: Uint8Array): Promise<void> {
    try {
      const handle = this.handles.get(sessionId);
      // ContainerHandle exposes its taps; other handles (managed) hold no taps → frame is a no-op.
      const taps = (handle as { tapsByTrack?: ReadonlyMap<string, { onFrame(f: Uint8Array): Promise<void> }> })
        ?.tapsByTrack;
      const tap = taps?.get(trackName);
      if (tap) await tap.onFrame(frame);
    } catch {
      /* fail-open */
    }
  }

  /** Session end (leave/endRoom): finalize the handle for `sessionId`, clear its persisted meta. Fail-open. */
  async finalize(sessionId: string): Promise<void> {
    try {
      const handle = this.handles.get(sessionId);
      if (!handle) return;
      await handle.finalize();
    } catch {
      /* fail-open — a finalize error never throws the leave down */
    } finally {
      this.handles.delete(sessionId);
      try {
        await this.storage.put(RoomRecording.metaKey(sessionId), null);
      } catch {
        /* best-effort */
      }
    }
  }

  /** Persist a handle's hibernation snapshot so a DO wake can resume (null meta → nothing to hold). */
  private async persist(sessionId: string, handle: EncoderHandle): Promise<void> {
    try {
      const meta = handle.toMeta();
      if (meta != null) await this.storage.put(RoomRecording.metaKey(sessionId), meta);
    } catch {
      /* best-effort */
    }
  }
}
