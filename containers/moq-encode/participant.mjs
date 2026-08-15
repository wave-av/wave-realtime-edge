// participant.mjs — per-participant encode+publish pipelines (#314 Slice: moq-encode container).
//
// One participant (uid) gets up to two independent pipelines, spawned LAZILY on first write of that kind:
//   AUDIO: raw PCM (s16le/48k/stereo) -> ffmpeg (libopus) -> RTP loopback -> rtp.mjs strips the RTP
//          header -> each Opus packet framed [u32BE len][body] onto `node moq-strand.mjs pub <ns> a-<uid>`.
//   VIDEO: raw MJPEG -> ffmpeg (libvpx, VP8) -> IVF on stdout -> ivf.mjs parses frame boundaries -> each
//          VP8 frame framed [u32BE len][body] onto `node moq-strand.mjs pub <ns> v-<uid>`.
// The `[u32BE len][body]` framing on the strand's stdin is moq-strand.mjs's OWN input contract (its
// `makeFramer`/`runPublisher` read exactly this shape and wrap each body as one MoQ object) — see the
// vendored moq-strand.mjs in this directory.
//
// Reuses the waitReady (watch stderr for MOQ_STRAND_READY) / tail (last 6 stderr lines) / drain-then-kill
// teardown idioms proven in containers/moq/server.mjs.
import { spawn } from 'node:child_process';
import { Buffer } from 'node:buffer';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { makeIvfParser } from './ivf.mjs';
import { listenRtp } from './rtp.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const STRAND = join(HERE, 'moq-strand.mjs');

const waitReady = (proc, name, ms = 15000) =>
  new Promise((res, rej) => {
    let buf = '';
    const to = setTimeout(() => rej(new Error(`${name} never ready`)), ms);
    proc.stderr.on('data', (d) => {
      buf += d;
      if (buf.includes('MOQ_STRAND_READY')) {
        clearTimeout(to);
        res();
      }
    });
    proc.on('exit', (code) => rej(new Error(`${name} exited early (code ${code})`)));
  });
const tail = (s) => s.trim().split('\n').slice(-6).join(' | ') || '(no stderr)';

/** Frame one body onto a moq-strand pub child's stdin: [u32BE len][body] (moq-strand's own stdin contract). */
function writeFramed(strandProc, body) {
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(body.buffer ?? body, body.byteOffset ?? 0, body.byteLength ?? body.length);
  const out = Buffer.allocUnsafe(4 + buf.length);
  out.writeUInt32BE(buf.length, 0);
  buf.copy(out, 4);
  try {
    strandProc.stdin.write(out);
  } catch {
    /* pipe closing at teardown — best-effort, drop */
  }
}

// Loopback RTP ports for the audio pipeline's ffmpeg->rtp.mjs hop. Simple round-robin over a private
// ephemeral-ish range; collisions across truly-concurrent spawns in the same window are astronomically
// unlikely for this container's expected participant counts, and a bind failure surfaces via ffmpeg's
// stderr tail rather than corrupting another participant's stream.
const RTP_PORT_BASE = 15000;
const RTP_PORT_SPAN = 10000;
let rtpPortCursor = 0;
function allocRtpPort() {
  const port = RTP_PORT_BASE + (rtpPortCursor % RTP_PORT_SPAN);
  rtpPortCursor++;
  return port;
}

async function spawnAudioPipeline(uid, ns, log) {
  const track = `a-${uid}`;
  const port = allocRtpPort();

  const pub = spawn('node', [STRAND, 'pub', ns, track], { stdio: ['pipe', 'ignore', 'pipe'] });
  let pubErr = '';
  pub.stderr.on('data', (d) => {
    pubErr += d;
    if (pubErr.length > 8192) pubErr = pubErr.slice(-8192);
  });
  try {
    await waitReady(pub, `pub:${track}`);
  } catch (e) {
    throw new Error(`${e?.message ?? e} :: strand stderr: ${tail(pubErr)}`);
  }

  const rtpSock = listenRtp(port, (opusPacket) => writeFramed(pub, opusPacket));

  const ff = spawn(
    'ffmpeg',
    [
      '-f', 's16le', '-ar', '48000', '-ac', '2', '-i', 'pipe:0',
      '-c:a', 'libopus', '-b:a', '64k', '-application', 'audio', '-frame_duration', '20',
      '-f', 'rtp', `rtp://127.0.0.1:${port}`,
    ],
    { stdio: ['pipe', 'ignore', 'pipe'] }
  );
  let ffErr = '';
  ff.stderr.on('data', (d) => {
    ffErr += d;
    if (ffErr.length > 8192) ffErr = ffErr.slice(-8192);
  });
  ff.on('error', (e) => log(`audio ffmpeg spawn error uid=${uid}: ${e?.message ?? e}`));

  return {
    write(payload) {
      try {
        ff.stdin.write(payload);
      } catch {
        /* pipe closing */
      }
    },
    async stop() {
      try {
        ff.stdin.end();
      } catch {
        /* already gone */
      }
      await new Promise((r) => setTimeout(r, 300));
      try {
        ff.kill();
      } catch {
        /* already dead */
      }
      try {
        rtpSock.close();
      } catch {
        /* already closed */
      }
      try {
        pub.stdin.end();
      } catch {
        /* already gone */
      }
      await new Promise((r) => setTimeout(r, 200));
      try {
        pub.kill();
      } catch {
        /* already dead */
      }
    },
    tail: () => tail(ffErr || pubErr),
  };
}

