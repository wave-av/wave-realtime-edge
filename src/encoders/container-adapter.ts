/// <reference types="@cloudflare/workers-types" />
/**
 * RT-R8 — Adapter A primitives: the CF Realtime WS media-transport (websocket-adapter) client + tap.
 *
 * VERIFIED build contract: ~/.claude/plans/realtime-recording-dedup/cf-ws-adapter-contract.md (verified vs
 * cloudflare/realtime-examples `video-to-jpeg`). Two verified, pure, unit-testable primitives:
 *   1. createWebsocketAdapter — REST create-adapter call. The SFU dials OUT to OUR wss endpoint and pushes
 *      one track's media to us (we never pull). One create call can carry several tracks.
 *   2. decodePacket — the proto3 `Packet { sequenceNumber=1; timestamp=2; payload=5 }` wire decoder. The
 *      framing is ONE Packet per WS BINARY frame, NO length prefix, so decode = protobuf-decode each frame.
 *
 * Plus RawSfuTap: decoded Packet → encode → WebM/Matroska mux → RealtimeRecorder (tier=SKIP). The encode
 * step is an INJECTABLE seam (`AudioEncoder`); the default `PassthroughPcmEncoder` needs NO WASM — the SFU's
 * raw 16-bit-LE PCM is muxed verbatim as A_PCM/INT/LIT — so the whole raw-SFU pipe is buildable + provable
 * NOW. A future Opus WASM encoder swaps in behind the same seam with no change to the recorder or the tap.
 *
 * CRITICAL SKIP INVARIANT (design §4, all adapters): the realtime recording path is tier=SKIP. This module
 * NEVER imports `@wave-av/content-hash`, NEVER hashes, NEVER claims — bytes flow straight to the single
 * canonical R2 object via RealtimeRecorder. The bundle-guard test asserts this mechanically.
 *
 * LIVE-SPIKE-CONFIRMABLE (parameterized, NOT code blockers — see contract §"STILL UNKNOWN"): the Packet
 * timestamp UNITS (`tsToMs`), the exact SFU_API_BASE host (`sfuApiBase`), and the protobuf wire tags (the
 * decoder already handles any field order + unknown fields). All are config/inputs, defaulted sensibly here.
 */
import { WebmMuxer, type MuxerOptions } from "../muxer/webm.js";
import { vp8KeyframeDimensions } from "./ivf.js";
import { type RecordingResult } from "../recording-writer.js";
import { R2Sink, type RecordingSink } from "./recording-sink.js";

// CF app ids are long hex; SFU session ids are opaque url-safe tokens. Guard before interpolating (SSRF-safe).
const APPID = /^[0-9a-f]{32,}$/i;
const SESSIONID = /^[0-9a-zA-Z_-]{8,128}$/;
/** Default CF Realtime SFU API base (the same host sfu.ts uses). Overridable for staging/tests. */
export const DEFAULT_SFU_API_BASE = "https://rtc.live.cloudflare.com/v1";

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/** Typed boundary error for the WS-adapter client (mirrors SfuError's {code,message,status} envelope). */
export class SfuAdapterError extends Error {
  constructor(public code: string, message: string, public status = 502) {
    super(message);
    this.name = "SfuAdapterError";
  }
}

// ── 1. create-adapter REST ───────────────────────────────────────────────────────────────────────────────

/** One track to mirror over the WS adapter. `endpoint` = OUR public wss the SFU dials OUT to. */
export interface WsAdapterTrack {
  location: "remote";
  sessionId: string;
  trackName: string;
  endpoint: string; // wss://rt.wave.online/... — our recorder route
  outputCodec: "pcm" | "jpeg";
}

export interface CreateAdapterParams {
  appId: string;
  /** CF Calls SFU app bearer (NOT the RTK account token) — sourced from CF_CALLS_APP_* via env. */
  bearer: string;
  tracks: WsAdapterTrack[];
  /** SFU API base; defaults to DEFAULT_SFU_API_BASE. */
  sfuApiBase?: string;
}

export interface CreateAdapterResult {
  /** The adapter id the SFU echoes back (shape best-effort; the raw body is preserved). */
  adapterId?: string;
  raw: unknown;
}

