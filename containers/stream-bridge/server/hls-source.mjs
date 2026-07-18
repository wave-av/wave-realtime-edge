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

/** localhost RTP egress ports ffmpeg writes to (one relay per container instance ⇒ fixed ports are safe). */
export const VIDEO_RTP_PORT = 5004;
export const AUDIO_RTP_PORT = 5006;
/** RTP payload types stamped by ffmpeg. werift re-stamps to the negotiated outbound PT; these keep ffmpeg deterministic. */
const VIDEO_PT = 96; // VP8
const AUDIO_PT = 111; // Opus

/**
 * Build the ffmpeg argv that decodes an LL-HLS source and emits two RTP streams (VP8 video, Opus audio) to localhost.
 * Split out so unit tests assert the exact args without spawning ffmpeg. `-re` paces to wall-clock (live); realtime
 * VP8 deadline keeps latency low; `-muxdelay/-muxpreload 0` avoid RTP muxer buffering.
 * @param {string} srcUrl - the LL-HLS manifest URL (CF `.../manifest/video.m3u8?protocol=llhls`).
 * @param {string} [auth] - optional Bearer for a signed/token-gated source (unused for the unsigned dogfood manifest).
 */
export function ffmpegArgs(srcUrl, auth) {
  const args = ["-hide_banner", "-loglevel", "warning", "-re"];
  if (auth) args.push("-headers", `Authorization: Bearer ${auth}\r\n`);
  args.push(
    "-i", srcUrl,
    "-map", "0:v:0", "-c:v", "libvpx", "-b:v", "2M", "-deadline", "realtime", "-cpu-used", "5",
    "-muxdelay", "0", "-muxpreload", "0", "-payload_type", String(VIDEO_PT), "-f", "rtp",
    `rtp://127.0.0.1:${VIDEO_RTP_PORT}`,
    "-map", "0:a:0", "-c:a", "libopus", "-b:a", "128k",
    "-muxdelay", "0", "-muxpreload", "0", "-payload_type", String(AUDIO_PT), "-f", "rtp",
    `rtp://127.0.0.1:${AUDIO_RTP_PORT}`,
  );
  return args;
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

  // Synthetic sendonly relay tracks — writeRtp() feeds them the deserialized ffmpeg RTP; publish() addTrack()s them.
  const videoTrack = makeTrack("video");
  const audioTrack = makeTrack("audio");

  // Every socket the instant it exists — so teardown reaches it even if the OTHER leg's bind rejects mid-Promise.all.
  const openSockets = [];

  const bindSocket = (port, track, kind) =>
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
      sock.bind(port, "127.0.0.1", () => { settled = true; resolve(sock); });
    });

  try {
    await Promise.all([
      bindSocket(VIDEO_RTP_PORT, videoTrack, "video"),
      bindSocket(AUDIO_RTP_PORT, audioTrack, "audio"),
    ]);
  } catch (e) {
    for (const s of openSockets) { try { s.close(); } catch { /* already closed */ } }
    throw e; // fail loud — a source that can't bind its RTP sockets can't relay
  }

  // Produce the tracks up front so runRelay collects both before publish (it requires >=1 track before WHIP-out).
  onTrack?.(videoTrack);
  onTrack?.(audioTrack);

  const ff = spawnFn("ffmpeg", ffmpegArgs(srcUrl, auth), { stdio: ["ignore", "ignore", "pipe"] });
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
