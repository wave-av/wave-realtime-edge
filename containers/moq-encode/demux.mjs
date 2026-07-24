// demux.mjs — pure decode of the Worker→container multiplexed MoQ-forward frame (#314, #319).
//
// WIRE CONTRACT (frozen by merged PR #319 — wave-realtime-edge src/encoders/moq-forward-target.ts,
// `encodeMoqFrame`): ONE complete WS binary message per frame (WS message boundary = frame boundary;
// no extra outer length wrapper at THIS layer):
//   [kindByte:u8 (0=audio,1=video)][uidLen:u8][uid UTF-8, <=255 bytes][ts:u32BE][payloadLen:u32BE][payload]
//
// This module is pure (no I/O) and NEVER throws: any malformed/truncated/over-length buffer decodes to
// `null` rather than raising, so a single bad frame from a socket can never crash the session loop
// (validate-untrusted-input-before-sink — every byte on this wire is untrusted Worker/RTMS input).
import { Buffer } from 'node:buffer';

/** Gates the per-frame `uid` before it is ever used to name a spawned process or a strand track. Same
 *  character set as the Worker's SAFE_MOQ_SEGMENT (moq-forward-target.ts) — alnum/underscore/dot/hyphen,
 *  1-128 chars — PLUS one extra restriction this module adds: the FIRST character must be alnum or `_`
 *  (never a leading `-` or `.`). That closes an argv-injection edge the plain SAFE_MOQ_SEGMENT class
 *  leaves open (a uid of `-x` would otherwise be a syntactically valid segment that LOOKS like a CLI
 *  flag) even though this container never passes uid as a bare leading argv token (it is always used as
 *  `a-${uid}`/`v-${uid}`, and as a Map key) — defense in depth, not a currently-exploitable path. */
export const SAFE_UID = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/;

/**
 * Decode one multiplexed MoQ-forward frame. Returns `{kind, uid, ts, payload}` on success or `null` on
 * any malformed/truncated/over-length input. NEVER throws.
 *   kind: 'audio' | 'video'
 *   uid: string (UTF-8 decoded; NOT yet validated against SAFE_UID — callers must check separately)
 *   ts: number (uint32)
 *   payload: Buffer (a view into `buf`, not a copy)
 */
export function decodeMoqFrame(buf) {
  if (!Buffer.isBuffer(buf)) {
    if (buf instanceof Uint8Array) buf = Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength);
    else return null;
  }
  if (buf.length < 2) return null; // need at least kindByte + uidLen

  const kindByte = buf[0];
  if (kindByte !== 0 && kindByte !== 1) return null;
  const kind = kindByte === 1 ? 'video' : 'audio';

  const uidLen = buf[1];
  const headerFixedLen = 2 + uidLen + 4 + 4; // kindByte + uidLen + uid + ts + payloadLen
  if (buf.length < headerFixedLen) return null; // truncated before payloadLen is even readable

  const uidBytes = buf.subarray(2, 2 + uidLen);
  let uid;
  try {
    uid = uidBytes.toString('utf8');
  } catch {
    return null;
  }

  const tsOffset = 2 + uidLen;
  const ts = buf.readUInt32BE(tsOffset);

  const payloadLenOffset = tsOffset + 4;
  const payloadLen = buf.readUInt32BE(payloadLenOffset);

  const payloadOffset = payloadLenOffset + 4;
  if (payloadLen < 0 || payloadOffset + payloadLen > buf.length) return null; // over-length payloadLen

  const payload = buf.subarray(payloadOffset, payloadOffset + payloadLen);
  return { kind, uid, ts, payload };
}
