// #154 PROOF — the exact live AV1 chain, offline & deterministic: real AV1 temporal units → spec-conformant
// AV1 RTP payloads → REAL werift AV1RtpPayload.deSerialize/getFrame (the depacketizer the live recorder taps)
// → Av1FrameAssembler → Av1IvfWriter → ffmpeg. If ffmpeg reads the result as `av1` with the same frame count,
// the werift-depacketize → IVF wiring in sfu-track-recorder.mjs is proven end-to-end (only the CF-SFU transport
// hop is not exercised here). Input: a real AV1 IVF (scratchpad ref-av1.ivf, 1280×720, 120 frames).
//
// Run: node harness/av1-depacketize-proof.mjs <ref.ivf> <out.ivf> <out.webm>
import { readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { AV1RtpPayload } from "werift";
import { Av1FrameAssembler } from "../containers/rt-recorder/server/av1-depacketize.mjs";
import { Av1IvfWriter } from "../containers/rt-recorder/server/av1-ivf.mjs";

const [refPath, outIvf, outWebm] = process.argv.slice(2);
const log = (m, f = {}) => console.log(JSON.stringify({ m, ...f }));

// ---- IVF parse: 32-byte header (WxH at 12/14, den at 16) then per-frame 12-byte header (size u32le + pts u64le).
function parseIvf(buf) {
  const width = buf.readUInt16LE(12), height = buf.readUInt16LE(14), den = buf.readUInt32LE(16);
  const frames = [];
  let o = 32;
  while (o + 12 <= buf.length) {
    const size = buf.readUInt32LE(o);
    const pts = Number(buf.readBigUInt64LE(o + 4));
    frames.push({ tu: buf.subarray(o + 12, o + 12 + size), pts });
    o += 12 + size;
  }
  return { width, height, den, frames };
}

// ---- LEB128 (matches werift's decoder/encoder).
function lebDec(buf, off) {
  let v = 0, n = 0;
  for (let i = 0; i < 8; i++) { const b = buf[off + i]; v |= (b & 0x7f) << (i * 7); n++; if (!(b & 0x80)) break; }
  return [v >>> 0, n];
}
function lebEnc(v) {
  const out = [];
  do { let b = v & 0x7f; v >>>= 7; if (v) b |= 0x80; out.push(b); } while (v);
  return Buffer.from(out);
}

// ---- Split a low-overhead-bitstream temporal unit into individual OBUs (header byte + optional ext + payload).
function parseObus(tu) {
  const obus = [];
  let o = 0;
  while (o < tu.length) {
    const b0 = tu[o];
    const type = (b0 >> 3) & 0xf;
    const ext = (b0 >> 2) & 1;
    const hasSize = (b0 >> 1) & 1;
    if (ext) throw new Error("OBU extension byte unsupported in this proof (testsrc AV1 is single-layer)");
    let p = o + 1;
    let size;
    if (hasSize) { const [sz, n] = lebDec(tu, p); size = sz; p += n; } else { size = tu.length - p; }
    obus.push({ type, headerByte: b0, payload: tu.subarray(p, p + size) });
    o = p + size;
  }
  return obus;
}

// ---- Build spec-conformant AV1 RTP payloads for one TU. OBU elements carry obu_has_size_field=0 (the RTP
// element length field delimits them), matching what werift's AV1Obu.deSerialize/getFrame expects. werift's
// deSerialize needs W∈{1,2,3}, so chunk into ≤3 OBUs per packet; marker (caller) lands on the last packet.
function buildRtpPayloads(obus, isKey) {
  const chunks = [];
  for (let i = 0; i < obus.length; i += 3) chunks.push(obus.slice(i, i + 3));
  return chunks.map((chunk, ci) => {
    const W = chunk.length;
    const N = ci === 0 && isKey ? 1 : 0;
    const aggHeader = Buffer.from([((W & 3) << 4) | (N << 3)]); // Z=Y=0
    const parts = [aggHeader];
    chunk.forEach((obu, idx) => {
      const element = Buffer.concat([Buffer.from([obu.headerByte & ~0x02]), obu.payload]); // clear has_size
      if (idx < chunk.length - 1) parts.push(lebEnc(element.length)); // sized element (not the last)
      parts.push(element);
    });
    return Buffer.concat(parts);
  });
}

function ffprobe(path) {
  const r = spawnSync("ffprobe", ["-v", "error", "-select_streams", "v:0", "-count_packets",
    "-show_entries", "stream=codec_name,width,height,nb_read_packets", "-of", "default=nk=1:nw=1", path], { encoding: "utf8" });
  return r.stdout.trim().split("\n");
}

function main() {
  const { width, height, frames } = parseIvf(readFileSync(refPath));
  log("source", { width, height, tus: frames.length });

  const assembler = new Av1FrameAssembler({ deSerialize: AV1RtpPayload.deSerialize, getFrame: AV1RtpPayload.getFrame });
  const writer = new Av1IvfWriter({ width, height, timebaseDen: 90000 });

  let emitted = 0, packets = 0;
  for (const { tu, pts } of frames) {
    const obus = parseObus(tu);
    const isKey = obus.some((o) => o.type === 1); // OBU_SEQUENCE_HEADER present → coded-video-sequence start
    const payloads = buildRtpPayloads(obus, isKey);
    payloads.forEach((pl, i) => {
      packets++;
      const marker = i === payloads.length - 1; // marker closes the temporal unit
      const frame = assembler.push(pl, marker);
      if (frame) { writer.write(frame, pts); emitted++; }
    });
  }
  log("depacketized", { packets, emitted, dropped: assembler.dropped, keyframes: assembler.keyframes });

  const ivf = writer.finalize();
  if (!ivf) throw new Error("PROOF FAIL: no frames assembled");
  writeFileSync(outIvf, ivf);

  const rw = spawnSync("ffmpeg", ["-hide_banner", "-v", "error", "-i", outIvf, "-c:v", "copy", "-f", "webm", "-y", outWebm]);
  if (rw.status !== 0) throw new Error(`PROOF FAIL: ffmpeg rewrap exit ${rw.status}: ${rw.stderr}`);

  const [ivfCodec, ivfW, ivfH, ivfPk] = ffprobe(outIvf);
  const [webmCodec, , , webmPk] = ffprobe(outWebm);
  log("ivf-probe", { codec: ivfCodec, width: ivfW, height: ivfH, packets: ivfPk });
  log("webm-probe", { codec: webmCodec, packets: webmPk });

  const ok = ivfCodec === "av1" && webmCodec === "av1" && Number(ivfPk) === frames.length && Number(webmPk) === frames.length;
  log(ok ? "PROOF PASS" : "PROOF FAIL", { expectedFrames: frames.length, ivfPk, webmPk });
  process.exit(ok ? 0 : 1);
}
main();