/**
 * Retry policy for the create-adapter call. The SFU answers `not_found_track_error` when the publisher's media
 * isn't flowing YET — ICE/DTLS bring the track up ~hundreds of ms AFTER `/publish` returns, so a create issued
 * the instant publish returns races ahead of the media (proven live: Step D, 2026-06-22). That is a TRANSIENT
 * race, not a real failure, so we retry the CREATE until the track is sending. CF's adapter auto-reconnect only
 * re-dials an ALREADY-established endpoint that dropped — it does NOT cover this create-time not-yet-ready — so
 * the retry must live here. DEFAULT is no retry (maxAttempts 1, prior behavior); the live caller passes a budget.
 */
export interface AdapterRetry {
  /** Total attempts including the first. 1 = no retry. */
  maxAttempts: number;
  /** Backoff (ms) before the next try, given the 1-based attempt that just failed. Default ramps to ~1s. */
  delayMs?: (attempt: number) => number;
  /** Injectable sleep (tests pass a synchronous fake; default real setTimeout). */
  sleep?: (ms: number) => Promise<void>;
}

/** True when a create-adapter response says a track is not (yet) on the remote peer — the publish-race signal. */
function trackNotReady(json: unknown): boolean {
  const tracks = (json as { tracks?: unknown } | null)?.tracks;
  if (!Array.isArray(tracks)) return false;
  return tracks.some((t) => {
    if (t == null || typeof t !== "object") return false;
    const code = (t as { errorCode?: unknown }).errorCode;
    const desc = (t as { errorDescription?: unknown }).errorDescription;
    return code === "not_found_track_error" || (typeof desc === "string" && /track not found/i.test(desc));
  });
}

/**
 * Create a CF Realtime websocket media-transport adapter. POST {base}/apps/{appId}/adapters/websocket/new
 * with `{tracks}` and a Bearer token; the SFU then dials each track's `endpoint` wss and pushes media. The
 * fetch impl is injectable so every path is unit-tested with no live network. On a `not_found_track_error`
 * (publisher media not flowing yet — see AdapterRetry) the create is retried per `deps.retry` until the track
 * sends or the budget is spent. Throws SfuAdapterError at the boundary; never logs the bearer or the raw body.
 */
export async function createWebsocketAdapter(
  deps: { fetchImpl?: FetchLike; retry?: AdapterRetry },
  params: CreateAdapterParams,
): Promise<CreateAdapterResult> {
  if (!APPID.test(params.appId || "")) throw new SfuAdapterError("BAD_APP_ID", "invalid SFU app id", 400);
  if (!params.bearer) throw new SfuAdapterError("NOT_CONFIGURED", "SFU bearer token missing", 503);
  if (!Array.isArray(params.tracks) || params.tracks.length === 0) {
    throw new SfuAdapterError("BAD_REQUEST", "at least one track is required", 400);
  }
  for (const t of params.tracks) {
    if (!/^wss:\/\//.test(t.endpoint || "")) {
      throw new SfuAdapterError("BAD_ENDPOINT", "adapter endpoint must be a wss:// URL", 400);
    }
    if (!SESSIONID.test(t.sessionId || "")) {
      throw new SfuAdapterError("BAD_SESSION", "invalid sfu session id", 400);
    }
  }
  const base = (params.sfuApiBase ?? DEFAULT_SFU_API_BASE).replace(/\/+$/, "");
  const doFetch = deps.fetchImpl ?? fetch;
  const maxAttempts = Math.max(1, deps.retry?.maxAttempts ?? 1);
  const delayMs = deps.retry?.delayMs ?? ((attempt: number) => Math.min(250 * attempt, 1000));
  const sleep = deps.retry?.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  for (let attempt = 1; ; attempt++) {
    const res = await doFetch(`${base}/apps/${params.appId}/adapters/websocket/new`, {
      method: "POST",
      headers: { Authorization: `Bearer ${params.bearer}`, "Content-Type": "application/json" },
      body: JSON.stringify({ tracks: params.tracks }),
    });
    let json: unknown = null;
    try {
      json = await res.json();
    } catch {
      json = null;
    }
    const notReady = trackNotReady(json);
    if (res.ok && !notReady) {
      const obj = json && typeof json === "object" ? (json as Record<string, unknown>) : {};
      const id = obj.adapterId ?? obj.id;
      return { adapterId: id != null ? String(id) : undefined, raw: json };
    }
    // Transient publish race (track not sending yet) → back off and retry the CREATE until the budget is spent.
    if (notReady && attempt < maxAttempts) {
      await sleep(delayMs(attempt));
      continue;
    }
    // observability only — never the token; notReady distinguishes the race from a real upstream error.
    console.warn(`sfu-ws-adapter status=${res.status} ok=${res.ok} notReady=${notReady} attempt=${attempt}`);
    throw new SfuAdapterError("UPSTREAM", `create websocket adapter returned ${res.status}`, 502);
  }
}

