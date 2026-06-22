/**
 * RT-P1.5 — the WAVE WebM (Matroska) muxer (design §5).
 *
 * Needed by adapters A & B (NOT C — C gets a finished WebM from CF). A and B produce encoded VP8 video
 * frames + Opus audio frames and must assemble a valid streamable Matroska/WebM byte-stream themselves.
 *
 * SCOPE (minimal, streaming, append-only — design §5):
 *  - EBML header + Segment with the `1A 45 DF A3` leading magic so the recorder's `sniffWebm` tags `.webm`.
 *  - One video track (VP8) + one audio track (Opus) in the Tracks element.
 *  - SimpleBlock-per-frame inside time-ordered Clusters; a fresh Cluster on a keyframe boundary or when a
 *    size threshold is crossed, so chunks flush near R2's 5 MiB part lines.
 *  - Live/streamable: UNKNOWN-SIZE Segment + Cluster (no seekable Cues — a recording consumed after
 *    finalize needs none). Out of scope: seeking, chaptering, multiple resolutions, B-frames.
 *
 * This is a WRITE-ONLY recording muxer, not a general container library. Pure TS, fully unit-testable —
 * feed synthetic VP8/Opus frames → assert EBML structure + that `sniffWebm` returns "webm". No live media.
 *
 * SKIP compliance: this module produces opaque WebM bytes for `recorder.append`. It NEVER hashes and NEVER
 * imports `@wave-av/content-hash`.
 */

// ── EBML element IDs (Matroska/WebM spec). Stored as their full big-endian byte sequences. ──────────────
const ID = {
  EBML: [0x1a, 0x45, 0xdf, 0xa3],
  EBMLVersion: [0x42, 0x86],
  EBMLReadVersion: [0x42, 0xf7],
  EBMLMaxIDLength: [0x42, 0xf2],
  EBMLMaxSizeLength: [0x42, 0xf3],
  DocType: [0x42, 0x82],
  DocTypeVersion: [0x42, 0x87],
  DocTypeReadVersion: [0x42, 0x85],
  Segment: [0x18, 0x53, 0x80, 0x67],
  Info: [0x15, 0x49, 0xa9, 0x66],
  TimestampScale: [0x2a, 0xd7, 0xb1],
  MuxingApp: [0x4d, 0x80],
  WritingApp: [0x57, 0x41],
  Tracks: [0x16, 0x54, 0xae, 0x6b],
  TrackEntry: [0xae],
  TrackNumber: [0xd7],
  TrackUID: [0x73, 0xc5],
  TrackType: [0x83],
  CodecID: [0x86],
  Video: [0xe0],
  PixelWidth: [0xb0],
  PixelHeight: [0xba],
  Audio: [0xe1],
  SamplingFrequency: [0xb5],
  Channels: [0x9f],
  Cluster: [0x1f, 0x43, 0xb6, 0x75],
  Timestamp: [0xe7],
  SimpleBlock: [0xa3],
} as const;

/** The unknown-size VINT marker (all data bits set) for the chosen length-octet count. */
const UNKNOWN_SIZE = [0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]; // 8-octet unknown size

const TRACK_VIDEO = 1;
const TRACK_AUDIO = 2;
const TYPE_VIDEO = 1; // Matroska TrackType: video
const TYPE_AUDIO = 2; // Matroska TrackType: audio

/** New Cluster when the open one crosses this many bytes (keeps part flushes near R2's 5 MiB lines). */
const CLUSTER_SIZE_THRESHOLD = 4 * 1024 * 1024;
/** Matroska SimpleBlock relative timestamp is a signed int16 — a Cluster must span ≤ ~32s at 1ms scale. */
const MAX_REL_TIMESTAMP = 32760;

export interface MuxerOptions {
  /** Video pixel dimensions for the Tracks header. Defaults are placeholders until real frame geometry. */
  width?: number;
  height?: number;
  /** Opus sampling frequency / channel count. */
  sampleRate?: number;
  channels?: number;
  /** Writing-app string (defaults to "wave-realtime-edge"). */
  writingApp?: string;
}

export type FrameKind = "video" | "audio";

export interface EncodedFrame {
  kind: FrameKind;
  /** Encoded codec payload (VP8 for video, Opus for audio). */
  data: Uint8Array;
  /** Absolute presentation timestamp in milliseconds from session start (monotonic non-decreasing). */
  timestampMs: number;
  /** Video keyframe marker — forces a Cluster boundary and sets the SimpleBlock keyframe flag. */
  keyframe?: boolean;
}