async function spawnVideoPipeline(uid, ns, log) {
  const track = `v-${uid}`;

  const pub = spawn('node', [STRAND, 'pub', ns, track], { stdio: ['pipe', 'ignore', 'pipe'] });
  let pubErr = '';
  pub.stderr.on('data', (d) => {
    pubErr += d;
    if (pubErr.length > 8192) pubErr = pubErr.slice(-8192);
  });
  try {
    await waitReady(pub, `pub:${track}`);
  } catch (e) {
    throw new Error(`${e?.message ?? e} :: strand stderr: ${tail(pubErr)}`);
  }

  const ff = spawn(
    'ffmpeg',
    [
      '-f', 'mjpeg', '-use_wallclock_as_timestamps', '1', '-i', 'pipe:0',
      '-c:v', 'libvpx', '-deadline', 'realtime', '-cpu-used', '8', '-g', '30', '-b:v', '1M',
      '-f', 'ivf', 'pipe:1',
    ],
    { stdio: ['pipe', 'pipe', 'pipe'] }
  );
  let ffErr = '';
  ff.stderr.on('data', (d) => {
    ffErr += d;
    if (ffErr.length > 8192) ffErr = ffErr.slice(-8192);
  });
  ff.on('error', (e) => log(`video ffmpeg spawn error uid=${uid}: ${e?.message ?? e}`));

  const pushIvf = makeIvfParser((vp8Frame) => writeFramed(pub, vp8Frame));
  ff.stdout.on('data', pushIvf);

  return {
    write(payload) {
      try {
        ff.stdin.write(payload);
      } catch {
        /* pipe closing */
      }
    },
    async stop() {
      try {
        ff.stdin.end();
      } catch {
        /* already gone */
      }
      await new Promise((r) => setTimeout(r, 300));
      try {
        ff.kill();
      } catch {
        /* already dead */
      }
      try {
        pub.stdin.end();
      } catch {
        /* already gone */
      }
      await new Promise((r) => setTimeout(r, 200));
      try {
        pub.kill();
      } catch {
        /* already dead */
      }
    },
    tail: () => tail(ffErr || pubErr),
  };
}

/**
 * Spawn (lazily, per-kind) the encode+publish pipelines for one participant `uid` in namespace `ns`.
 * Nothing is spawned until the first `writeAudio`/`writeVideo` call for that kind arrives. Returns
 * `{writeAudio, writeVideo, touch, stop}`.
 */
export function spawnParticipant(uid, ns, log) {
  let audio = null;
  let audioPromise = null;
  let video = null;
  let videoPromise = null;

  function getAudio() {
    if (audio) return Promise.resolve(audio);
    if (!audioPromise) {
      audioPromise = spawnAudioPipeline(uid, ns, log)
        .then((h) => {
          audio = h;
          return h;
        })
        .catch((e) => {
          audioPromise = null; // allow a later retry rather than wedging permanently
          throw e;
        });
    }
    return audioPromise;
  }
  function getVideo() {
    if (video) return Promise.resolve(video);
    if (!videoPromise) {
      videoPromise = spawnVideoPipeline(uid, ns, log)
        .then((h) => {
          video = h;
          return h;
        })
        .catch((e) => {
          videoPromise = null;
          throw e;
        });
    }
    return videoPromise;
  }

  return {
    writeAudio(payload) {
      getAudio()
        .then((h) => h.write(payload))
        .catch((e) => log(`audio pipeline failed uid=${uid}: ${e?.message ?? e}`));
    },
    writeVideo(payload) {
      getVideo()
        .then((h) => h.write(payload))
        .catch((e) => log(`video pipeline failed uid=${uid}: ${e?.message ?? e}`));
    },
    touch() {
      /* no-op placeholder: session.mjs owns the idle-timestamp map, this exists so callers can treat
       * every participant handle uniformly even before either pipeline has spawned. */
    },
    async stop() {
      const tasks = [];
      if (audio) tasks.push(audio.stop());
      if (video) tasks.push(video.stop());
      await Promise.allSettled(tasks);
    },
  };
}
