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
// SECURITY/SAFETY: body is capped (MAX_BODY) to bound memory; ffmpeg args are a fixed allowlist by
// x-codec (never interpolated from request input → no arg injection); a transcode failure returns 502,
// never crashes the server (the Worker's target is fail-open and drops the frame). No request logging of
// payload bytes.
import http from "node:http";
import { spawn } from "node:child_process";

const PORT = Number(process.env.PORT || 8080);
const MAX_BODY = 8 * 1024 * 1024; // 8 MiB — one JPEG frame or a PCM chunk is far smaller; bounds memory.

/** Fixed ffmpeg arg allowlists, keyed by SOURCE codec. NEVER built from request input (no injection). */
const FFMPEG_ARGS = {
  // JPEG (mjpeg) → VP8 in an IVF container (the muxer reads VP8 frames; IVF carries the frame cleanly).
  jpeg: ["-hide_banner", "-loglevel", "error", "-f", "mjpeg", "-i", "-", "-c:v", "libvpx", "-f", "ivf", "-"],
  // 16-bit-LE PCM @ 48kHz stereo → Opus in an Ogg container.
  pcm: ["-hide_banner", "-loglevel", "error", "-f", "s16le", "-ar", "48000", "-ac", "2", "-i", "-", "-c:a", "libopus", "-f", "ogg", "-"],
};

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

/** Spawn ffmpeg with the allowlisted args for `codec`, pipe `input` to stdin, resolve the stdout bytes. */
function transcode(codec, input) {
  return new Promise((resolve, reject) => {
    const args = FFMPEG_ARGS[codec];
    if (!args) return reject(new Error(`unsupported codec: ${codec}`));
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
    if (req.method === "POST" && (req.url === "/encode" || req.url === "/encode/")) {
      const codec = String(req.headers["x-codec"] || "").toLowerCase();
      if (!FFMPEG_ARGS[codec]) {
        res.writeHead(400, { "content-type": "text/plain" });
        res.end("bad x-codec (expected jpeg|pcm)");
        return;
      }
      const body = await readBody(req);
      if (body.length === 0) {
        res.writeHead(400, { "content-type": "text/plain" });
        res.end("empty body");
        return;
      }
      const encoded = await transcode(codec, body);
      res.writeHead(200, { "content-type": "application/octet-stream", "content-length": encoded.length });
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
