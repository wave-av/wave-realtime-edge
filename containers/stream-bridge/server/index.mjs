/**
 * #91 B2 / #35 — source-to-whip republisher container HTTP control server (contract §5, LL-HLS source).
 *
 * ONE image, TWO runtimes (mirrors rt-encoder): Path A — Cloudflare Containers, fronted by the Worker via
 * getContainer(STREAM_BRIDGE, `${org}:${uid}`).fetch('/start'|'/stop'); Path B — self-host (`docker run` on
 * Studio / on-prem). Same control contract; the runtime is chosen Worker-side, not by the image.
 *
 * Control plane (text/JSON only — media never crosses this HTTP seam, contract §9.2):
 *   GET  /health        → 200 "ok"
 *   POST /start  {room, uid}  → open the LL-HLS source (live_input) → republish via the gateway WHIP path into the SFU.
 *   POST /stop                → tear the relay down (WHIP DELETE → SFU close → stop meter; then source close).
 *
 * SOURCE = LL-HLS, not WHEP (#211, proven 2026-07-18): CF Stream Live's `/webRTC/play` (WHEP egress) serves ONLY
 * WHIP-ingested inputs — 409 forever for the RTMP/SRT feeds customers push — so the source is pulled over LL-HLS by
 * `./hls-source.mjs` (ffmpeg decodes the HLS ladder → VP8/Opus → localhost RTP → werift MediaStreamTracks). Those
 * tracks are handed, RTP-verbatim on the WHIP-out leg (NO second transcode, §9.4), to `@wave-av/whip-publish` v0.2.0
 * relay source mode (#758). org/keyId are derived SERVER-SIDE by the gateway from the bridge `wk_` key (env WHIP_KEY)
 * — never from a body/header (§9.1).
 *
 * Env (per contract §5 / dispatch): PORT(=8080), LLHLS_SRC_URL_TEMPLATE or LLHLS_SRC_URL, WHIP_DST_URL
 * (gateway /v1/whip/publish), WHIP_KEY (bridge wk_), optional SOURCE_AUTH (signed-source Bearer, Q-2).
 *
 * INERT until ◆ go-live: no host runs this image until the Jake-named crossing (image build WITH ffmpeg + bridge key
 * mint + webhook secret + STREAM_BRIDGE_ENABLED=1). The orchestration is unit-proven (test/relay.test.mjs); the
 * live LL-HLS→WHIP RTP forwarding is proven at ◆ go-live (§7.6: real RTMPS push → LL-HLS → an SFU track id).
 */
import { createServer } from "node:http";
import { RTCPeerConnection, MediaStreamTrack, RtpPacket } from "werift";
import { publish } from "@wave-av/whip-publish";
import { hlsPull } from "./hls-source.mjs";
import { runRelay } from "./relay.mjs";

const PORT = Number(process.env.PORT || 8080);

function log(event, fields = {}) {
  // structured one-line JSON (CF container logs + Path B stdout); never logs secret values.
  process.stdout.write(JSON.stringify({ event, ts: Date.now(), ...fields }) + "\n");
}

/** werift peer-connection factory for the WHIP-out leg (STUN only; the SFU/gateway drive the rest of ICE). */
function pcFactory() {
  return new RTCPeerConnection({ iceServers: [{ urls: "stun:stun.cloudflare.com:3478" }] });
}

/** Resolve the LL-HLS source manifest URL for a live_input uid (template `{uid}` or a fixed URL). */
function llhlsUrlFor(uid) {
  const tmpl = process.env.LLHLS_SRC_URL_TEMPLATE;
  if (tmpl) return tmpl.replace("{uid}", encodeURIComponent(uid));
  return process.env.LLHLS_SRC_URL || "";
}

/**
 * The source leg (injected as runRelay's `pull`): the LL-HLS ffmpeg source with the real werift primitives bound.
 * hls-source.mjs is werift-free by design (unit-testable with fakes); the werift track factory + RTP parser are
 * supplied HERE, the one module that owns the werift import.
 */
const hlsSource = (args) =>
  hlsPull({
    ...args,
    makeTrack: (kind) => new MediaStreamTrack({ kind }),
    parseRtp: (buf) => RtpPacket.deSerialize(buf),
    log,
  });

let active = null; // the single in-flight relay handle (one container instance == one bridged input)

async function readJson(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) return {};
  return JSON.parse(raw);
}

const server = createServer(async (req, res) => {
  const send = (status, body) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(typeof body === "string" ? body : JSON.stringify(body));
  };
  try {
    // /health reports the RELAY's real state, not a constant. A health check that cannot fail tells
    // the control plane nothing — this one returned `{ok:true}` while the WHIP leg was dead, which is
    // how a dead media path went unnoticed for minutes (#235). `bridging` is the field callers act on:
    // true only when a relay exists AND both legs are non-terminal.
    if (req.method === "GET" && req.url === "/health") {
      return send(200, {
        ok: true, // the SERVER is up — distinct from whether it is bridging
        bridging: Boolean(active?.alive),
        tracks: active?.trackCount ?? 0,
        relay: active?.state ?? null,
      });
    }

    if (req.method === "POST" && req.url === "/start") {
      const { room, uid } = await readJson(req);
      if (!uid) return send(400, { error: "uid required" });
      if (active) {
        // one input per container instance; a duplicate /start is idempotent-ish (report the live relay).
        return send(200, { ok: true, already: true, tracks: active.trackCount });
      }
      const sourceUrl = llhlsUrlFor(uid);
      log("bridge-start", { room, uid, hasSource: !!sourceUrl });
      active = await runRelay({
        sourceUrl,
        whipUrl: process.env.WHIP_DST_URL,
        whipKey: process.env.WHIP_KEY,
        sourceAuth: process.env.SOURCE_AUTH || undefined,
        pull: hlsSource,
        publish,
        pcFactory,
        log,
      });
      return send(200, { ok: true, tracks: active.trackCount });
    }

    if (req.method === "POST" && req.url === "/stop") {
      log("bridge-stop", {});
      const h = active;
      active = null;
      await h?.stop();
      return send(200, { ok: true });
    }

    return send(404, { error: "not found" });
  } catch (err) {
    // Fail-LOUD: a relay that can't come up returns 5xx so B1's reconcile re-dispatches (§9.5).
    active = null;
    log("bridge-error", { url: req.url, message: String(err?.message || err).slice(0, 300) });
    return send(502, { error: String(err?.message || err).slice(0, 300) });
  }
});

server.listen(PORT, () => log("stream-bridge-listening", { port: PORT }));
