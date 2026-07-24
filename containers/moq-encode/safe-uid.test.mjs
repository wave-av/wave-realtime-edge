// safe-uid.test.mjs — SAFE_UID (demux.mjs) accept/reject coverage.
import test from 'node:test';
import assert from 'node:assert/strict';
import { SAFE_UID } from './demux.mjs';

test('rejects a leading-hyphen id (looks like a CLI flag)', () => {
  assert.equal(SAFE_UID.test('-x'), false);
});

test('rejects a uid containing a path separator', () => {
  assert.equal(SAFE_UID.test('a/b'), false);
});

test('rejects a 129-char id (over the 128 ceiling)', () => {
  assert.equal(SAFE_UID.test('a'.repeat(129)), false);
});

test('rejects the empty string', () => {
  assert.equal(SAFE_UID.test(''), false);
});

test('accepts normal ids', () => {
  assert.ok(SAFE_UID.test('user-123'));
  assert.ok(SAFE_UID.test('u'));
  assert.ok(SAFE_UID.test('user_1.2-3'));
  assert.ok(SAFE_UID.test('a'.repeat(128))); // exactly at the ceiling
});
