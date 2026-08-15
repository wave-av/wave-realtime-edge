// ivf.mjs — streaming IVF parser for ffmpeg's `-f ivf pipe:1` VP8 output (#314).
//
// IVF layout: a 32-byte file header ONCE, then per-frame:
//   [frameSize:u32LE][pts:u64LE][payload:frameSize bytes]
// This module accumulates chunks (the accumulate-buffer pattern moq-strand.mjs's makeFramer uses, but
// little-endian with a 12-byte per-frame header instead of moq-strand's 4-byte length prefix) and yields
// one raw VP8 frame per complete record. A frame split across reads still parses correctly because
// partial data is held in the accumulator until a full record is available.
import { Buffer } from 'node:buffer';

const FILE_HEADER_LEN = 32;
const FRAME_HEADER_LEN = 12; // u32LE size + u64LE pts

/**
 * Create a streaming IVF frame parser. `onFrame(payload, pts)` is called once per complete VP8 frame
 * (payload is a Buffer view into the internal accumulator — copy if you need to retain it past the
 * synchronous call). Returns a `push(chunk)` function to feed raw stdout bytes into.
 */
export function makeIvfParser(onFrame) {
  let acc = Buffer.alloc(0);
  let sawFileHeader = false;

  return function push(chunk) {
    acc = acc.length ? Buffer.concat([acc, chunk]) : Buffer.from(chunk);

    if (!sawFileHeader) {
      if (acc.length < FILE_HEADER_LEN) return; // wait for the rest of the file header
      acc = acc.subarray(FILE_HEADER_LEN);
      sawFileHeader = true;
    }

    for (;;) {
      if (acc.length < FRAME_HEADER_LEN) return;
      const frameSize = acc.readUInt32LE(0);
      const pts = acc.readBigUInt64LE(4);
      const total = FRAME_HEADER_LEN + frameSize;
      if (acc.length < total) return; // wait for the rest of this frame
      const payload = acc.subarray(FRAME_HEADER_LEN, total);
      onFrame(payload, pts);
      acc = acc.subarray(total);
    }
  };
}
