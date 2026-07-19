/**
 * #35 / #211 — LL-HLS source leg for the stream-bridge republisher.
 *
 * WHY THIS EXISTS (decisive root cause, proven 2026-07-18, #211): CF Stream Live's `/webRTC/play` (WHEP egress)
 * serves ONLY WebRTC-ingested (WHIP) inputs — it returns HTTP 409 `Live broadcast not started yet` forever for an
 * RTMP/SRT-ingested input, even when the broadcast is fully `live-inprogress` and HLS/LL-HLS serve 200. So the old
 * WHEP-pull source leg was architecturally incompatible with the RTMP/SRT feeds customers actually push. The feed IS
 * live and playable — just via LL-HLS, not WebRTC-play. This module pulls the source over LL-HLS instead.
 *
 * SHAPE: a drop-in replacement for `@wave-av/whip-publish`'s `pull()` as consumed by `runRelay` — same contract
 * `hlsPull({ srcUrl, auth?, onTrack, onState, pcFactory? }) -> Promise<{ stop }>`, calling `onTrack(track)` for each
 * produced track and `onState('connected'|'failed')`. `runRelay` is source-agnostic (it only knows the pull contract),
 * so ONLY this leg + `index.mjs`'s wiring change; the WHIP-out `publish()` leg stays verbatim.
 *
 * HOW: `ffmpeg -re -i <llhls manifest>` demuxes+decodes the HLS ladder and RE-ENCODES to VP8 (video) + Opus (audio) —
 * the CF WebRTC accept set is {VP9, VP8, H264-CBP-L3.1} + Opus, and VP8/Opus is the safe intersection werift can carry.
 * ffmpeg muxes each to RTP over a localhost UDP port; a `dgram` socket per track deserializes each datagram to a werift
 * `RtpPacket` and `writeRtp()`s it onto a synthetic sendonly `MediaStreamTrack`. Those tracks are handed to `runRelay`
 * → `publish({ source: { tracks } })` → `pc.addTrack()` (relay source mode, verbatim — no second transcode).
 *
 * ◆-LIVE-PROOF SCOPE (honest, mirrors relay.mjs §7.6): the RTP FIDELITY across the seam — whether werift re-stamps
 * PT/SSRC/sequence so ffmpeg's VP8/Opus payload is accepted by the gateway's negotiated OUTBOUND codec — is a live-media
 * property provable only with real media through a real werift→gateway WHIP path (the dogfood: real RTMPS push →
 * LL-HLS → this leg → a live SFU track id). Unit tests prove the ORCHESTRATION (ffmpeg spawn args, socket wiring, track
 * production, state transitions, teardown) with injected spawn + socket + werift primitives and NO real ffmpeg/UDP.
 *
 * WERIFT-FREE CORE (mirrors relay.mjs): this module holds NO `werift` import. The two werift primitives it needs — a
 * track factory and an RTP parser — are INJECTED (`makeTrack`, `parseRtp`); index.mjs supplies the real werift-backed
 * ones (`new MediaStreamTrack({kind})` / `RtpPacket.deSerialize`), tests supply fakes. So this file unit-tests with no
 * werift install (werift is a docker-build dep, absent from the container's local node_modules).
 *
 * INERT until ◆ go-live: no host runs this image until the Jake-named crossing (image rebuild WITH ffmpeg + bridge key
 * mint + STREAM_BRIDGE_ENABLED). The container Dockerfile now installs ffmpeg (this leg's only new system dep).
 */
import { spawn as nodeSpawn } from "node:child_process";
import { createSocket as nodeCreateSocket } from "node:dgram";

// The localhost RTP egress ports ffmpeg writes to are ASSIGNED BY THE OS, per relay — never fixed (#230).
//
// They used to be constants (5004/5006) on the premise "one relay per container instance ⇒ fixed ports are safe".
// That premise does not hold and cost us twice, live:
//   1. NO CONCURRENCY. A second relay on the same instance collided — `bind EADDRINUSE 127.0.0.1:5004` — so two
//      customers broadcasting at once meant the second one silently got a 502. A hard multi-tenant ceiling.
//   2. NO SELF-RECOVERY. A crashed or half-torn-down relay left the port held, so every subsequent start failed
//      until the instance was recycled — a wedge no retry could clear.
// Binding port 0 and reading back the assignment removes both: each relay gets its own pair, and a leaked socket
// can never block the next start. `ffmpegArgs` therefore REQUIRES the ports be passed in — there is deliberately
// no default, so this cannot regress to a shared port by omission.
/** RTP payload types stamped by ffmpeg. werift re-stamps to the negotiated outbound PT; these keep ffmpeg deterministic. */
const VIDEO_PT = 96; // VP8
const AUDIO_PT = 111; // Opus

