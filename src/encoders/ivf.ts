/// <reference types="@cloudflare/workers-types" />
/**
 * RT-R10 (#72) — IVF → raw-VP8 reframing (UNKNOWN U4).
 *
 * The rt-encoder container transcodes JPEG → VP8 with `ffmpeg ... -c:v libvpx -f ivf -` (see
 * containers/rt-encoder/server/index.mjs FFMPEG_ARGS.jpeg), so a single `/encode` POST returns the VP8 frame(s)
 * wrapped in an **IVF** container, NOT raw VP8. The WebM muxer (src/muxer/webm.ts) writes one video SimpleBlock
 * per RAW VP8 frame and needs the keyframe flag, so the glue MUST strip the IVF framing → emit each raw VP8
 * frame + its keyframe bit before handing it to the muxer.
 *
 * IVF wire format (little-endian throughout):
 *   File header (32 bytes):
 *     0  u32  signature "DKIF"
 *     4  u16  version (0)
 *     6  u16  header length (32)
 *     8  u32  FourCC ("VP80")
 *     12 u16  width
 *     14 u16  height
 *     16 u32  time base denominator (rate)
 *     20 u32  time base numerator (scale)
 *     24 u32  frame count
 *     28 u32  unused
 *   Per-frame:
 *     0  u32  frame size (bytes of the VP8 payload that follows)
 *     4  u64  timestamp (presentation, in time-base units)
 *     12 ...  VP8 payload (`frameSize` bytes)
 *
 * VP8 keyframe detection (RFC 6386 §9.1): the FIRST byte of the VP8 uncompressed data chunk packs
 *   bit0 = frame type (0 = KEY frame, 1 = inter frame); bits1-3 = version; bit4 = show_frame.
 * So `(payload[0] & 1) === 0` ⇒ keyframe. (A keyframe additionally carries the 0x9d 0x01 0x2a start code at
 * bytes 3-5, but bit0 of byte0 is the canonical, sufficient signal and is what we key the SimpleBlock flag on.)
 *
 * PURE + standalone-testable: no I/O, no env, no muxer coupling, NEVER imports `@wave-av/content-hash`
 * (SKIP invariant — this file is on the recording write-path and is transitively bundle-guarded via container.ts).
 */

/** One raw VP8 frame extracted from an IVF stream, ready to become a video SimpleBlock. */
export interface Vp8Frame {
  /** The raw VP8 frame payload (no IVF framing). */
  data: Uint8Array;
  /** True when this is a VP8 keyframe (sets the SimpleBlock keyframe flag + forces a Cluster boundary). */
  keyframe: boolean;
  /** The IVF per-frame timestamp (time-base units). Informational; the tap uses its own session-relative ms. */
  timestamp: number;
}

const IVF_FILE_HEADER = 32;
const IVF_FRAME_HEADER = 12;
const DKIF = 0x44 | (0x4b << 8) | (0x49 << 16) | (0x46 << 24); // "DKIF" little-endian as a u32

/** Read a little-endian u32 at `pos` (caller guarantees `pos + 4 <= buf.length`). */
function u32le(buf: Uint8Array, pos: number): number {
  return (buf[pos] | (buf[pos + 1] << 8) | (buf[pos + 2] << 16) | (buf[pos + 3] << 24)) >>> 0;
}

/** Read a little-endian u64 at `pos` as a JS number (timestamps fit; uses multiplication, never <<, to avoid 32-bit overflow). */
function u64le(buf: Uint8Array, pos: number): number {
  let v = 0;
  let mul = 1;
  for (let i = 0; i < 8; i++) {
    v += buf[pos + i] * mul;
    mul *= 256;
  }
  return v;
}

/** True when `payload` is a VP8 KEY frame (RFC 6386 §9.1 — bit0 of the first byte, 0 = key). */
export function isVp8Keyframe(payload: Uint8Array): boolean {
  if (payload.length === 0) return false;
  return (payload[0] & 0x01) === 0;
}

