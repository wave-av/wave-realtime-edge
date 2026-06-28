/// <reference types="@cloudflare/workers-types" />
/**
 * RT-R10 (#72) — RecordingSink seam: WHERE the finalized recording bytes land.
 *
 *   • R2Sink     — wrap the existing SKIP-tier RealtimeRecorder → ONE canonical R2 object (cloud, the default).
 *   • LocalFsSink — write the same bytes to a local directory (`RECORDER_LOCAL_DIR`) — for on-prem/self-host.
 *   • FanoutSink  — write the SAME bytes to N sinks (e.g. R2 + local) so an on-prem install keeps a local copy
 *                   AND the cloud copy. `finalize()` returns ONE canonical result (the FIRST sink's, by config).
 * `selectSink(env)` chooses by `RECORDER_SINK` (default `'r2'`).
 *
 * SINGLE-WRITER / A-DO INVARIANT (epic Risks): the Durable Object owns the canonical object. A FanoutSink does
 * NOT create competing writers — it writes the SAME byte stream to each sink in lockstep (`write(part)` fans the
 * one part to all), and `finalize()` returns ONE canonical `RecordingResult` (the primary sink's). So "one
 * session → one canonical object" holds; the extra sinks are exact replicas, never divergent writers.
 *
 * INERT BY DEFAULT: `RECORDER_SINK` defaults `'r2'` — identical to today's behavior (the RealtimeRecorder
 * path). LocalFsSink/FanoutSink are only reached when a Jake-named ◆ sets `RECORDER_SINK` + `RECORDER_LOCAL_DIR`
 * (an on-prem deploy). The Workers isolate has no filesystem, so LocalFsSink is injected a writer (the self-host
 * container/Node runtime provides a real one); in the Worker it is never selected.
 *
 * SKIP INVARIANT (bundle-guarded): this module NEVER imports `@wave-av/content-hash`. Every byte flows to the
 * canonical object(s) via RealtimeRecorder / the injected local writer — no hash, no claim, no dedup index.
 * FAIL-OPEN: a sink error in fanout never blocks the others; finalize returns the primary result best-effort.
 */
import { RealtimeRecorder, type RecordingResult } from "../recording-writer.js";

/** One chunk of recording bytes to persist (the muxer's drained output, in order). */
export type RecordingPart = Uint8Array;

/**
 * A destination for a single session's recording bytes. `write(part)` appends in order; `finalize()` commits and
 * returns the canonical result (or null if nothing was written). Mirrors the RealtimeRecorder lifecycle so R2Sink
 * is a thin wrapper.
 */
export interface RecordingSink {
  /** Which sink this is (log/correlation). */
  readonly kind: "r2" | "localfs" | "fanout";
  /**
   * The canonical key of this sink's object, available MID-RECORDING (null before the first byte). For R2 this is
   * the multipart object key as soon as the recorder begins; for localfs it is the file path (known at finalize);
   * for fanout it is the PRIMARY sink's key. Lets the orchestration read the canonical key while bytes still flow.
   */
  readonly key: string | null;
  write(part: RecordingPart): Promise<void>;
  finalize(): Promise<RecordingResult | null>;
  /** Best-effort abort (no bytes / error). Never throws. */
  abort(): Promise<void>;
}

/** Env keys this seam reads. */
export interface RecordingSinkEnv {
  /** Selector: where the recording lands. Default 'r2' (the cloud canonical object — today's behavior). */
  RECORDER_SINK?: "r2" | "localfs" | "fanout";
  /** The SKIP sink R2 bucket (same binding the webhook pull uses). Required for r2/fanout. */
  RT_RECORDINGS?: R2Bucket;
  /** Local directory for on-prem recording copies (self-host). Required for localfs/fanout. */
  RECORDER_LOCAL_DIR?: string;
}

/** Identity of the session being recorded — the canonical key is derived from these, NEVER a content hash. */
export interface SinkSession {
  org: string;
  sessionId: string;
}

/**
 * R2Sink — wrap the existing SKIP-tier RealtimeRecorder. Begins the recorder LAZILY on the first part (so the
 * leading bytes carry the container magic → the key gets the right extension), exactly like RawSfuTap.flush.
 */
export class R2Sink implements RecordingSink {
  readonly kind = "r2" as const;
  private recorder: RealtimeRecorder | null = null;
  private finalized: RecordingResult | null = null;
  constructor(
    private readonly bucket: R2Bucket,
    private readonly session: SinkSession,
  ) {}

  /** The canonical R2 key once the recorder has begun (null before the first byte). */
  get key(): string | null {
    return this.recorder?.key ?? null;
  }

  async write(part: RecordingPart): Promise<void> {
    if (part.length === 0) return;
    if (!this.recorder) {
      this.recorder = await RealtimeRecorder.begin(this.bucket, this.session.org, this.session.sessionId, part);
    } else {
      await this.recorder.append(part);
    }
  }

  async finalize(): Promise<RecordingResult | null> {
    if (this.finalized) return this.finalized;
    if (!this.recorder) return null; // no bytes → no object (never a 0-byte object)
    this.finalized = await this.recorder.finalize();
    return this.finalized;
  }

  async abort(): Promise<void> {
    await this.recorder?.safeAbort();
  }
}

/**
 * The minimal local-FS writer the LocalFsSink needs. Injected because the Workers isolate has NO filesystem —
 * the self-host (Path B) Node/container runtime provides a real implementation (append to a file under
 * RECORDER_LOCAL_DIR); unit tests provide a fake. Keeping it an interface keeps this module Worker-buildable.
 */
