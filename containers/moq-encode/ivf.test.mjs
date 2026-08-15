// ivf.test.mjs — hand-built IVF header + frames -> correct VP8 frame boundaries, incl. split reads.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { makeIvfParser } from './ivf.mjs';

function buildFileHeader() {
  // Real content of the 32-byte IVF file header doesn't matter to the parser (it's skipped wholesale) —
  // fill with a recognizable pattern so a bug that reads INTO it is easy to spot.
  return Buffer.alloc(32, 0xaa);
}
function buildFrame(payload, pts) {
  const header = Buffer.alloc(12);
  header.writeUInt32LE(payload.length, 0);
  header.writeBigUInt64LE(BigInt(pts), 4);
  return Buffer.concat([header, Buffer.from(payload)]);
}

test('parses 3 frames delivered in one chunk', () => {
  const frames = [];
  const parser = makeIvfParser((payload, pts) => frames.push({ payload: Buffer.from(payload), pts }));
  const f1 = buildFrame([1, 2, 3], 0);
  const f2 = buildFrame([4, 5], 1);
  const f3 = buildFrame([6, 7, 8, 9], 2);
  parser(Buffer.concat([buildFileHeader(), f1, f2, f3]));

  assert.equal(frames.length, 3);
  assert.deepEqual([...frames[0].payload], [1, 2, 3]);
  assert.equal(frames[0].pts, 0n);
  assert.deepEqual([...frames[1].payload], [4, 5]);
  assert.equal(frames[1].pts, 1n);
  assert.deepEqual([...frames[2].payload], [6, 7, 8, 9]);
  assert.equal(frames[2].pts, 2n);
});

test('parses frames split across many small reads, including mid-header and mid-payload splits', () => {
  const frames = [];
  const parser = makeIvfParser((payload, pts) => frames.push({ payload: Buffer.from(payload), pts }));
  const whole = Buffer.concat([buildFileHeader(), buildFrame([1, 2, 3], 10), buildFrame([4, 5, 6, 7], 11)]);

  // Feed one byte at a time — the hardest possible split pattern (crosses the file header boundary, the
  // per-frame header boundary, and the payload boundary at every possible offset).
  for (let i = 0; i < whole.length; i++) {
    parser(whole.subarray(i, i + 1));
  }

  assert.equal(frames.length, 2);
  assert.deepEqual([...frames[0].payload], [1, 2, 3]);
  assert.equal(frames[0].pts, 10n);
  assert.deepEqual([...frames[1].payload], [4, 5, 6, 7]);
  assert.equal(frames[1].pts, 11n);
});

test('an empty-payload frame (size 0) still fires with an empty buffer', () => {
  const frames = [];
  const parser = makeIvfParser((payload) => frames.push(Buffer.from(payload)));
  parser(Buffer.concat([buildFileHeader(), buildFrame([], 0)]));
  assert.equal(frames.length, 1);
  assert.equal(frames[0].length, 0);
});