/**
 * Build the ffmpeg argv that decodes an LL-HLS source and emits two RTP streams (VP8 video, Opus audio) to localhost.
 * Split out so unit tests assert the exact args without spawning ffmpeg. `-re` paces to wall-clock (live); realtime
 * VP8 deadline keeps latency low; `-muxdelay/-muxpreload 0` avoid RTP muxer buffering.
 * @param {string} srcUrl - the LL-HLS manifest URL (CF `.../manifest/video.m3u8?protocol=llhls`).
 * @param {string} [auth] - optional Bearer for a signed/token-gated source (unused for the unsigned dogfood manifest).
 * @param {boolean} [hasAudio=true] - whether the source carries an audio stream (see `probeHasAudio`). When false the
 *   ENTIRE audio output leg is omitted: `-map 0:a:0?` alone is NOT enough, because a second `-f rtp` output that maps
 *   zero streams makes ffmpeg abort with "Output file #1 does not contain any stream" — the very 502 this fixes.
 * @param {{video:number, audio?:number}} ports - the OS-assigned localhost RTP ports the relay's sockets are already
 *   bound to (#230). REQUIRED, and validated: sending RTP to a port nothing is listening on is silent dead air, so a
 *   missing/zero port must fail loudly here rather than produce a relay that looks up and carries no media.
 */
export function ffmpegArgs(srcUrl, auth, hasAudio = true, ports) {
  if (!ports?.video) throw new Error("ffmpegArgs: ports.video is required (#230 — RTP ports are OS-assigned)");
  if (hasAudio && !ports.audio) throw new Error("ffmpegArgs: ports.audio is required when hasAudio");
  const args = ["-hide_banner", "-loglevel", "warning", "-re"];
  if (auth) args.push("-headers", `Authorization: Bearer ${auth}\r\n`);
  args.push(
    "-i", srcUrl,
    "-map", "0:v:0", "-c:v", "libvpx", "-b:v", "2M", "-deadline", "realtime", "-cpu-used", "5",
    "-muxdelay", "0", "-muxpreload", "0", "-payload_type", String(VIDEO_PT), "-f", "rtp",
    `rtp://127.0.0.1:${ports.video}`,
  );
  if (hasAudio) {
    args.push(
      // `?` = tolerate the stream vanishing between probe and spawn (live manifests re-ladder mid-flight); the probe
      // above is what decides whether this leg exists at all.
      "-map", "0:a:0?", "-c:a", "libopus", "-b:a", "128k",
      "-muxdelay", "0", "-muxpreload", "0", "-payload_type", String(AUDIO_PT), "-f", "rtp",
      `rtp://127.0.0.1:${ports.audio}`,
    );
  }
  return args;
}

/**
 * Ask ffprobe whether the source carries an audio stream, so `hlsPull` can drop the audio leg for a video-only feed.
 *
 * WHY (real product bug, proven live 2026-07-18): customers push video-only RTMP/SRT all the time (screen shares,
 * camera-only encoders, silent art feeds). The old hard `-map 0:a:0` made ffmpeg exit at startup for those, which
 * `hlsPull` surfaced as `onState('failed')` → relay "source leg failed (no live media)" → container `/start` 502.
 * No bridge, no meter, no product.
 *
 * FAIL-SAFE DIRECTION: on ANY probe failure (timeout, ffprobe missing, malformed output) this returns TRUE — the
 * status-quo behavior. Biasing to false would SILENTLY DROP AUDIO from a source that has it, which is a worse and
 * quieter failure than the loud 502 it replaces. A probe that cannot reach the source is a source problem that the
 * ffmpeg spawn will surface loudly a second later anyway.
 *
 * @param {string} srcUrl - the LL-HLS manifest URL.
 * @param {string} [auth] - optional Bearer, mirrored from `ffmpegArgs`.
 * @param {object} [o]
 * @param {Function} [o.spawnFn] - injectable spawn (test seam).
 * @param {Function} [o.log] - structured logger.
 * @param {number} [o.timeoutMs=8000] - hard cap; a hung probe must not wedge relay startup.
 * @returns {Promise<boolean>}
 */
