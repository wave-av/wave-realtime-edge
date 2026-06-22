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
import { RealtimeRecorder, type RecordingResult } from "../recording-writer.js";

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
 * Create a CF Realtime websocket media-transport adapter. POST {base}/apps/{appId}/adapters/websocket/new
 * with `{tracks}` and a Bearer token; the SFU then dials each track's `endpoint` wss and pushes media. The
 * fetch impl is injectable so every path is unit-tested with no live network. Throws SfuAdapterError at the
 * boundary; never logs the bearer or the raw upstream body.
 */
export async function createWebsocketAdapter(
  deps: { fetchImpl?: FetchLike },
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
  if (!res.ok) {
    console.warn(`sfu-ws-adapter status=${res.status} ok=${res.ok}`); // observability only — never the token
    throw new SfuAdapterError("UPSTREAM", `create websocket adapter returned ${res.status}`, 502);
  }
  const obj = json && typeof json === "object" ? (json as Record<string, unknown>) : {};
  const id = obj.adapterId ?? obj.id;
  return { adapterId: id != null ? String(id) : undefined, raw: json };
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
 */
export interface VideoEncoder {
  /** The muxer video codec these bytes are valid for (the muxer's video TrackEntry declares V_VP8). */
  readonly codec: "vp8";
  /** Encode one decoded JPEG frame → a VP8 keyframe. (Real impl: libvpx in the rt-encoder container — ◆.) */
  encode(jpeg: Uint8Array): Uint8Array;
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
  target: RawSfuTapTarget;
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
  private readonly muxer: WebmMuxer;
  private readonly tsToMs: (ts: number) => number;
  private readonly flushBytes: number;
  private recorder: RealtimeRecorder | null = null;
  private firstTs: number | null = null;
  private finalized = false;

  constructor(opts: RawSfuTapOptions) {
    this.target = opts.target;
    this.encoder = opts.encoder ?? new PassthroughPcmEncoder();
    this.outputCodec = opts.outputCodec ?? "pcm";
    this.videoEncoder = opts.videoEncoder ?? null;
    this.muxer = new WebmMuxer({ ...opts.muxerOptions, audioCodec: this.encoder.codec });
    this.tsToMs = opts.tsToMs ?? ((t) => t);
    this.flushBytes = opts.flushBytes ?? 1024 * 1024;
  }

  /** The canonical R2 key once the recorder has begun (null before the first byte). */
  get key(): string | null {
    return this.recorder?.key ?? null;
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
      if (!this.videoEncoder) return; // no VP8 encoder injected → drop video (audio-only path unchanged)
      const vp8 = this.videoEncoder.encode(pkt.payload);
      if (vp8.length === 0) return;
      this.muxer.addFrame({ kind: "video", data: vp8, timestampMs: tsMs, keyframe: true });
    } else {
      this.muxer.addFrame({ kind: "audio", data: this.encoder.encode(pkt.payload), timestampMs: tsMs });
    }
    if (this.muxer.pending >= this.flushBytes) await this.flush();
  }

  /** Flush + finalize the one canonical recording. Idempotent; returns null when nothing was recorded. */
  async finalize(): Promise<RecordingResult | null> {
    if (this.finalized) return this.recorder ? this.recorder.finalize() : null;
    this.finalized = true;
    this.muxer.finish();
    await this.flush();
    if (!this.recorder) return null; // never any media → no object
    return this.recorder.finalize();
  }

  /** Best-effort abort (error / no bytes). Never throws. */
  async abort(): Promise<void> {
    this.finalized = true;
    await this.recorder?.safeAbort();
  }

  /** Drain the muxer and stream into the recorder, beginning it lazily with the first bytes. */
  private async flush(): Promise<void> {
    const bytes = this.muxer.drain();
    if (bytes.length === 0) return;
    if (!this.recorder) {
      this.recorder = await RealtimeRecorder.begin(this.target.bucket, this.target.org, this.target.sessionId, bytes);
    } else {
      await this.recorder.append(bytes);
    }
  }
}