// ── 2. Packet wire decoder ───────────────────────────────────────────────────────────────────────────────

/** One decoded media Packet: the monotonic seq + source timestamp + the raw codec payload (PCM or JPEG). */
export interface SfuPacket {
  sequenceNumber: number;
  timestamp: number;
  payload: Uint8Array;
}

/** Read a base-128 varint at `pos`; returns [value, nextPos]. Uses multiplication (not <<) so large
 *  timestamps don't overflow JS's 32-bit bitwise math. */
function readVarint(buf: Uint8Array, pos: number): [number, number] {
  let result = 0;
  let mul = 1;
  let p = pos;
  for (;;) {
    if (p >= buf.length) throw new SfuAdapterError("BAD_PACKET", "varint truncated", 400);
    const b = buf[p++];
    result += (b & 0x7f) * mul;
    if ((b & 0x80) === 0) break;
    mul *= 128;
    if (mul > 2 ** 56) throw new SfuAdapterError("BAD_PACKET", "varint too long", 400);
  }
  return [result, p];
}

/**
 * Decode ONE WS binary frame (one proto3 Packet) → {sequenceNumber, timestamp, payload}. Robust to field
 * order and to unknown/added fields (they are skipped by wire type), so a future SFU schema addition won't
 * break decoding. Throws SfuAdapterError on a malformed/truncated frame. The `payload` is copied out of the
 * input frame, so it is safe to retain past the frame's lifetime.
 */
export function decodePacket(frame: Uint8Array): SfuPacket {
  let pos = 0;
  let sequenceNumber = 0;
  let timestamp = 0;
  let payload = new Uint8Array(0);
  while (pos < frame.length) {
    const [tag, p1] = readVarint(frame, pos);
    pos = p1;
    const field = Math.floor(tag / 8);
    const wire = tag & 0x7;
    if (wire === 0) {
      const [v, p2] = readVarint(frame, pos);
      pos = p2;
      if (field === 1) sequenceNumber = v;
      else if (field === 2) timestamp = v;
    } else if (wire === 2) {
      const [len, p2] = readVarint(frame, pos);
      pos = p2;
      if (pos + len > frame.length) throw new SfuAdapterError("BAD_PACKET", "length-delimited truncated", 400);
      const slice = frame.slice(pos, pos + len); // copy out (own ArrayBuffer) → safe to retain
      pos += len;
      if (field === 5) payload = slice;
    } else if (wire === 5) {
      pos += 4; // fixed32 (unused field) — skip
    } else if (wire === 1) {
      pos += 8; // fixed64 (unused field) — skip
    } else {
      throw new SfuAdapterError("BAD_PACKET", `unsupported wire type ${wire}`, 400);
    }
  }
  return { sequenceNumber, timestamp, payload };
}

// ── 3. RawSfuTap: decoded Packet → encode → mux → SKIP recorder ──────────────────────────────────────────

/** The encode seam. Maps one decoded audio payload → encoded codec bytes for the muxer. */
export interface AudioEncoder {
  /** The muxer audio codec these bytes are valid for. */
  readonly codec: "pcm" | "opus";
  /** Encode one decoded payload. PCM passthrough is identity; an Opus WASM encoder replaces this. */
  encode(payload: Uint8Array): Uint8Array;
}

/**
 * RT-R8 video seam (P3 SCAFFOLD) — the JPEG→VP8 encode seam, parallel to AudioEncoder. The SFU pushes video as
 * `outputCodec:"jpeg"` frames; an injected VideoEncoder turns each decoded JPEG into a VP8 keyframe the muxer
 * writes as a video SimpleBlock. This is the ◆ infra slice: a real VP8 encoder needs libvpx (the rt-encoder
 * container — see containers/rt-encoder/). DEFAULT: no video encoder injected → video frames are DROPPED
 * (audio-only path is unchanged), so the container stays OPTIONAL. NEVER imports `@wave-av/content-hash`.
 *
 * SYNC vs ASYNC: this seam is SYNCHRONOUS (one JPEG → one raw VP8 keyframe). The real encode runs in the
 * rt-encoder container over the network, which is ASYNC and returns IVF (not raw VP8) — that path uses the
 * `AsyncVideoEncoder` seam below instead. The sync seam stays for local/test transcodes that yield raw VP8.
 */