export function probeHasAudio(srcUrl, auth, o = {}) {
  const spawnFn = o.spawnFn ?? nodeSpawn;
  const log = o.log ?? (() => {});
  const timeoutMs = o.timeoutMs ?? 8_000;

  return new Promise((resolve) => {
    let settled = false;
    let timer; // declared before finish() — the spawn-throw path calls finish() before the timer is armed
    const finish = (hasAudio, why) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      log("hls-probe-audio", { hasAudio, why });
      resolve(hasAudio);
    };

    const args = ["-v", "error"];
    if (auth) args.push("-headers", `Authorization: Bearer ${auth}\r\n`);
    args.push("-select_streams", "a", "-show_entries", "stream=index", "-of", "csv=p=0", srcUrl);

    let proc;
    try {
      proc = spawnFn("ffprobe", args, { stdio: ["ignore", "pipe", "ignore"] });
    } catch (e) {
      finish(true, `spawn-threw:${String(e).slice(0, 80)}`);
      return;
    }

    timer = setTimeout(() => {
      try { proc.kill("SIGKILL"); } catch { /* already dead */ }
      finish(true, "timeout");
    }, timeoutMs);

    let out = "";
    proc.stdout?.on("data", (d) => { out += String(d); });
    proc.on("error", (e) => finish(true, `spawn-error:${String(e).slice(0, 80)}`));
    proc.on("exit", (code) => {
      // Non-zero ffprobe exit = we learned nothing → status quo (assume audio). Zero exit with empty stdout is a
      // DEFINITIVE "no audio streams" answer, which is exactly the video-only case we are here to serve.
      if (code !== 0) return finish(true, `exit:${code}`);
      finish(out.trim().length > 0, "probed");
    });
  });
}

/**
 * Open the LL-HLS source leg. Resolves once ffmpeg is spawned and both RTP sockets are bound (tracks are produced up
 * front so `runRelay` can collect them); `onState('connected')` fires on the FIRST RTP packet on either socket (media
 * is actually flowing), `onState('failed')` on a non-zero ffmpeg exit that we did NOT initiate via stop().
 *
 * @param {object} o
 * @param {string} o.srcUrl - the LL-HLS manifest URL (index.mjs `llhlsUrlFor(uid)`).
 * @param {string} [o.auth] - optional signed-source Bearer (contract Q-2 parity with the old WHEP auth).
 * @param {(track: object) => void} o.onTrack - called once per produced track (video, then audio).
 * @param {(state: 'connected'|'failed') => void} o.onState - lifecycle signal runRelay awaits.
 * @param {(kind: 'video'|'audio') => { writeRtp: Function }} o.makeTrack - werift track factory (index.mjs injects
 *   `(kind) => new MediaStreamTrack({ kind })`; tests inject a fake).
 * @param {(buf: Buffer) => unknown} o.parseRtp - werift RTP parser (index.mjs injects `RtpPacket.deSerialize`).
 * @param {Function} [o.log] - structured logger (defaults to no-op).
 * @param {Function} [o.spawnFn] - injectable child_process.spawn (default node:child_process spawn) — test seam.
 * @param {Function} [o.socketFactory] - injectable dgram socket maker (default node:dgram createSocket) — test seam.
 * @returns {Promise<{ stop: () => Promise<void> }>}
 */
