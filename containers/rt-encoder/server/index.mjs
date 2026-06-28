// rt-encoder server (#72 / RT-R10) — the tiny, STATELESS HTTP transcode service that runs inside the
// portable raw-SFU recorder container. ONE image, TWO runtimes (CF Containers A / self-host B); this
// server is identical in both — the runtime is chosen on the Worker side (RECORDER_TARGET), not here.
//
// CONTRACT (cf-ws-adapter-contract.md + epic-67-68-B §P1): the DO/Worker POSTs ONE decoded frame:
//   POST /encode
//     headers: x-kind: "video"|"audio", x-ts: <ms>, x-codec: "jpeg"|"pcm" (source codec)
//     body:    raw bytes — a full JPEG frame (video) OR 16-bit-LE PCM @ 48kHz stereo (audio)
//   → spawn ffmpeg:
//       JPEG → VP8 :  ffmpeg -f mjpeg   -i - -c:v libvpx -f ivf -
//       PCM  → Opus:  ffmpeg -f s16le -ar 48000 -ac 2 -i - -c:a libopus -f ogg -
//   → 200 with the encoded bytes (Content-Type application/octet-stream); the Worker hands them to the
//     muxer's RawSfuTap.videoEncoder / AudioEncoder seam. PURE transcode — no R2, no state, no creds.
//   GET /health → 200 "ok" (the container readiness probe + the [[containers]] / docker HEALTHCHECK).
//
// CODEC MATRIX (ADR adr-codec-matrix.md): the source codec (x-codec) is the DECODED frame format; an
// OPTIONAL `x-target-codec` requests a specific output codec (vp9/av1/h264/h265/aac/…). When absent the
// server emits the byte-unchanged DEFAULT (jpeg→VP8/IVF, pcm→Opus/Ogg). When present it selects the best
// AVAILABLE encoder for THIS host (hardware-first, software fallback) and HONEST-FAILS (no silent codec
// substitution) if the requested codec has no encoder. `GET /capabilities` reports the host's matrix.
//
// SECURITY/SAFETY: body is capped (MAX_BODY) to bound memory; ffmpeg args are built ONLY from the
// registry/selection (encoder names are never interpolated from raw request input → no arg injection); a
// transcode failure returns 502, never crashes the server (the Worker's target is fail-open and drops the
// frame). No request logging of payload bytes.
import http from "node:http";
import { spawn } from "node:child_process";
import { buildCommand, selectEncodeProfile, av1DefaultEnabled } from "./command.mjs";
import { probeCapability, emptyCapability } from "./capability.mjs";
import { probeDecoders, emptyDecodeCapability } from "./decode.mjs";
import { CodecUnavailableError, UnknownCodecError } from "./select.mjs";
import { buildCapabilityDescriptor, toCapabilitiesResponse } from "./descriptor.mjs";
import {
  negotiationEnabled,
  parseDstDescriptor,
  negotiateTargetCodec,
  NegotiationInputError,
} from "./negotiate.mjs";

const PORT = Number(process.env.PORT || 8080);
const MAX_BODY = 8 * 1024 * 1024; // 8 MiB — one JPEG frame or a PCM chunk is far smaller; bounds memory.

/** Accepted SOURCE codecs (the decoded frame format the Worker POSTs). */
const SOURCE_CODECS = new Set(["jpeg", "pcm"]);

/**
 * Host capability, probed lazily on first NON-default /encode (a target-codec request) or /capabilities,
 * then cached. The DEFAULT path (no target) never needs it — libvpx/libopus are always in the image — so
 * the proven path does not pay a probe cost and stays byte-identical even if ffmpeg -encoders is unusual.
 * @type {import("./capability.mjs").Capability|null}
 */
let _cap = null;
async function getCapability() {
  if (_cap) return _cap;
  try {
    _cap = await probeCapability();
  } catch {
    _cap = emptyCapability(); // probe failed → empty set; target requests honest-fail, default unaffected.
  }
  return _cap;
}

