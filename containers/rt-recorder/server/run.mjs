// rt-recorder (#151) — runnable ENTRY. Reads the SFU descriptor + pre-signed ingest endpoint from env (12-factor)
// and records ONE track: werift PULL → MediaRecorder → WebM → sink. Two modes, chosen by env:
//   • route  (hosted, default when INGEST_ENDPOINT is set) — stream to the Worker recording-ingest route so the
//     RoomDO writes the single canonical R2 object. The endpoint is PRE-SIGNED (?t=…) by the orchestrator; this
//     process holds NO WAVE_INTERNAL_SECRET.
//   • local  (dev/on-prem) — write to a local file (RECORDER_LOCAL_DIR), for a self-contained receipt.
//
// In hosted production the RoomDO dispatches this per publish with a fresh descriptor + pre-signed endpoint; for a
// FIRST live receipt (or a manual canary run) the same values are passed as env, mirroring the proven harness.
//
// Env: APP_ID, APP_SECRET (SFU app creds — kept out of logs), PUBLISHER_SESSION, TRACK, CODEC (VP8|VP9|H264|
//   OPUS|AV1|H265), ORG, SESSION_ID, RUN_MS; then either INGEST_ENDPOINT (pre-signed, route mode) OR
//   RECORDER_LOCAL_DIR (local mode). SFU_BASE optional (default CF prod).
import { mkdtempSync } from "node:fs";
import fs from "node:fs";
import os from "node:os";
import { join } from "node:path";
import { recordTrackToSink } from "./record-to-sink.mjs";
import { makeRecorderRouteSink } from "./recorder-route-sink.mjs";

const log = (msg, f = {}) => console.log(JSON.stringify({ mod: "rt-recorder-run", msg, ...f }));
const env = process.env;

function required(name) {
  const v = env[name];
  if (!v) throw new Error(`rt-recorder: missing required env ${name}`);
  return v;
}

/** A local-file sink (dev/on-prem) implementing the RecordingSink contract via node:fs append. */
function makeLocalFileSink(dir, org, sessionId) {
  const path = join(dir, `${org}__${sessionId}.webm`.replace(/[^\w.-]/g, "_"));
  let fd = null;
  let bytes = 0;
  return {
    kind: "localfs",
    key: path,
    async write(part) {
      if (!part || part.length === 0) return;
      if (fd === null) fd = fs.openSync(path, "w");
      fs.writeSync(fd, part);
      bytes += part.length;
    },
    async finalize() {
      if (fd === null) return null;
      fs.closeSync(fd);
      fd = null;
      return { key: path, bytes, container: "webm" };
    },
    async abort() {
      if (fd !== null) {
        fs.closeSync(fd);
        fd = null;
      }
      try {
        fs.rmSync(path, { force: true });
      } catch {
        /* best-effort */
      }
    },
  };
}

async function main() {
  const org = required("ORG");
  const sessionId = required("SESSION_ID");
  const recorder = {
    appId: required("APP_ID"),
    appSecret: required("APP_SECRET"),
    publisherSessionId: required("PUBLISHER_SESSION"),
    trackName: required("TRACK"),
    codec: (env.CODEC ?? "VP8").toUpperCase(),
    runMs: Number(env.RUN_MS ?? 15000),
    sfuBase: env.SFU_BASE,
  };

  let sink;
  if (env.INGEST_ENDPOINT) {
    sink = makeRecorderRouteSink({ endpoint: env.INGEST_ENDPOINT, org, sessionId }); // hosted (pre-signed)
    log("mode", { sink: "route" });
  } else if (env.RECORDER_LOCAL_DIR) {
    sink = makeLocalFileSink(env.RECORDER_LOCAL_DIR, org, sessionId);
    log("mode", { sink: "local", dir: env.RECORDER_LOCAL_DIR });
  } else {
    throw new Error("rt-recorder: set INGEST_ENDPOINT (hosted) or RECORDER_LOCAL_DIR (local)");
  }

  const tmpDir = mkdtempSync(join(os.tmpdir(), "rt-recorder-"));
  const tmpPath = join(tmpDir, "recording.webm");
  const out = await recordTrackToSink({ recorder, fs, tmpPath, sink });
  log("done", out);
  // Success = bytes landed in the sink. record-to-sink sets `result` on BOTH the werift-safe (mediarecorder)
  // path AND the #153 native-transcode path (AV1/H265 → ffmpeg → SAME WebM sink), so an AV1 recording that
  // streamed to R2 is a success (exit 0), not a failure. Only two non-zero cases remain:
  //   • no result + native routing → honest "no capture bridge for this source; record it natively" (exit 3)
  //   • no result + mediarecorder  → the proven codec produced nothing streamable (exit 4, a real fault)
  if (out.result) {
    /* landed (mediarecorder OR native-transcode) — success */
  } else if (out.routed === "mediarecorder") {
    process.exitCode = 4;
  } else {
    process.exitCode = 3;
  }
}

main().catch((e) => {
  log("fatal", { err: String(e?.stack ?? e).slice(0, 500) });
  process.exit(1);
});