/**
 * RT-R10 (#78) — extract the REAL frame geometry from a VP8 KEYFRAME header (RFC 6386 §9.1).
 *
 * Why: the WebM muxer declares PixelWidth/PixelHeight in its Tracks header, but it only learns the true
 * dimensions from the VP8 bitstream — VP8 is self-describing, so the declared dims (placeholder 1280×720)
 * were wrong on the proven recording (320×240 source ⇒ Tracks said 1280×720). The video glue reads the dims
 * from the first keyframe and threads them into the muxer before the header is written.
 *
 * VP8 keyframe layout (little-endian 16-bit fields, each with a 2-bit upscale factor in the HIGH bits so
 * mask &0x3fff to get the raw pixel dimension):
 *   bytes 0-2  uncompressed data chunk tag (frame type / version / show_frame / first-partition size)
 *   bytes 3-5  the keyframe start code  0x9d 0x01 0x2a
 *   bytes 6-7  u16 LE width  (low 14 bits = width,  high 2 bits = horizontal scale)
 *   bytes 8-9  u16 LE height (low 14 bits = height, high 2 bits = vertical scale)
 *
 * PURE + fail-soft: returns null (never throws) when the payload is not a VP8 keyframe, is too short, lacks
 * the 0x9d 0x01 0x2a start code, or decodes a 0 dimension. A null result ⇒ the caller keeps the muxer defaults.
 */
export function vp8KeyframeDimensions(payload: Uint8Array): { width: number; height: number } | null {
  // Need bytes 0..9 and a keyframe (bit0 of byte0 === 0).
  if (payload.length < 10) return null;
  if (!isVp8Keyframe(payload)) return null;
  // The 3-byte start code MUST be present at bytes 3-5 for a keyframe; absent ⇒ not a parseable keyframe header.
  if (payload[3] !== 0x9d || payload[4] !== 0x01 || payload[5] !== 0x2a) return null;
  const width = (payload[6] | (payload[7] << 8)) & 0x3fff; // low 14 bits (high 2 bits = horizontal scale)
  const height = (payload[8] | (payload[9] << 8)) & 0x3fff; // low 14 bits (high 2 bits = vertical scale)
  if (width === 0 || height === 0) return null; // a 0 dimension is never valid — keep the muxer defaults
  return { width, height };
}

/**
 * Parse an IVF buffer (DKIF file header + N frames) → the list of RAW VP8 frames with keyframe flags.
 *
 * Tolerant + fail-soft (the bytes come from a best-effort transcode, never trusted blindly):
 *   • Not an IVF buffer (missing/short DKIF header or wrong signature) → returns []  (the caller drops the frame).
 *   • A truncated trailing frame (declared size runs past the buffer) → the frames parsed so far are returned;
 *     the partial tail is discarded (never throws, never reads out of bounds).
 *   • A zero-length frame is skipped (no empty SimpleBlock).
 * NEVER throws — a parse failure degrades to fewer/zero frames (fail-open, media-safety > recording).
 */
export function parseIvf(buf: Uint8Array): Vp8Frame[] {
  if (buf.length < IVF_FILE_HEADER) return [];
  if (u32le(buf, 0) !== DKIF) return [];
  const headerLen = buf[6] | (buf[7] << 8); // u16 LE header length (normally 32)
  let pos = headerLen >= IVF_FILE_HEADER ? headerLen : IVF_FILE_HEADER;
  const frames: Vp8Frame[] = [];
  while (pos + IVF_FRAME_HEADER <= buf.length) {
    const size = u32le(buf, pos);
    const timestamp = u64le(buf, pos + 4);
    const dataStart = pos + IVF_FRAME_HEADER;
    const dataEnd = dataStart + size;
    if (size === 0) {
      pos = dataEnd; // skip a 0-length frame (no empty block)
      continue;
    }
    if (dataEnd > buf.length) break; // truncated trailing frame — stop, keep what we have
    const data = buf.slice(dataStart, dataEnd); // copy out (own ArrayBuffer) → safe to retain past `buf`
    frames.push({ data, keyframe: isVp8Keyframe(data), timestamp });
    pos = dataEnd;
  }
  return frames;
}
