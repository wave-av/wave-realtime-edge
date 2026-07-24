// rtp.test.mjs — stripRtpHeader on a 12-byte-header sample -> correct Opus payload; short buffer guard.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { stripRtpHeader } from './rtp.mjs';

test('strips a 12-byte RTP header and returns the Opus payload', () => {
  // A plausible-looking RTP header: V=2,P=0,X=0,CC=0 | M=0,PT=111 | seq | timestamp | ssrc
  const header = Buffer.from([0x80, 0x6f, 0x00, 0x01, 0x00, 0x00, 0x00, 0x02, 0x00, 0x00, 0x00, 0x03]);
  const opus = Buffer.from([0xde, 0xad, 0xbe, 0xef]);
  const packet = Buffer.concat([header, opus]);
  const payload = stripRtpHeader(packet);
  assert.deepEqual([...payload], [...opus]);
});

test('an exactly-12-byte datagram (header only, no payload) yields an empty buffer', () => {
  const header = Buffer.alloc(12, 1);
  const payload = stripRtpHeader(header);
  assert.equal(payload.length, 0);
});

test('a short buffer (< 12 bytes) returns null', () => {
  assert.equal(stripRtpHeader(Buffer.alloc(11)), null);
  assert.equal(stripRtpHeader(Buffer.alloc(0)), null);
});

test('undefined/null input returns null (never throws)', () => {
  assert.equal(stripRtpHeader(undefined), null);
  assert.equal(stripRtpHeader(null), null);
});
