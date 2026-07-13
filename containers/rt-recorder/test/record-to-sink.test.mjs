import { describe, it, expect } from "vitest";
import { streamFileToSink } from "../server/stream-to-sink.mjs";
import { recordTrackToSink } from "../server/record-to-sink.mjs";

/** In-memory sink implementing the RecordingSink contract; lazy-begins its key on the first non-empty write. */
function memSink() {
  const parts = [];
  let key = null;
  return {
    parts,
    get key() {
      return key;
    },
    async write(part) {
      if (part.length === 0) return;
      if (key === null) key = "org/realtime-recordings/sess/recording.webm"; // lazy-begin on first byte
      parts.push(Buffer.from(part));
    },
    async finalize() {
      return { key, bytes: parts.reduce((n, p) => n + p.length, 0) };
    },
    async abort() {},
  };
}

/** Fake node:fs over an in-memory buffer for streamFileToSink (openSync/readSync/closeSync). */
function fakeFs(bytes) {
  let pos = 0;
  return {
    openSync: () => 1,
    closeSync: () => {},
    readSync: (_fd, buf, off, len) => {
      const n = Math.min(len, bytes.length - pos);
      bytes.copy(buf, off, pos, pos + n);
      pos += n;
      return n;
    },
  };
}

describe("streamFileToSink — file → sink in ordered chunks", () => {
  it("streams the exact bytes in order and lazy-begins the key on the first part", async () => {
    const content = Buffer.from("WEBM" + "a".repeat(5000)); // > one chunk at chunkBytes=1024
    const sink = memSink();
    expect(sink.key).toBe(null); // no key before the first byte (never a 0-byte object)
    await streamFileToSink(fakeFs(content), "/tmp/x.webm", sink, 1024);
    expect(sink.key).toBe("org/realtime-recordings/sess/recording.webm");
    const joined = Buffer.concat(sink.parts);
    expect(joined.equals(content)).toBe(true); // byte-identical, in order
    expect(sink.parts.length).toBeGreaterThan(1); // actually chunked
  });

  it("emits stable slices (reused read buffer must not corrupt earlier parts)", async () => {
    const content = Buffer.concat([Buffer.alloc(1024, 1), Buffer.alloc(1024, 2), Buffer.alloc(512, 3)]);
    const sink = memSink();
    await streamFileToSink(fakeFs(content), "/tmp/x.webm", sink, 1024);
    expect(sink.parts[0].every((b) => b === 1)).toBe(true);
    expect(sink.parts[1].every((b) => b === 2)).toBe(true);
    expect(Buffer.concat(sink.parts).equals(content)).toBe(true);
  });

  it("writes nothing for an empty file (no 0-byte object)", async () => {
    const sink = memSink();
    await streamFileToSink(fakeFs(Buffer.alloc(0)), "/tmp/empty.webm", sink, 1024);
    expect(sink.parts.length).toBe(0);
    expect(sink.key).toBe(null);
  });
});

describe("recordTrackToSink — #153 native-transcode routing (injected fakes, no live SFU/ffmpeg)", () => {
  const fs = { rmSync: () => {} };

  it("werift-safe codec → streams the recorder's WebM to the sink (routed:mediarecorder)", async () => {
    const content = Buffer.from("WEBM" + "b".repeat(2000));
    const sink = memSink();
    const subscribe = async ({ webmPath }) => ({ routed: "mediarecorder", codec: "VP9", webmPath, stats: { frames: 100 } });
    const out = await recordTrackToSink({ recorder: {}, fs: fakeFs(content), tmpPath: "/tmp/x.webm", sink, chunkBytes: 1024, subscribe });
    expect(out.routed).toBe("mediarecorder");
    expect(out.result.bytes).toBe(content.length);
  });

  it("AV1 native input → transcodes to WebM and streams to the SAME sink (routed:native-transcode)", async () => {
    const webm = Buffer.from("WEBM" + "c".repeat(3000));
    const sink = memSink();
    // Recorder routed native + captured an input (a file / the SDP bridge); ffmpeg is faked to "produce" the WebM.
    const subscribe = async () => ({ routed: "native-transcode", codec: "AV1", nativeInput: { input: "/tmp/raw.ivf" }, stats: { pkts: 120 } });
    const transcode = async ({ input, codec, outPath }) => {
      expect(input).toBe("/tmp/raw.ivf");
      expect(codec).toBe("AV1");
      return { outPath, bytes: webm.length, container: "webm", codec: "av1" };
    };
    const out = await recordTrackToSink({ recorder: {}, fs: fakeFs(webm), tmpPath: "/tmp/out.webm", sink, chunkBytes: 1024, subscribe, transcode });
    expect(out.routed).toBe("native-transcode");
    expect(out.codec).toBe("av1"); // H265 would report av1 too; AV1 rewraps to av1
    expect(out.result.bytes).toBe(webm.length); // the transcoded bytes reached the canonical sink
  });

  it("native codec with NO capture bridge → honest signal, sink untouched", async () => {
    const sink = memSink();
    const subscribe = async () => ({ routed: "native-transcode", codec: "H265", reason: "no bridge yet", stats: {} });
    const transcode = async () => { throw new Error("must not transcode without a native input"); };
    const out = await recordTrackToSink({ recorder: {}, fs, tmpPath: "/tmp/x", sink, subscribe, transcode });
    expect(out.routed).toBe("native-transcode");
    expect(out.reason).toBe("no bridge yet");
    expect(sink.parts.length).toBe(0); // nothing written — the caller takes the native path
  });
});
