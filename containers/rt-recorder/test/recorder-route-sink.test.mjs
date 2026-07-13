import { describe, it, expect } from "vitest";
import { makeRecorderRouteSink } from "../server/recorder-route-sink.mjs";

/** Fake fetch that DRAINS the async-iterable request body (as the Worker runtime would) and returns a result. */
function drainFetch(status = 200, resultBody = { key: "org/realtime-recordings/s/recording.webm", bytes: 0 }) {
  const seen = { url: null, method: null, headers: null, chunks: [] };
  const impl = async (url, init) => {
    seen.url = url;
    seen.method = init.method;
    seen.headers = init.headers;
    for await (const part of init.body) seen.chunks.push(Buffer.from(part));
    const bytes = seen.chunks.reduce((n, c) => n + c.length, 0);
    return {
      ok: status < 400,
      status,
      text: async () => JSON.stringify({ ...resultBody, bytes }),
    };
  };
  impl.seen = seen;
  return impl;
}

describe("makeRecorderRouteSink — streaming PUT to the recorder-ingest route", () => {
  it("streams parts in order over ONE PUT and returns the DO receipt", async () => {
    const f = drainFetch();
    const sink = makeRecorderRouteSink({
      endpoint: "https://rt.wave.online/v1/realtime/recording-ingest/org/room/sess/vid?t=TOKEN",
      org: "org",
      sessionId: "sess",
      fetchImpl: f,
    });
    await sink.write(Buffer.from("WEBM-"));
    await sink.write(Buffer.from("chunk2-"));
    await sink.write(Buffer.from("chunk3"));
    const receipt = await sink.finalize();

    expect(f.seen.method).toBe("PUT");
    expect(f.seen.url).toContain("recording-ingest/org/room/sess/vid?t=TOKEN");
    expect(Buffer.concat(f.seen.chunks).toString()).toBe("WEBM-chunk2-chunk3"); // in order, exact
    expect(receipt.key).toBe("org/realtime-recordings/s/recording.webm");
    expect(receipt.bytes).toBe(18);
  });

  it("never opens a PUT when nothing is written (no empty object)", async () => {
    const f = drainFetch();
    const sink = makeRecorderRouteSink({ endpoint: "https://x/y", org: "o", sessionId: "s", fetchImpl: f });
    const r = await sink.finalize();
    expect(r).toBe(null);
    expect(f.seen.method).toBe(null); // fetch never called
  });

  it("throws an actionable error on a non-2xx ingest response", async () => {
    const f = drainFetch(500, {});
    const sink = makeRecorderRouteSink({ endpoint: "https://x/y", org: "o", sessionId: "s", fetchImpl: f });
    await sink.write(Buffer.from("data"));
    await expect(sink.finalize()).rejects.toThrow(/recorder-ingest 500/);
  });

  it("requires a pre-signed endpoint", () => {
    expect(() => makeRecorderRouteSink({ org: "o", sessionId: "s" })).toThrow(/endpoint/);
  });

  it("carries the token in the URL (pre-signed by the orchestrator, recorder holds no secret)", async () => {
    const f = drainFetch();
    const sink = makeRecorderRouteSink({ endpoint: "https://x/ingest?t=ABC", org: "o", sessionId: "s", fetchImpl: f });
    await sink.write(Buffer.from("d"));
    await sink.finalize();
    expect(f.seen.url).toContain("?t=ABC");
  });
});