// ── VINT (variable-length integer) encoding for element SIZES. ──────────────────────────────────────────
/** Encode `value` as a Matroska size VINT (1–8 octets, smallest that fits). */
function vint(value: number): Uint8Array {
  // Each octet width w (1..8) holds (7*w) data bits, with a leading length-marker bit.
  for (let w = 1; w <= 8; w++) {
    const max = 2 ** (7 * w) - 1; // all-ones is reserved for "unknown", so usable range is [0, max-1]
    if (value < max) {
      const out = new Uint8Array(w);
      let v = value;
      for (let i = w - 1; i >= 0; i--) {
        out[i] = v & 0xff;
        v = Math.floor(v / 256);
      }
      out[0] |= 0x80 >> (w - 1); // set the length-marker bit
      return out;
    }
  }
  throw new RangeError("EBML size too large for an 8-octet VINT");
}

/** A complete element: id bytes + size VINT + payload. */
function elem(id: readonly number[], payload: Uint8Array): Uint8Array {
  return concat([Uint8Array.from(id), vint(payload.length), payload]);
}

/** A master element whose payload is the concatenation of child elements. */
function master(id: readonly number[], children: Uint8Array[]): Uint8Array {
  return elem(id, concat(children));
}

/** A 1-byte unsigned-int element. */
function uintElem(id: readonly number[], value: number): Uint8Array {
  const bytes: number[] = [];
  let v = value;
  do {
    bytes.unshift(v & 0xff);
    v = Math.floor(v / 256);
  } while (v > 0);
  return elem(id, Uint8Array.from(bytes));
}

/** A UTF-8 string element. */
function strElem(id: readonly number[], value: string): Uint8Array {
  return elem(id, new TextEncoder().encode(value));
}

/** An IEEE-754 big-endian float64 element (for SamplingFrequency). */
function floatElem(id: readonly number[], value: number): Uint8Array {
  const buf = new ArrayBuffer(8);
  new DataView(buf).setFloat64(0, value, false);
  return elem(id, new Uint8Array(buf));
}

