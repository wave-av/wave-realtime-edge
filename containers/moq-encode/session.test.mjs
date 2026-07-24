// session.test.mjs — drives attach() with a fake ws + a STUB spawnParticipant (dependency injection), so
// no real ffmpeg/moq-strand/relay is ever touched.
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Buffer } from 'node:buffer';
import { createSessionManager } from './session.mjs';

function encodeFrame(uid, kind, ts, payload) {
  const uidBytes = Buffer.from(uid, 'utf8');
  const header = Buffer.alloc(1 + 1 + uidBytes.length + 4 + 4);
  header[0] = kind === 'video' ? 1 : 0;
  header[1] = uidBytes.length;
  uidBytes.copy(header, 2);
  header.writeUInt32BE(ts >>> 0, 2 + uidBytes.length);
  header.writeUInt32BE(payload.length >>> 0, 2 + uidBytes.length + 4);
  return Buffer.concat([header, Buffer.from(payload)]);
}

/** A fake ws: just an EventEmitter with the on/emit surface session.mjs needs. */
function fakeWs() {
  return new EventEmitter();
}

function makeStubSpawner() {
  const spawned = []; // [{uid, ns}]
  const handles = new Map(); // uid -> handle
  const spawnParticipant = (uid, ns) => {
    spawned.push({ uid, ns });
    const handle = {
      audioWrites: 0,
      videoWrites: 0,
      touches: 0,
      stopped: false,
      writeAudio() { handle.audioWrites++; },
      writeVideo() { handle.videoWrites++; },
      touch() { handle.touches++; },
      async stop() { handle.stopped = true; },
    };
    handles.set(uid, handle);
    return handle;
  };
  return { spawnParticipant, spawned, handles };
}

test('a malformed (undecodable) message is dropped, no spawn happens', () => {
  const { spawnParticipant, spawned } = makeStubSpawner();
  const mgr = createSessionManager({ spawnParticipant, idleMs: 30000 });
  const ws = fakeWs();
  mgr.attach(ws, 'meeting-1');

  ws.emit('message', Buffer.from([9])); // too short to decode
  assert.equal(spawned.length, 0);
  mgr.dispose();
});

test('a frame with an unsafe uid is dropped, no spawn happens', () => {
  const { spawnParticipant, spawned } = makeStubSpawner();
  const mgr = createSessionManager({ spawnParticipant, idleMs: 30000 });
  const ws = fakeWs();
  mgr.attach(ws, 'meeting-1');

  ws.emit('message', encodeFrame('-x', 'audio', 1, Buffer.from([1])));
  assert.equal(spawned.length, 0);
  mgr.dispose();
});

test('a valid frame spawns exactly once per uid, and repeats reuse the same handle', () => {
  const { spawnParticipant, spawned, handles } = makeStubSpawner();
  const mgr = createSessionManager({ spawnParticipant, idleMs: 30000, org: 'wave' });
  const ws = fakeWs();
  mgr.attach(ws, 'meeting-1');

  ws.emit('message', encodeFrame('user-1', 'audio', 1, Buffer.from([1, 2])));
  ws.emit('message', encodeFrame('user-1', 'video', 2, Buffer.from([3, 4])));
  ws.emit('message', encodeFrame('user-1', 'audio', 3, Buffer.from([5])));

  assert.equal(spawned.length, 1); // spawned once, not once per frame
  assert.equal(spawned[0].uid, 'user-1');
  assert.equal(spawned[0].ns, 'wave:meeting-1'); // ${org}:${meetingUuid}

  const handle = handles.get('user-1');
  assert.equal(handle.audioWrites, 2);
  assert.equal(handle.videoWrites, 1);
  assert.equal(handle.touches, 3);
  mgr.dispose();
});

test('ws close tears down every participant for that meeting', async () => {
  const { spawnParticipant, handles } = makeStubSpawner();
  const mgr = createSessionManager({ spawnParticipant, idleMs: 30000 });
  const ws = fakeWs();
  mgr.attach(ws, 'meeting-2');

  ws.emit('message', encodeFrame('user-a', 'audio', 1, Buffer.from([1])));
  ws.emit('message', encodeFrame('user-b', 'audio', 1, Buffer.from([1])));
  ws.emit('close');

  // stop() is async (fire-and-forget .catch chain inside stopAll); give the microtask queue a turn.
  await new Promise((r) => setImmediate(r));

  assert.equal(handles.get('user-a').stopped, true);
  assert.equal(handles.get('user-b').stopped, true);
  mgr.dispose();
});

test('idle reap stops a participant that has gone quiet past idleMs', async () => {
  const { spawnParticipant, handles } = makeStubSpawner();
  const mgr = createSessionManager({ spawnParticipant, idleMs: 10 }); // tiny idle window for the test
  const ws = fakeWs();
  mgr.attach(ws, 'meeting-3');

  ws.emit('message', encodeFrame('user-idle', 'audio', 1, Buffer.from([1])));
  assert.equal(handles.get('user-idle').stopped, false);

  await new Promise((r) => setTimeout(r, 20));
  mgr._reapIdle(); // invoke the sweep directly rather than waiting on the real interval timing
  await new Promise((r) => setImmediate(r));

  assert.equal(handles.get('user-idle').stopped, true);
  mgr.dispose();
});