/**
 * Host DECODE capability, probed lazily on /capabilities only (the /encode path never needs decode). Same
 * fail-safe contract: probe failure → empty decode set (descriptor reports decode:available:false for all).
 * @type {{decoders:Set<string>, decodeCodecs:Set<string>}|null}
 */
let _decode = null;
async function getDecodeCapability() {
  if (_decode) return _decode;
  try {
    _decode = await probeDecoders();
  } catch {
    _decode = emptyDecodeCapability();
  }
  return _decode;
}

/** Read the full request body into one Buffer, capping at MAX_BODY (over-cap → reject). */
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let len = 0;
    req.on("data", (c) => {
      len += c.length;
      if (len > MAX_BODY) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

/** Spawn ffmpeg with the (already-built, allowlisted) `args`, pipe `input` to stdin, resolve stdout bytes. */
function transcode(args, input) {
  return new Promise((resolve, reject) => {
    if (!Array.isArray(args) || args.length === 0) return reject(new Error("no ffmpeg args"));
    const ff = spawn("ffmpeg", args, { stdio: ["pipe", "pipe", "pipe"] });
    const out = [];
    let err = "";
    ff.stdout.on("data", (c) => out.push(c));
    ff.stderr.on("data", (c) => (err += c.toString()));
    ff.on("error", reject);
    ff.on("close", (code) => {
      if (code === 0) resolve(Buffer.concat(out));
      else reject(new Error(`ffmpeg exit ${code}: ${err.slice(0, 500)}`));
    });
    ff.stdin.on("error", () => {}); // EPIPE if ffmpeg exits early — swallow; the close handler reports it
    ff.stdin.write(input);
    ff.stdin.end();
  });
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === "GET" && req.url === "/health") {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("ok");
      return;
    }
    // GET /capabilities — report THIS host's encoder matrix: which registry codecs have an available
    // encoder, and the chosen impl (encoder/kind/accel). Additive, read-only; no effect on /encode.
    if (req.method === "GET" && req.url === "/capabilities") {
      // Full CapabilityDescriptor (#86): EXISTING {hwaccels, codecs} keys stay byte-stable; region/decode/
      // transports/maxResFps are ADDITIVE (descriptor.toCapabilitiesResponse preserves the encode shape).
      const cap = await getCapability();
      const decode = await getDecodeCapability();
      const descriptor = buildCapabilityDescriptor({ capability: cap, decode, env: process.env });
      const payload = JSON.stringify(toCapabilitiesResponse(descriptor));
      res.writeHead(200, { "content-type": "application/json", "content-length": Buffer.byteLength(payload) });
      res.end(payload);
      return;
    }
    if (req.method === "POST" && (req.url === "/encode" || req.url === "/encode/")) {
      const source = String(req.headers["x-codec"] || "").toLowerCase();
      if (!SOURCE_CODECS.has(source)) {
        res.writeHead(400, { "content-type": "text/plain" });
        res.end("bad x-codec (expected jpeg|pcm)");
        return;
      }
      // OPTIONAL target codec. Absent → byte-unchanged DEFAULT path (no capability probe needed).
      let target = String(req.headers["x-target-codec"] || "").toLowerCase() || null;

      // ── NEGOTIATION (#86, default-OFF) ── When NEGOTIATION_ENABLED==="true" AND the request carries a DST
      // capability descriptor (x-dst-capabilities, base64 JSON), the per-leg selector negotiates the target
      // codec from THIS host's caps vs the consumer's — instead of trusting the caller's x-target-codec. The
      // flag OFF, or ON-but-no-descriptor, leaves `target` exactly as the header set it → byte-identical to
      // today. An x-live:"1" hint enables region-placement enforcement (live legs same-continent only).
      let negTransport = null;
      if (negotiationEnabled(process.env)) {
        let dstDescriptor;
        try {
          dstDescriptor = parseDstDescriptor(req.headers["x-dst-capabilities"]);
        } catch (e) {
          if (e instanceof NegotiationInputError) {
            res.writeHead(400, { "content-type": "text/plain" });
            res.end(`bad x-dst-capabilities: ${e.message}`);
            return;
          }
          throw e;
        }
        if (dstDescriptor) {
          // Build THIS host's descriptor (src) from its probed caps, then negotiate.
          const cap = await getCapability();
          const decode = await getDecodeCapability();
          const srcDescriptor = buildCapabilityDescriptor({ capability: cap, decode, env: process.env });
          const live = String(req.headers["x-live"] || "") === "1";
          const result = negotiateTargetCodec(srcDescriptor, dstDescriptor, { live });
          if (!result.negotiated) {
            // HONEST-FAIL: no viable leg → explicit 422 with the TYPED reason. NEVER a silent downgrade.
            res.writeHead(422, { "content-type": "text/plain", "x-negotiation-reason": result.reason });
            res.end(`no viable leg: ${result.reason}${result.detail ? ` (${result.detail})` : ""}`);
            return;
          }
          target = result.targetCodec; // negotiated codec drives the encode (overrides any x-target-codec).
          negTransport = result.transport;
        }
      }

      // ── #83/#75 AV1-DEFAULT master-encode profile (default-OFF) ── When AV1_DEFAULT is armed AND the caller
      // gave no explicit target (and negotiation did not pick one), default the master encode profile to AV1
      // for the eligible VIDEO frame source (jpeg). selectEncodeProfile prefers AV1 only when the host has an
      // AV1 encoder, else surfaces a VISIBLE H.264 fallback reason (header below); when neither is encodable it
      // keeps target=null → the proven byte-identical VP8 default. OFF/absent → target untouched → unchanged.
      let av1FallbackReason = null;
      if (!target && av1DefaultEnabled(process.env)) {
        const available = (await getCapability()).encoders;
        const profile = selectEncodeProfile(source, available, process.env);
        if (profile.target) target = profile.target;
        if (profile.fallbackReason) av1FallbackReason = profile.fallbackReason;
      }

      let cmd;
      try {
        const available = target ? (await getCapability()).encoders : new Set();
        cmd = buildCommand({ sourceCodec: source, targetCodec: target, available });
      } catch (e) {
        // HONEST-FAIL: unknown/unavailable requested codec → 400 (caller error), never a silent substitute.
        if (e instanceof CodecUnavailableError || e instanceof UnknownCodecError) {
          res.writeHead(400, { "content-type": "text/plain" });
          res.end(`codec not available: ${e.message}`);
          return;
        }
        throw e;
      }
      const body = await readBody(req);
      if (body.length === 0) {
        res.writeHead(400, { "content-type": "text/plain" });
        res.end("empty body");
        return;
      }
      const encoded = await transcode(cmd.args, body);
      const headers = {
        "content-type": "application/octet-stream",
        "content-length": encoded.length,
        "x-encoder": cmd.encoder, // observability: which encoder actually ran (default = libvpx/libopus).
        "x-output-codec": cmd.target,
        "x-output-container": cmd.container,
      };
      // Observability marker: present ONLY when the negotiator drove this encode — the live proof that
      // per-leg negotiation actually ran in a real session (absent on the legacy/default path → no drift).
      if (negTransport) headers["x-negotiated-transport"] = negTransport;
      // #83 observability: present ONLY when the AV1-default profile demoted off AV1 (no host AV1 encoder) — the
      // VISIBLE proof of an honest H.264/VP8 fallback rather than a silent substitution. Absent on the AV1-hit
      // path and on the unchanged default path → no drift.
      if (av1FallbackReason) headers["x-av1-fallback-reason"] = av1FallbackReason;
      res.writeHead(200, headers);
      res.end(encoded);
      return;
    }
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("not found");
  } catch (e) {
    // Fail-closed at the boundary: a transcode/parse error is a 502, never a crash. The Worker target is
    // fail-open and simply drops the frame (recording is best-effort, never on the media critical path).
    res.writeHead(502, { "content-type": "text/plain" });
    res.end(`encode failed: ${e instanceof Error ? e.message : "error"}`);
  }
});

server.listen(PORT, () => {
  console.log(JSON.stringify({ msg: "rt-encoder listening", port: PORT }));
});
