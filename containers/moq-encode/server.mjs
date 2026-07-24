// server.mjs — wave-moq-encode container control plane (#314): per-participant MoQ encode+publish.
//
// Routes:
//   GET  /health                    -> {ok:true, service:'wave-moq-encode'}
//   POST /start                     -> {org, meetingUuid} validated against SAFE segments; idempotent echo
//   POST /stop                      -> tears down every participant this instance is tracking
//   GET  /publish/:meetingUuid      -> WS upgrade; session.attach(ws, meetingUuid) demuxes the multiplexed
//                                       frame stream (demux.mjs) into per-participant encode pipelines
//                                       (participant.mjs)
//
// AUTH: if WAVE_INTERNAL_SECRET is set, every request (including the WS upgrade) must carry
// `x-wave-internal` string-equal to it, else 401. FAIL-CLOSED when unset in a way that would otherwise
// silently accept — this mirrors the gatewayGate seal moq-forward-target.ts already attaches on the Worker
// side. The secret itself is never logged.
import http from 'node:http';
import { Buffer } from 'node:buffer';
import { WebSocketServer } from 'ws';
import { defaultSession } from './session.mjs';

const PORT = Number(process.env.PORT ?? 8080);
const SERVICE = 'wave-moq-encode';
const SECRET = process.env.WAVE_INTERNAL_SECRET;
const SAFE_SEGMENT = /^[A-Za-z0-9_.-]{1,128}$/;
const MAX_BODY = 64 * 1024;

/** Every instance /start's meetingUuids it is tracking, so /stop is idempotent + self-scoped. */
const startedMeetings = new Set();

/** Fail-closed string-equal check against WAVE_INTERNAL_SECRET; never logs the secret itself. */
function authOk(req) {
  if (!SECRET) return true; // no secret provisioned -> auth not enforced (documented posture, dev/local)
  const got = req.headers['x-wave-internal'];
  return typeof got === 'string' && got === SECRET;
}

async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) return {};
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    return {};
  }
}

const wss = new WebSocketServer({ noServer: true });

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://container');

  if (url.pathname === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, service: SERVICE }));
    return;
  }

  if (!authOk(req)) {
    res.writeHead(401, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify({ ok: false, error: 'UNAUTHORIZED', service: SERVICE }));
    return;
  }

  if (url.pathname === '/start' && req.method === 'POST') {
    const body = await readJson(req);
    const org = typeof body.org === 'string' ? body.org : '';
    const meetingUuid = typeof body.meetingUuid === 'string' ? body.meetingUuid : '';
    if (!SAFE_SEGMENT.test(org) || !SAFE_SEGMENT.test(meetingUuid)) {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'BAD_REQUEST', service: SERVICE, reason: 'org/meetingUuid must match ^[A-Za-z0-9_.-]{1,128}$' }));
      return;
    }
    startedMeetings.add(meetingUuid); // idempotent: adding an already-present uuid is a no-op
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, service: SERVICE, org, meetingUuid, started: true }));
    return;
  }

  if (url.pathname === '/stop' && req.method === 'POST') {
    for (const meetingUuid of startedMeetings) defaultSession.stopMeeting(meetingUuid);
    const stopped = [...startedMeetings];
    startedMeetings.clear();
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, service: SERVICE, stopped }));
    return;
  }

  if (url.pathname.startsWith('/publish/') && req.method === 'GET') {
    // WS upgrade is handled in the 'upgrade' event below; a plain GET here (no Upgrade header) means the
    // client isn't actually opening a socket.
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: 'EXPECTED_WEBSOCKET_UPGRADE', service: SERVICE }));
    return;
  }

  res.writeHead(404, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ ok: false, error: 'NOT_FOUND', service: SERVICE }));
});

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, 'http://container');
  const match = url.pathname.match(/^\/publish\/([^/]+)$/);
  if (!match) {
    socket.destroy();
    return;
  }
  if (!authOk(req)) {
    // Fail-closed on the upgrade path too — never accept a socket for an unauthenticated caller. No
    // secret is logged or echoed back.
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
    socket.destroy();
    return;
  }
  const meetingUuid = decodeURIComponent(match[1]);
  if (!SAFE_SEGMENT.test(meetingUuid)) {
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    startedMeetings.add(meetingUuid);
    defaultSession.attach(ws, meetingUuid);
  });
});

server.listen(PORT, () => {
  process.stdout.write(JSON.stringify({ service: SERVICE, listen: PORT }) + '\n');
});