export async function hlsPull(o) {
  const { srcUrl, auth, onTrack, onState, makeTrack, parseRtp } = o;
  const log = o.log ?? (() => {});
  const spawnFn = o.spawnFn ?? nodeSpawn;
  const socketFactory = o.socketFactory ?? (() => nodeCreateSocket("udp4"));

  if (!srcUrl) throw new Error("hlsPull: srcUrl is required");
  if (typeof makeTrack !== "function") throw new Error("hlsPull: makeTrack is required (werift track factory)");
  if (typeof parseRtp !== "function") throw new Error("hlsPull: parseRtp is required (werift RTP parser)");

  let connected = false;
  let stopping = false;

  const markConnected = () => {
    if (connected || stopping) return;
    connected = true;
    log("hls-connected", {});
    onState?.("connected");
  };

  // Does the source actually carry audio? A video-only feed gets a video-only bridge (relay.mjs requires >=1 track,
  // not both) instead of the startup 502 the old hard `-map 0:a:0` produced. Injectable for tests via `probeFn`.
  const probe = o.probeFn ?? probeHasAudio;
  const hasAudio = o.hasAudio ?? (await probe(srcUrl, auth, { spawnFn, log }));

  // Synthetic sendonly relay tracks — writeRtp() feeds them the deserialized ffmpeg RTP; publish() addTrack()s them.
  const videoTrack = makeTrack("video");
  const audioTrack = hasAudio ? makeTrack("audio") : null;

  // Every socket the instant it exists — so teardown reaches it even if the OTHER leg's bind rejects mid-Promise.all.
  const openSockets = [];

  // Port 0 = "OS, give me a free one". See the #230 note at the top of this file for why a fixed port was wrong.
  const bindSocket = (track, kind) =>
    new Promise((resolve, reject) => {
      const sock = socketFactory();
      openSockets.push(sock);
      let settled = false; // the bind promise resolves/rejects ONCE; later socket errors take the live-relay path
      sock.on("message", (buf) => {
        // Media is flowing the instant the FIRST datagram lands — signal 'connected' BEFORE writeRtp, because
        // runRelay awaits 'connected' before publish()→addTrack() attaches the track (gating on writeRtp success
        // would deadlock, since a not-yet-attached track's writeRtp is a no-op/throw). Startup packets before
        // attach are dropped — acceptable for live media.
        markConnected();
        try {
          track.writeRtp(parseRtp(buf)); // ◆-live-proof: werift re-stamps PT/SSRC to the negotiated outbound codec
        } catch {
          /* a single malformed datagram must not kill the relay; the SFU tolerates loss */
        }
      });
      sock.on("error", (e) => {
        const msg = `hls ${kind} socket error: ${String(e).slice(0, 160)}`;
        if (!settled) {
          settled = true;
          reject(new Error(msg)); // bind-time failure → reject so hlsPull throws (and the catch below closes sockets)
          return;
        }
        // Mid-relay socket error (post-bind): fail LOUD so index.mjs surfaces 5xx and B1 reconciles — never silently
        // drop it onto an already-settled promise (which Node would discard, wedging the relay `active`).
        log("hls-socket-error", { kind, message: msg });
        if (!stopping) onState?.("failed");
        try { sock.close(); } catch { /* already closed */ }
      });
      sock.bind(0, "127.0.0.1", () => { settled = true; resolve(sock); });
    });

  let ports;
  try {
    const [videoSock, audioSock] = await Promise.all([
      bindSocket(videoTrack, "video"),
      // No audio leg for a video-only source: nothing will ever be sent to this port, and binding it would leave a
      // socket whose silence is indistinguishable from a stalled audio feed.
      ...(audioTrack ? [bindSocket(audioTrack, "audio")] : []),
    ]);
    // Read the assignment back BEFORE spawning ffmpeg — the argv must point at the ports we actually hold. If the
    // socket cannot report its address we must not guess: ffmpeg would send RTP into a void and the relay would
    // come up looking healthy while carrying no media (exactly the silent-no-op class of #235/#241).
    ports = { video: videoSock?.address?.().port, audio: audioSock?.address?.().port };
    if (!ports.video || (audioTrack && !ports.audio)) {
      throw new Error(`hls: RTP socket did not report a bound port (video=${ports.video} audio=${ports.audio})`);
    }
    log("hls-rtp-ports-bound", ports);
  } catch (e) {
    for (const s of openSockets) { try { s.close(); } catch { /* already closed */ } }
    throw e; // fail loud — a source that can't bind its RTP sockets can't relay
  }

  // Produce the tracks up front so runRelay collects both before publish (it requires >=1 track before WHIP-out).
  onTrack?.(videoTrack);
  if (audioTrack) onTrack?.(audioTrack);

  const ff = spawnFn("ffmpeg", ffmpegArgs(srcUrl, auth, hasAudio, ports), { stdio: ["ignore", "ignore", "pipe"] });
  ff.stderr?.on("data", (d) => log("ffmpeg-stderr", { line: String(d).slice(0, 200) }));
  ff.on("exit", (code) => {
    log("ffmpeg-exit", { code });
    // ANY ffmpeg exit we did NOT trigger via stop() = the live source ended → fail loud so B1's reconcile
    // re-dispatches. A clean exit (code 0) is NOT success for a live relay: it means the source stopped
    // sending (EXT-X-ENDLIST / silent origin), which must surface, not leave the relay wedged `active`.
    if (!stopping) onState?.("failed");
  });
  ff.on("error", (e) => {
    log("ffmpeg-spawn-error", { message: String(e).slice(0, 200) });
    if (!stopping) onState?.("failed");
  });
  log("hls-ffmpeg-spawned", { srcUrl: srcUrl.replace(/\?.*/, "?…"), hasAuth: !!auth });

  const stop = async () => {
    if (stopping) return;
    stopping = true;
    try { ff.kill("SIGTERM"); } catch { /* already dead */ }
    for (const s of openSockets) {
      try { s.close(); } catch { /* already closed */ }
    }
    log("hls-stopped", {});
  };

  return { stop };
}