export interface VideoEncoder {
  /** The muxer video codec these bytes are valid for (the muxer's video TrackEntry declares V_VP8). */
  readonly codec: "vp8";
  /** Encode one decoded JPEG frame → a VP8 keyframe. (Real impl: libvpx in the rt-encoder container — ◆.) */
  encode(jpeg: Uint8Array): Uint8Array;
}

/**
 * RT-R10 (#72) — the ASYNC video encode seam, used when the real encode is a network round-trip to the
 * rt-encoder container (RecorderTarget). One decoded JPEG payload → zero-or-more RAW VP8 frames (the container
 * returns IVF; the glue parses it to raw VP8 frames + keyframe flags — see src/encoders/ivf.ts). Returning a
 * LIST (not one frame) means a multi-frame IVF body, or a dropped/empty body ([]), is handled uniformly.
 * fail-open: an encode/parse error resolves to [] (the muxer gets nothing → that one video frame is dropped).
 */
export interface AsyncVideoEncoder {
  readonly codec: "vp8";
  /** Encode one decoded JPEG → raw VP8 frames (each with its keyframe flag). [] = dropped/empty (fail-open). */
  encode(jpeg: Uint8Array): Promise<Array<{ data: Uint8Array; keyframe: boolean }>>;
}

/** Default no-WASM encoder: the SFU's raw 16-bit-LE PCM is already mux-ready as A_PCM/INT/LIT. */
export class PassthroughPcmEncoder implements AudioEncoder {
  readonly codec = "pcm" as const;
  encode(payload: Uint8Array): Uint8Array {
    return payload;
  }
}

/** Where the tap writes the one canonical SKIP object (an R2 bucket + the org/session identity). */
export interface RawSfuTapTarget {
  bucket: R2Bucket;
  org: string;
  sessionId: string;
}

export interface RawSfuTapOptions {
  /** Identity + default cloud bucket. The default sink (R2Sink) is built from this when `sink` is omitted. */
  target: RawSfuTapTarget;
  /**
   * RT-R10 (#72) recording SINK seam: WHERE the finalized bytes land. Omitted → a plain `R2Sink` over
   * `target.bucket` (byte-identical to the original direct-RealtimeRecorder path). Provide `selectSink(env,…)`
   * to enable localfs/fanout on a self-host runtime (the Worker has no fs, so it always resolves to R2Sink).
   * The sink owns the lazy multipart begin + the SKIP/single-writer invariant; this tap never touches R2 directly.
   */
  sink?: RecordingSink;
  /** Encode seam; default PassthroughPcmEncoder (no WASM). */
  encoder?: AudioEncoder;
  /**
   * Which media this track delivers (matches the WS adapter's `outputCodec`). "pcm" (default) → audio frames;
   * "jpeg" → video frames routed through `videoEncoder`. Without a videoEncoder, "jpeg" frames are dropped.
   */
  outputCodec?: "pcm" | "jpeg";
  /**
   * Video encode seam (P3 ◆). When set AND outputCodec==="jpeg", each decoded JPEG payload → VP8 → a video
   * SimpleBlock (keyframe). Absent → video frames are DROPPED (audio-only path unchanged, container OPTIONAL).
   */
  videoEncoder?: VideoEncoder;
  /**
   * RT-R10 (#72) ASYNC video encode seam (the live container/self-host path). When set AND outputCodec==="jpeg",
   * each decoded JPEG payload is encoded over the network (RecorderTarget) → IVF → raw VP8 frames, each muxed as
   * a video SimpleBlock IN ARRIVAL ORDER (an internal serialized queue threads the async encode + drains on
   * finalize). Takes precedence over the sync `videoEncoder` when both are set. Absent (and no sync encoder) →
   * video frames are DROPPED (audio-only path unchanged). NEVER blocks media: each onFrame returns immediately
   * after enqueuing; the queue drains in the background and is awaited by finalize().
   */
  asyncVideoEncoder?: AsyncVideoEncoder;
  /** Muxer geometry/rate overrides (audioCodec is forced to the encoder's codec). */
  muxerOptions?: Omit<MuxerOptions, "audioCodec">;
  /** Packet timestamp → ms. Default identity (assumes ms); set to t=>t/48 if the SFU emits 48kHz samples. */
  tsToMs?: (ts: number) => number;
  /** Drain → recorder.append threshold in bytes. Default 1 MiB (keeps the multipart tail bounded). */
  flushBytes?: number;
}