export interface LocalFileWriter {
  /** Append bytes to the session file (created on first write). */
  append(part: RecordingPart): Promise<void>;
  /** Close the file; return its absolute path + total bytes, or null if nothing was written. */
  close(): Promise<{ path: string; bytes: number } | null>;
  /** Best-effort discard. */
  discard(): Promise<void>;
}

/**
 * LocalFsSink — write the recording to a local directory (on-prem). The actual file IO is the injected
 * `LocalFileWriter` (no node:fs import here, so the module stays Worker-buildable + bundle-guard-clean). The
 * canonical key MIRRORS the R2 layout (`${org}/realtime-recordings/${sessionId}/recording.<ext>`) so a fanout
 * local copy and the cloud copy share one identity.
 */
export class LocalFsSink implements RecordingSink {
  readonly kind = "localfs" as const;
  private finalized: RecordingResult | null = null;
  private wroteAny = false;
  constructor(
    private readonly writer: LocalFileWriter,
    private readonly session: SinkSession,
  ) {}

  /** The local file path once finalized (null before close — the writer owns the path until then). */
  get key(): string | null {
    return this.finalized?.key ?? null;
  }

  async write(part: RecordingPart): Promise<void> {
    if (part.length === 0) return;
    await this.writer.append(part);
    this.wroteAny = true;
  }

  async finalize(): Promise<RecordingResult | null> {
    if (this.finalized) return this.finalized;
    if (!this.wroteAny) return null;
    const closed = await this.writer.close();
    if (!closed) return null;
    // Container is reported as "raw" here — the local path preserves bytes verbatim; the extension/container
    // is the writer's concern. The canonical R2 result (from R2Sink) is the billed one in a fanout.
    this.finalized = { key: closed.path, bytes: closed.bytes, container: "raw" };
    return this.finalized;
  }

  async abort(): Promise<void> {
    await this.writer.discard();
  }
}

/**
 * FanoutSink — write the SAME bytes to N sinks (e.g. [R2Sink, LocalFsSink]). The FIRST sink is the PRIMARY: its
 * `finalize()` result is the ONE canonical result returned (single-writer/A-DO: the others are exact replicas,
 * not divergent writers). A write/finalize error in a SECONDARY sink never blocks the primary (fail-open); a
 * primary error propagates its null result. Order is preserved per sink (each gets every part in sequence).
 */
export class FanoutSink implements RecordingSink {
  readonly kind = "fanout" as const;
  constructor(private readonly sinks: RecordingSink[]) {
    if (sinks.length === 0) throw new Error("FanoutSink needs at least one sink");
  }

  /** The PRIMARY sink's canonical key (the others are exact replicas). */
  get key(): string | null {
    return this.sinks[0].key;
  }

  async write(part: RecordingPart): Promise<void> {
    if (part.length === 0) return;
    // Primary first (so its lazy-begin ordering is deterministic); secondaries fail-open.
    await this.sinks[0].write(part);
    for (let i = 1; i < this.sinks.length; i++) {
      try {
        await this.sinks[i].write(part);
      } catch {
        /* fail-open — a replica write error never blocks the canonical write */
      }
    }
  }

  async finalize(): Promise<RecordingResult | null> {
    const primary = await this.sinks[0].finalize();
    for (let i = 1; i < this.sinks.length; i++) {
      try {
        await this.sinks[i].finalize();
      } catch {
        /* fail-open */
      }
    }
    return primary; // ONE canonical result — the primary sink's
  }

  async abort(): Promise<void> {
    for (const s of this.sinks) {
      try {
        await s.abort();
      } catch {
        /* best-effort */
      }
    }
  }
}

/** Injectable local writer factory (self-host provides a real fs-backed one; tests provide a fake). */
export interface SelectSinkDeps {
  localWriterFor?: (dir: string, session: SinkSession) => LocalFileWriter;
}

/**
 * Select the sink for this env. DEFAULT `'r2'` (the cloud canonical object — identical to today). `'localfs'`/
 * `'fanout'` require `RECORDER_LOCAL_DIR` + an injected `localWriterFor` (the self-host runtime); absent → falls
 * back to r2 (or, if RT_RECORDINGS is also absent, throws — a misconfigured sink must not silently no-op).
 * Loud-warns on a degraded selection (config-no-silent-noop).
 */
export function selectSink(env: RecordingSinkEnv, session: SinkSession, deps: SelectSinkDeps = {}): RecordingSink {
  const sel = env.RECORDER_SINK ?? "r2";
  const r2 = (): R2Sink => {
    if (!env.RT_RECORDINGS) throw new Error("RECORDER_SINK requires the RT_RECORDINGS R2 binding");
    return new R2Sink(env.RT_RECORDINGS, session);
  };
  const local = (): LocalFsSink | null => {
    if (!env.RECORDER_LOCAL_DIR || !deps.localWriterFor) {
      console.warn(JSON.stringify({ msg: "rt-sink-local-unconfigured", hasDir: !!env.RECORDER_LOCAL_DIR }));
      return null;
    }
    return new LocalFsSink(deps.localWriterFor(env.RECORDER_LOCAL_DIR, session), session);
  };

  if (sel === "localfs") {
    const l = local();
    if (l) return l;
    return r2(); // degrade to cloud rather than silently record nothing
  }
  if (sel === "fanout") {
    const l = local();
    if (l) return new FanoutSink([r2(), l]); // primary = R2 (the billed canonical), secondary = local replica
    return r2();
  }
  return r2();
}
