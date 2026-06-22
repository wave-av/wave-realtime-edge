/// <reference types="@cloudflare/workers-types" />
/**
 * RT-R8/RT-R9 — Adapter A: CF Container WAVE-owned encoder (design §3), audio-first INERT impl.
 *
 * WHAT A DOES (audio-first, no Docker): A taps published SFU tracks over the CF Realtime WS media-transport
 * adapter (`createWebsocketAdapter`). The SFU dials OUT to OUR hibernatable Worker recorder route, pushing one
 * track's media as proto3 `Packet` frames; a `RawSfuTap` decodes → encodes (PCM passthrough, no WASM) → muxes
 * (WebM/Matroska) → streams into the SKIP-tier `RealtimeRecorder` at the ONE canonical org-rooted R2 object.
 * Audio needs NO container at all — it is hosted entirely in the Worker isolate. ONLY the JPEG→VP8 video slice
 * needs the rt-encoder container (deferred ◆ infra; the video seam lands in container-adapter.ts, dormant).
 *
 * INERT BY CONSTRUCTION: `begin` NEVER throws. When recording is disarmed (`RT_RECORD!=="1"`) or the CF-Calls
 * app creds are unconfigured (`containerRecordingConfigured(env)===false`), it logs loudly and returns `null`
 * (the caller no-ops) — config-no-silent-noop, fail-open. So even with `RT_ENCODER="container"` selected, a
 * prod env that has not been ◆-armed records nothing and breaks nothing. Live wrangler.toml keeps
 * `RT_ENCODER="managed"`, so this path is never selected in prod until a Jake-named flip.
 *
 * SKIP INVARIANT (design §4): this module NEVER imports `@wave-av/content-hash`; every byte flows to the
 * single canonical object via `RealtimeRecorder`. The bundle-guard test asserts this mechanically.
 */
import type { EncoderEnv, EncoderHandle, RecordingEncoder, RecordingSession } from "./encoder.js";
import type { RecordingResult } from "../recording-writer.js";
import { createWebsocketAdapter, RawSfuTap, type WsAdapterTrack } from "./container-adapter.js";
import { mintRecorderToken } from "./recorder-auth.js";

const HEX32 = /^[0-9a-f]{32}$/i;

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/**
 * Is adapter A (raw-SFU container, audio-first WS path) configured to arm a recording? Requires:
 *   • armed (RT_RECORD==="1")
 *   • the SKIP sink R2 binding (RT_RECORDINGS) — the tap writes the one canonical object there
 *   • the CF-Calls SFU app creds (CF_CALLS_APP_ID hex + CF_CALLS_APP_SECRET) — the create-adapter Bearer
 * Any absent → false (the caller logs loudly and records nothing — config-no-silent-noop, never a silent
 * broken write). Mirrors `pullRecordingConfigured` (managed.ts) so both adapters gate the same shape.
 */
export function containerRecordingConfigured(env: EncoderEnv): boolean {
  return (
    env.RT_RECORD === "1" &&
    !!env.RT_RECORDINGS &&
    !!env.CF_CALLS_APP_ID &&
    HEX32.test(env.CF_CALLS_APP_ID) &&
    !!env.CF_CALLS_APP_SECRET
  );
}

/** Injectable seam so every path is unit-tested with no live network: the SFU create-adapter fetch + the
 *  base URL of OUR Worker recorder route the SFU dials OUT to (`${base}/${org}/${sessionId}/${trackName}`). */
export interface ContainerEncoderDeps {
  fetchImpl?: FetchLike;
  /** wss base of the hibernatable Worker recorder route (worker.ts /v1/realtime/recorder/...). */
  recorderEndpointBase?: string;
}

/** Default wss base of the Worker recorder route on the live realtime host (overridable for tests/staging). */
export const DEFAULT_RECORDER_ENDPOINT_BASE = "wss://rt.wave.online/v1/realtime/recorder";

/**
 * ContainerEncoder (adapter A). Constructed armed by the factory (`RT_RECORD==="1"` + `RT_ENCODER="container"`).
 * `begin` returns a `ContainerHandle` when configured, else `null` (loud-warn, never throw — fail-open).
 */
export class ContainerEncoder implements RecordingEncoder {
  readonly kind = "container" as const;
  private readonly fetchImpl: FetchLike;
  private readonly recorderBase: string;
  constructor(
    private readonly env: EncoderEnv,
    deps: ContainerEncoderDeps = {},
  ) {
    // Bind to globalThis: native `fetch` throws "Illegal invocation" when later called as `this.fetchImpl(...)`;
    // binding makes every call site safe (a no-op for an injected test fake). See managed.ts for the same fix.
    this.fetchImpl = (deps.fetchImpl ?? fetch).bind(globalThis);
    this.recorderBase = (deps.recorderEndpointBase ?? DEFAULT_RECORDER_ENDPOINT_BASE).replace(/\/+$/, "");
  }

