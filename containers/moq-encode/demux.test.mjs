// demux.test.mjs — golden round-trip against the REAL encodeMoqFrame byte layout (PR #319, frozen).
//
// `encodeMoqFrameFixture` below reproduces the EXACT byte-write sequence of the real encoder
// (wave-realtime-edge/src/encoders/moq-forward-target.ts `encodeMoqFrame`, read from origin/main), so a
// pass here proves demux.mjs's decodeMoqFrame is a byte-exact inverse of the frozen wire contract, not
// just internally self-consistent.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { decodeMoqFrame, SAFE_UID } from './demux.mjs';

/** Byte-exact port of the real encodeMoqFrame (moq-forward-target.ts), for fixture generation only. */
function encodeMoqFrameFixture(uid, kind, ts, payload) {
  const uidBytes = Buffer.from(uid, 'utf8').subarray(0, 255);
  const header = Buffer.alloc(1 + 1 + uidBytes.length + 4 + 4);
  header[0] = kind === 'video' ? 1 : 0;
  header[1] = uidBytes.length;
  uidBytes.copy(header, 2);
  header.writeUInt32BE(Math.max(0, Math.floor(ts)) >>> 0, 2 + uidBytes.length);
  header.writeUInt32BE(payload.length >>> 0, 2 + uidBytes.length + 4);
  return Buffer.concat([header, Buffer.from(payload)]);
}

test('round-trips an audio frame', () => {
  const payload = Buffer.from([1, 2, 3, 4, 5]);
  const wire = encodeMoqFrameFixture('user-123', 'audio', 1234567, payload);
  const decoded = decodeMoqFrame(wire);
  assert.deepEqual(decoded, { kind: 'audio', uid: 'user-123', ts: 1234567, payload: decoded.payload });
  assert.deepEqual([...decoded.payload], [...payload]);
});

test('round-trips a video frame', () => {
  const payload = Buffer.from(Array.from({ length: 300 }, (_, i) => i & 0xff));
  const wire = encodeMoqFrameFixture('uid-v', 'video', 999, payload);
  const decoded = decodeMoqFrame(wire);
  assert.equal(decoded.kind, 'video');
  assert.equal(decoded.uid, 'uid-v');
  assert.equal(decoded.ts, 999);
  assert.deepEqual([...decoded.payload], [...payload]);
});

test('round-trips an empty payload', () => {
  const wire = encodeMoqFrameFixture('u', 'audio', 0, Buffer.alloc(0));
  const decoded = decodeMoqFrame(wire);
  assert.equal(decoded.payload.length, 0);
  assert.equal(decoded.ts, 0);
});

test('round-trips a max-length (255-byte) uid', () => {
  const uid = 'a'.repeat(255);
  const wire = encodeMoqFrameFixture(uid, 'video', 42, Buffer.from([9]));
  const decoded = decodeMoqFrame(wire);
  assert.equal(decoded.uid, uid);
  assert.equal(decoded.uid.length, 255);
});

test('negative ts clamps to 0 in the real encoder, and decode reflects that', () => {
  const wire = encodeMoqFrameFixture('u', 'audio', -5, Buffer.alloc(0));
  const decoded = decodeMoqFrame(wire);
  assert.equal(decoded.ts, 0);
});

test('truncated buffer (cut mid-header) decodes to null', () => {
  const wire = encodeMoqFrameFixture('user-123', 'audio', 1, Buffer.from([1, 2, 3]));
  const truncated = wire.subarray(0, 5); // cuts off before ts/payloadLen/payload are complete
  assert.equal(decodeMoqFrame(truncated), null);
});

test('truncated buffer (payload cut short) decodes to null', () => {
  const wire = encodeMoqFrameFixture('u', 'video', 1, Buffer.from([1, 2, 3, 4, 5]));
  const truncated = wire.subarray(0, wire.length - 2); // payloadLen says 5 bytes, only 3 present
  assert.equal(decodeMoqFrame(truncated), null);
});

test('over-length payloadLen decodes to null (never throws)', () => {
  const wire = encodeMoqFrameFixture('u', 'audio', 1, Buffer.from([1, 2]));
  const tampered = Buffer.from(wire);
  const payloadLenOffset = 2 + 1 + 4; // kindByte + uidLen + uid('u') + ts
  tampered.writeUInt32BE(0xffffffff, payloadLenOffset);
  assert.equal(decodeMoqFrame(tampered), null);
});

test('bad uidLen (claims more bytes than present) decodes to null', () => {
  const tampered = Buffer.from([0, 200, 1, 2, 3]); // kindByte=audio, uidLen=200, but only 3 bytes follow
  assert.equal(decodeMoqFrame(tampered), null);
});

test('empty buffer and single-byte buffer decode to null', () => {
  assert.equal(decodeMoqFrame(Buffer.alloc(0)), null);
  assert.equal(decodeMoqFrame(Buffer.from([0])), null);
});

test('invalid kindByte decodes to null', () => {
  const tampered = Buffer.from([2, 0, 0, 0, 0, 0, 0, 0, 0]); // kindByte=2 is neither 0 nor 1
  assert.equal(decodeMoqFrame(tampered), null);
});

test('non-Buffer/Uint8Array input decodes to null', () => {
  assert.equal(decodeMoqFrame('not a buffer'), null);
  assert.equal(decodeMoqFrame(null), null);
  assert.equal(decodeMoqFrame(undefined), null);
});

test('SAFE_UID smoke: accepts a normal id, rejects an unsafe one', () => {
  assert.ok(SAFE_UID.test('user-123'));
  assert.equal(SAFE_UID.test('a/b'), false);
  // Full SAFE_UID coverage lives in safe-uid.test.mjs.
});