/**
 * RawSfuTap — consume the SFU's outbound WS media frames for ONE track and persist them to ONE canonical R2
 * object (tier=SKIP). The recorder is begun LAZILY on the first flush with the muxer's leading bytes (so the
 * EBML magic is the object's first bytes → sniffWebm tags the extension). Finalize is idempotent. A track
 * that delivered no media uploads nothing (no 0-byte object). Fail-open: a recording error never propagates
 * up the media path — callers wrap onFrame/finalize in try/catch (best-effort recording).
 */
export class RawSfuTap {
  private readonly target: RawSfuTapTarget;
  private readonly encoder: AudioEncoder;
  private readonly outputCodec: "pcm" | "jpeg";
  private readonly videoEncoder: VideoEncoder | null;
  private readonly asyncVideoEncoder: AsyncVideoEncoder | null;
  private readonly muxer: WebmMuxer;
  private readonly tsToMs: (ts: number) => number;
  private readonly flushBytes: number;
  private readonly sink: RecordingSink;
  private firstTs: number | null = null;
  private finalized = false;
  /**
   * Order-preserving async video pipeline. Each video onFrame chains its (await encode → mux → maybe flush) step
   * onto this tail so frames mux in ARRIVAL ORDER even though the encode is a network round-trip that may settle
   * out of order. onFrame returns immediately after chaining (never blocks media); finalize() awaits the tail.
   * Each step is fail-open (its own try/catch collapses to void) so one bad frame never breaks the chain.
   */
  private videoQueue: Promise<void> = Promise.resolve();

  constructor(opts: RawSfuTapOptions) {
    this.target = opts.target;
    this.encoder = opts.encoder ?? new PassthroughPcmEncoder();
    this.outputCodec = opts.outputCodec ?? "pcm";
    this.videoEncoder = opts.videoEncoder ?? null;
    this.asyncVideoEncoder = opts.asyncVideoEncoder ?? null;
    this.muxer = new WebmMuxer({ ...opts.muxerOptions, audioCodec: this.encoder.codec });
    this.tsToMs = opts.tsToMs ?? ((t) => t);
    this.flushBytes = opts.flushBytes ?? 1024 * 1024;
    // Default to a plain R2Sink over the target bucket — byte-identical to the original direct-RealtimeRecorder
    // path. A caller (container.ts) passes `selectSink(env,…)` to enable localfs/fanout on a self-host runtime.
    this.sink = opts.sink ?? new R2Sink(opts.target.bucket, { org: opts.target.org, sessionId: opts.target.sessionId });
  }

  /** The canonical key once the sink has begun (null before the first byte). */
  get key(): string | null {
    return this.sink.key;
  }

  /** RT-R10 (#72): which sink this tap writes to ("r2" | "localfs" | "fanout") — log/correlation + wiring assertions. */
  get sinkKind(): RecordingSink["kind"] {
    return this.sink.kind;
  }