  async begin(session: RecordingSession): Promise<EncoderHandle | null> {
    if (!containerRecordingConfigured(this.env)) {
      // Loud, not silent (config-no-silent-noop). Inert: nothing is recorded, nothing throws.
      console.warn(
        JSON.stringify({
          msg: "rt-container-not-configured",
          armed: this.env.RT_RECORD === "1",
          hasBucket: !!this.env.RT_RECORDINGS,
          hasApp: !!this.env.CF_CALLS_APP_ID,
        }),
      );
      return null;
    }
    return new ContainerHandle(this.env, session, this.fetchImpl, this.recorderBase);
  }
}

/**
 * ContainerHandle — one armed raw-SFU session's recording. Holds a `Map<trackName, RawSfuTap>`: the FIRST time
 * an AUDIO track publishes, it (1) opens a `RawSfuTap` writing the SKIP object and (2) creates a CF WS adapter
 * so the SFU dials our recorder route for that track. VIDEO publishes are a no-op here (audio-first; the video
 * encode seam is the deferred ◆). `finalize`/`abort` fan out over every tap, fail-open. `toMeta` → null (the
 * tap's own multipart hibernation is owned by the RoomDO's per-session recorder map, not this handle).
 *
 * Fail-open everywhere: a create-adapter or tap error NEVER propagates up the publish/leave path — the caller
 * wraps onPublish/finalize in try/catch (best-effort recording, media-safety > recording).
 */
export class ContainerHandle implements EncoderHandle {
  private readonly taps = new Map<string, RawSfuTap>();
  /** Org-rooted R2 key prefix the taps write the canonical object under (correlation/log line). */
  readonly keyPrefix: string;

  constructor(
    private readonly env: EncoderEnv,
    private readonly session: RecordingSession,
    private readonly fetchImpl: FetchLike,
    private readonly recorderBase: string,
  ) {
    this.keyPrefix = `${session.org}/realtime-recordings/${session.sessionId}/`;
  }

  /** The live taps, keyed by trackName — the RoomDO feeds decoded frames to the right tap by (sessionId,trackName). */
  get tapsByTrack(): ReadonlyMap<string, RawSfuTap> {
    return this.taps;
  }

  /**
   * A track went live. AUDIO → open a tap + ask the SFU to push that track to our recorder route. VIDEO →
   * no-op (audio-first; the JPEG→VP8 video slice is the deferred container ◆). Idempotent per trackName.
   */
  async onPublish(trackName: string, kind: "audio" | "video"): Promise<void> {
    if (kind !== "audio") return; // audio-first; video is the deferred ◆ (no tap, no adapter)
    if (this.taps.has(trackName)) return; // idempotent — one tap per track
    const bucket = this.env.RT_RECORDINGS;
    if (!bucket) return; // defense in depth (containerRecordingConfigured already gated)
    const tap = new RawSfuTap({
      target: { bucket, org: this.session.org, sessionId: this.session.sessionId },
    });
    this.taps.set(trackName, tap);
    // Ask the SFU to dial OUT to our recorder route for this track. Fail-open: a create-adapter failure leaves
    // the tap in place (it simply receives no frames) and NEVER throws the publish down.
    try {
      // The SFU is a third party — it cannot send our `x-wave-internal` header. So when the internal secret
      // is bound, append a signed, per-(org,session,track), expiring capability token the recorder route
      // validates as an alternative auth. Unset (local/test) → bare endpoint (route enforces nothing either).
      let endpoint = `${this.recorderBase}/${this.session.org}/${this.session.sessionId}/${trackName}`;
      if (this.env.WAVE_INTERNAL_SECRET) {
        const t = await mintRecorderToken(
          this.env.WAVE_INTERNAL_SECRET,
          this.session.org,
          this.session.sessionId,
          trackName,
        );
        endpoint = `${endpoint}?t=${t}`;
      }
      const track: WsAdapterTrack = {
        location: "remote",
        sessionId: this.session.sessionId,
        trackName,
        endpoint,
        outputCodec: "pcm",
      };
      await createWebsocketAdapter(
        { fetchImpl: this.fetchImpl },
        {
          appId: this.env.CF_CALLS_APP_ID ?? "",
          bearer: this.env.CF_CALLS_APP_SECRET ?? "",
          tracks: [track],
        },
      );
    } catch {
      // best-effort — recording is never on the media critical path
    }
  }

  /** Session end: finalize every tap, return the FIRST canonical result (one object per audio track). Fail-open. */
  async finalize(): Promise<RecordingResult | null> {
    let first: RecordingResult | null = null;
    for (const tap of this.taps.values()) {
      try {
        const r = await tap.finalize();
        if (r && !first) first = r;
      } catch {
        /* fail-open — a finalize error never throws the leave down */
      }
    }
    return first;
  }

  /** Best-effort abort over every tap. Never throws. */
  async abort(): Promise<void> {
    for (const tap of this.taps.values()) {
      try {
        await tap.abort();
      } catch {
        /* best-effort */
      }
    }
  }

  /** No handle-level hibernation snapshot: the RoomDO persists each tap's recorder meta in its own session map. */
  toMeta(): unknown | null {
    return null;
  }
}