function concat(parts: Uint8Array[]): Uint8Array {
  let len = 0;
  for (const p of parts) len += p.length;
  const out = new Uint8Array(len);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

/**
 * WebmMuxer — append-only, streaming WebM writer. `header()` once, then `addFrame()` per encoded frame;
 * `drain()` returns the buffered bytes ready to flush. Emits unknown-size Segment + Clusters so the stream
 * is valid without a final seek/Cues pass.
 */
export class WebmMuxer {
  private readonly opts: Required<MuxerOptions>;
  private out: Uint8Array[] = [];
  private headerWritten = false;
  /** Open Cluster's base (absolute) timestamp in ms; null when no Cluster is open. */
  private clusterBaseMs: number | null = null;
  private clusterBytes = 0;
  private lastTs = 0;

  constructor(options: MuxerOptions = {}) {
    this.opts = {
      width: options.width ?? 1280,
      height: options.height ?? 720,
      sampleRate: options.sampleRate ?? 48000,
      channels: options.channels ?? 2,
      writingApp: options.writingApp ?? "wave-realtime-edge",
    };
  }

  /** Emit the EBML head + Segment open + Info + Tracks. Must be called once before any frame. */
  header(): void {
    if (this.headerWritten) return;
    this.headerWritten = true;

    const ebml = master(ID.EBML, [
      uintElem(ID.EBMLVersion, 1),
      uintElem(ID.EBMLReadVersion, 1),
      uintElem(ID.EBMLMaxIDLength, 4),
      uintElem(ID.EBMLMaxSizeLength, 8),
      strElem(ID.DocType, "webm"),
      uintElem(ID.DocTypeVersion, 2),
      uintElem(ID.DocTypeReadVersion, 2),
    ]);

    // Info: 1ms TimestampScale (1_000_000 ns).
    const info = master(ID.Info, [
      elem(ID.TimestampScale, u32be(1_000_000)),
      strElem(ID.MuxingApp, "wave-realtime-edge"),
      strElem(ID.WritingApp, this.opts.writingApp),
    ]);

    const videoTrack = master(ID.TrackEntry, [
      uintElem(ID.TrackNumber, TRACK_VIDEO),
      uintElem(ID.TrackUID, TRACK_VIDEO),
      uintElem(ID.TrackType, TYPE_VIDEO),
      strElem(ID.CodecID, "V_VP8"),
      master(ID.Video, [
        uintElem(ID.PixelWidth, this.opts.width),
        uintElem(ID.PixelHeight, this.opts.height),
      ]),
    ]);
    const audioTrack = master(ID.TrackEntry, [
      uintElem(ID.TrackNumber, TRACK_AUDIO),
      uintElem(ID.TrackUID, TRACK_AUDIO),
      uintElem(ID.TrackType, TYPE_AUDIO),
      strElem(ID.CodecID, "A_OPUS"),
      master(ID.Audio, [
        floatElem(ID.SamplingFrequency, this.opts.sampleRate),
        uintElem(ID.Channels, this.opts.channels),
      ]),
    ]);
    const tracks = master(ID.Tracks, [videoTrack, audioTrack]);

    // Segment is opened UNKNOWN-SIZE (streamable), then Info + Tracks are written as its first children.
    const segmentOpen = concat([Uint8Array.from(ID.Segment), Uint8Array.from(UNKNOWN_SIZE)]);
    this.push(ebml);
    this.push(segmentOpen);
    this.push(info);
    this.push(tracks);
  }

  /** Append one encoded frame as a SimpleBlock, opening a fresh Cluster on a boundary as needed. */
  addFrame(frame: EncodedFrame): void {
    if (!this.headerWritten) this.header();
    const ts = Math.max(0, Math.floor(frame.timestampMs));
    if (ts < this.lastTs) {
      // Timestamps must be monotonic non-decreasing for the relative-block math; clamp a late frame.
      frame.timestampMs = this.lastTs;
    }
    this.lastTs = Math.max(this.lastTs, ts);

    const needNewCluster =
      this.clusterBaseMs === null ||
      (frame.kind === "video" && frame.keyframe) ||
      this.clusterBytes >= CLUSTER_SIZE_THRESHOLD ||
      ts - this.clusterBaseMs > MAX_REL_TIMESTAMP;
    if (needNewCluster) this.openCluster(ts);

    const rel = ts - (this.clusterBaseMs as number);
    const block = this.simpleBlock(frame, rel);
    this.push(block);
    this.clusterBytes += block.length;
  }

  /** Finalize: an unknown-size Cluster needs no explicit close (EOF terminates it). Idempotent. */
  finish(): void {
    // Unknown-size Segment/Cluster are terminated by the next higher-level element or EOF — nothing to
    // backfill. We deliberately write no Cues (out of scope per §5). Left as a hook for a future deferred
    // Cues write if seekability is ever required.
  }

  /** Return + clear the buffered bytes ready to hand to `recorder.append`. */
  drain(): Uint8Array {
    const merged = concat(this.out);
    this.out = [];
    return merged;
  }

  /** Bytes currently buffered (not yet drained). */
  get pending(): number {
    let n = 0;
    for (const p of this.out) n += p.length;
    return n;
  }

  private openCluster(baseMs: number): void {
    // Cluster is opened UNKNOWN-SIZE so blocks can stream in without knowing the total length up front.
    const open = concat([Uint8Array.from(ID.Cluster), Uint8Array.from(UNKNOWN_SIZE)]);
    const timestamp = elem(ID.Timestamp, vintFreeUint(baseMs));
    this.push(open);
    this.push(timestamp);
    this.clusterBaseMs = baseMs;
    this.clusterBytes = open.length + timestamp.length;
  }

  /** Build a SimpleBlock: track-number VINT + signed int16 relative timestamp + flags + payload. */
  private simpleBlock(frame: EncodedFrame, relTs: number): Uint8Array {
    const trackNum = frame.kind === "video" ? TRACK_VIDEO : TRACK_AUDIO;
    const header = new Uint8Array(4);
    header.set(vint(trackNum), 0); // 1-octet track-number VINT for tracks 1/2
    // Signed int16 relative timestamp (big-endian).
    header[1] = (relTs >> 8) & 0xff;
    header[2] = relTs & 0xff;
    // Flags: keyframe bit (0x80) for video keyframes; audio frames are always "key" in practice.
    header[3] = frame.kind === "video" ? (frame.keyframe ? 0x80 : 0x00) : 0x80;
    return elem(ID.SimpleBlock, concat([header, frame.data]));
  }

  private push(bytes: Uint8Array): void {
    this.out.push(bytes);
  }
}

/** 4-byte big-endian unsigned (for fixed-width fields like TimestampScale). */
function u32be(value: number): Uint8Array {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, value, false);
  return out;
}

/** Minimal big-endian unsigned-int bytes for a Cluster Timestamp value (no VINT length marker). */
function vintFreeUint(value: number): Uint8Array {
  const bytes: number[] = [];
  let v = Math.max(0, Math.floor(value));
  do {
    bytes.unshift(v & 0xff);
    v = Math.floor(v / 256);
  } while (v > 0);
  return Uint8Array.from(bytes);
}
