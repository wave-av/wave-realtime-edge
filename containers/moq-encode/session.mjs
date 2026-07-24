// session.mjs — per-meeting participant registry + idle sweep (#314 moq-encode container).
//
// One WebSocket per meeting (opened by GET /publish/:meetingUuid in server.mjs) carries EVERY
// participant's multiplexed audio/video frames (the wire contract PR #319 froze — see demux.mjs). This
// module demultiplexes that single socket into per-uid encode+publish pipelines (participant.mjs),
// dropping anything malformed or carrying an unsafe uid BEFORE it ever reaches spawn — decodeMoqFrame
// never throws, and SAFE_UID is checked here as the second gate.
//
// `createSessionManager({ spawnParticipant, log, idleMs, org })` takes its participant-spawner as a
// constructor param so tests can inject a stub (no real ffmpeg/moq-strand needed) instead of monkeypatching
// module internals; server.mjs uses the exported default instance, built with the real spawnParticipant.
import { decodeMoqFrame, SAFE_UID } from './demux.mjs';
import { spawnParticipant as defaultSpawnParticipant } from './participant.mjs';

/** How long a participant may go without a frame before its pipelines are torn down. */
export const PARTICIPANT_IDLE_MS = Number(process.env.PARTICIPANT_IDLE_MS ?? 30000);

// GAP (documented, not fixed here): the multiplexed wire frame (demux.mjs) carries no `org` field — only
// uid/kind/ts/payload (PR #319's frozen layout). /start supplies org for the control-plane, but the
// per-frame data path has no way to attribute a frame to an org today. Until the wire contract grows an
// org field (or the container is bound 1:1 to a single org via env), every meeting namespaces under
// WAVE_ORG (default 'default') regardless of which org's /start called it. See README.md.
const DEFAULT_ORG = process.env.WAVE_ORG ?? 'default';

/**
 * Build an isolated session manager. Returns `{attach(ws, meetingUuid), stopMeeting(meetingUuid),
 * dispose()}`.
 */
export function createSessionManager({
  spawnParticipant = defaultSpawnParticipant,
  log = () => {},
  idleMs = PARTICIPANT_IDLE_MS,
  org = DEFAULT_ORG,
} = {}) {
  /** meetingUuid -> Map<uid, {handle, lastActive}> */
  const meetings = new Map();

  function reapIdle() {
    const now = Date.now();
    for (const participants of meetings.values()) {
      for (const [uid, entry] of participants) {
        if (now - entry.lastActive > idleMs) {
          participants.delete(uid);
          entry.handle.stop().catch((e) => log(`idle-reap stop failed uid=${uid}: ${e?.message ?? e}`));
        }
      }
    }
  }
  const sweeper = setInterval(reapIdle, Math.max(1000, Math.min(idleMs, 5000)));
  sweeper.unref?.();

  function getOrSpawn(meetingUuid, uid) {
    let participants = meetings.get(meetingUuid);
    if (!participants) {
      participants = new Map();
      meetings.set(meetingUuid, participants);
    }
    let entry = participants.get(uid);
    if (!entry) {
      const ns = `${org}:${meetingUuid}`;
      entry = { handle: spawnParticipant(uid, ns, log), lastActive: Date.now() };
      participants.set(uid, entry);
    }
    return entry;
  }

  /** Attach a live/fake WebSocket-like object (must emit 'message'/'close'/'error') to `meetingUuid`. */
  function attach(ws, meetingUuid) {
    ws.on('message', (buf) => {
      const frame = decodeMoqFrame(buf);
      if (!frame) return; // malformed/truncated/over-length — dropped, decodeMoqFrame never throws
      if (!SAFE_UID.test(frame.uid)) return; // unsafe uid — dropped BEFORE it can name a process/track
      const entry = getOrSpawn(meetingUuid, frame.uid);
      entry.lastActive = Date.now();
      entry.handle.touch();
      if (frame.kind === 'video') entry.handle.writeVideo(frame.payload);
      else entry.handle.writeAudio(frame.payload);
    });

    const stopAll = () => {
      const participants = meetings.get(meetingUuid);
      if (!participants) return;
      meetings.delete(meetingUuid);
      for (const entry of participants.values()) {
        entry.handle.stop().catch((e) => log(`stop failed uid-stop meetingUuid=${meetingUuid}: ${e?.message ?? e}`));
      }
    };
    ws.on('close', stopAll);
    ws.on('error', stopAll);
  }

  /** Tear down every participant for one meeting (used by POST /stop). */
  function stopMeeting(meetingUuid) {
    const participants = meetings.get(meetingUuid);
    if (!participants) return;
    meetings.delete(meetingUuid);
    for (const entry of participants.values()) {
      entry.handle.stop().catch(() => {});
    }
  }

  function dispose() {
    clearInterval(sweeper);
    for (const meetingUuid of [...meetings.keys()]) stopMeeting(meetingUuid);
  }

  return { attach, stopMeeting, dispose, _meetings: meetings, _reapIdle: reapIdle };
}

/** The default, real (non-test) session manager instance used by server.mjs. */
export const defaultSession = createSessionManager();