  /**
   * Feed ONE raw WS binary frame (one Packet): decode → encode → mux frame → flush when full. Audio
   * (outputCodec "pcm") muxes a video-less audio SimpleBlock. Video (outputCodec "jpeg") routes the decoded
   * JPEG through the injected `videoEncoder` (P3 ◆) → a VP8 keyframe video SimpleBlock; with NO videoEncoder
   * the video frame is DROPPED (audio-only path unchanged, container OPTIONAL).
   */
  async onFrame(frame: Uint8Array): Promise<void> {
    if (this.finalized) return;
    const pkt = decodePacket(frame);
    if (pkt.payload.length === 0) return; // keep-alive / empty frame
    if (this.firstTs === null) this.firstTs = pkt.timestamp;
    const tsMs = Math.max(0, Math.floor(this.tsToMs(pkt.timestamp - this.firstTs)));
    if (this.outputCodec === "jpeg") {
      // ASYNC path (live container/self-host): the encode is a network round-trip returning IVF → many raw VP8
      // frames. Chain it onto the order-preserving queue so frames mux in ARRIVAL ORDER; return immediately
      // (never block media). The sync `videoEncoder` path stays for local/test transcodes that yield raw VP8.
      if (this.asyncVideoEncoder) {
        const jpeg = pkt.payload; // already copied out by decodePacket → safe to retain across the await
        this.videoQueue = this.videoQueue.then(() => this.encodeAndMuxVideo(jpeg, tsMs));
        return;
      }
      if (!this.videoEncoder) return; // no VP8 encoder injected → drop video (audio-only path unchanged)
      const vp8 = this.videoEncoder.encode(pkt.payload);
      if (vp8.length === 0) return;
      this.applyKeyframeDimensions(vp8, true); // thread REAL geometry into the Tracks header (#78)
      this.muxer.addFrame({ kind: "video", data: vp8, timestampMs: tsMs, keyframe: true });
    } else {
      this.muxer.addFrame({ kind: "audio", data: this.encoder.encode(pkt.payload), timestampMs: tsMs });
    }
    if (this.muxer.pending >= this.flushBytes) await this.flush();
  }

  /**
   * One async video step (runs serialized on `videoQueue`): await the network encode, mux every returned raw VP8
   * frame as a video SimpleBlock (keyframe flag from the IVF/VP8 header), flush when the buffer is full. Fully
   * fail-open: ANY error (encode, parse, mux) is swallowed so a single bad frame never breaks the queue or the
   * media path. After finalize() set `finalized`, in-flight steps stop muxing (the muxer is already finished).
   */
  private async encodeAndMuxVideo(jpeg: Uint8Array, tsMs: number): Promise<void> {
    try {
      const frames = await this.asyncVideoEncoder!.encode(jpeg);
      if (this.finalized) return; // a step that settles after finalize must not mutate the finished muxer
      for (const f of frames) {
        if (f.data.length === 0) continue;
        this.applyKeyframeDimensions(f.data, f.keyframe); // thread REAL geometry into the Tracks header (#78)
        this.muxer.addFrame({ kind: "video", data: f.data, timestampMs: tsMs, keyframe: f.keyframe });
      }
      if (this.muxer.pending >= this.flushBytes) await this.flush();
    } catch {
      /* fail-open — drop this one video frame, keep the queue + media path alive */
    }
  }

  /**
   * RT-R10 (#78) — thread the REAL frame geometry from the FIRST VP8 keyframe into the muxer's Tracks header.
   * VP8 self-describes its dimensions (the muxer's 1280×720 default was a placeholder), so we read them off the
   * keyframe and set them BEFORE any frame is muxed (the muxer writes its header lazily on the first addFrame).
   * `setVideoDimensions` is a no-op once the header is written and `vp8KeyframeDimensions` returns null on bad
   * bytes, so this is fully fail-soft + idempotent: only the first valid keyframe's dims ever take effect.
   */
  private applyKeyframeDimensions(vp8: Uint8Array, keyframe: boolean): void {
    if (!keyframe) return;
    const dims = vp8KeyframeDimensions(vp8);
    if (dims) this.muxer.setVideoDimensions(dims.width, dims.height);
  }

  /** Flush + finalize the one canonical recording. Idempotent; returns null when nothing was recorded. */
  async finalize(): Promise<RecordingResult | null> {
    if (this.finalized) return this.sink.finalize();
    // Drain any in-flight async video encodes FIRST (before marking finalized) so every enqueued VP8 frame is
    // muxed before the muxer is closed. The queue is fail-open, so this never throws.
    await this.videoQueue;
    this.finalized = true;
    this.muxer.finish();
    await this.flush();
    // The sink returns null when no bytes were ever written (never a 0-byte object) — the SKIP invariant.
    return this.sink.finalize();
  }

  /** Best-effort abort (error / no bytes). Never throws. */
  async abort(): Promise<void> {
    this.finalized = true;
    await this.sink.abort();
  }

  /** Drain the muxer and stream into the sink, which lazily begins the canonical object on the first bytes. */
  private async flush(): Promise<void> {
    const bytes = this.muxer.drain();
    if (bytes.length === 0) return;
    await this.sink.write(bytes);
  }
}
