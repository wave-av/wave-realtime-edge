// E3n (wre#290) Axis B1 — CF Stream video listing, MP4 download provisioning, and the R2 byte pull. Fail-safe
// contract: every helper returns null on ANY failure (never throws), so the sweep can never mark a partial
// pull registered.
import { describe, it, expect } from "vitest";
import {
  e3nRecordingKey,
  isCompletedRecording,
  listCfVideosForLiveInput,
  pullCfRecordingBytes,
  requestCfDownloadUrl,
  type CfVideoSummary,
} from "../src/e3n-recording-pull.js";

function fakeR2(): { put: (k: string, v: unknown, o?: unknown) => Promise<void>; store: Map<string, unknown> } {
  const store = new Map<string, unknown>();
  return {
    store,
    async put(k, v) {
      store.set(k, v);
    },
  };
}

describe("isCompletedRecording", () => {
  it("true only for readyToStream + state ready", () => {
    const base: CfVideoSummary = { uid: "u", liveInput: "l", readyToStream: true, state: "ready", duration: 10, created: null };
    expect(isCompletedRecording(base)).toBe(true);
    expect(isCompletedRecording({ ...base, readyToStream: false })).toBe(false);
    expect(isCompletedRecording({ ...base, state: "inprogress" })).toBe(false);
    expect(isCompletedRecording({ ...base, state: null })).toBe(false);
  });
});

describe("listCfVideosForLiveInput", () => {
  it("parses a successful list into narrowed summaries", async () => {
    const fetchFn = (async () =>
      new Response(
        JSON.stringify({
          success: true,
          result: [
            { uid: "v1", liveInput: "in1", readyToStream: true, status: { state: "ready" }, duration: 30, created: "2026-01-01" },
            { uid: "v2", liveInput: "in1", readyToStream: false, status: { state: "inprogress" } },
          ],
        }),
        { status: 200 },
      )) as typeof fetch;
    const out = await listCfVideosForLiveInput(fetchFn, "acct", "tok", "in1");
    expect(out).toHaveLength(2);
    expect(out?.[0]).toMatchObject({ uid: "v1", readyToStream: true, state: "ready" });
  });

  it("returns null on non-2xx / network error / unparseable body (never an invented empty list)", async () => {
    const err = (async () => new Response("boom", { status: 500 })) as typeof fetch;
    expect(await listCfVideosForLiveInput(err, "a", "t", "u")).toBeNull();
    const throws = (async () => {
      throw new Error("net");
    }) as typeof fetch;
    expect(await listCfVideosForLiveInput(throws, "a", "t", "u")).toBeNull();
    const badJson = (async () => new Response("not json", { status: 200 })) as typeof fetch;
    expect(await listCfVideosForLiveInput(badJson, "a", "t", "u")).toBeNull();
  });
});

describe("requestCfDownloadUrl", () => {
  it("ready:true with a url once CF's download job settles", async () => {
    const fetchFn = (async () =>
      new Response(JSON.stringify({ success: true, result: { default: { status: "ready", url: "https://cf.example/dl.mp4" } } }), {
        status: 200,
      })) as typeof fetch;
    const res = await requestCfDownloadUrl(fetchFn, "a", "t", "v1");
    expect(res).toEqual({ ready: true, url: "https://cf.example/dl.mp4" });
  });

  it("ready:false while CF is still muxing (distinct from a hard failure)", async () => {
    const fetchFn = (async () =>
      new Response(JSON.stringify({ success: true, result: { default: { status: "inprogress", url: null } } }), { status: 200 })) as typeof fetch;
    const res = await requestCfDownloadUrl(fetchFn, "a", "t", "v1");
    expect(res).toEqual({ ready: false, url: null });
  });

  it("null on a hard CF failure", async () => {
    const fetchFn = (async () => new Response("nope", { status: 503 })) as typeof fetch;
    expect(await requestCfDownloadUrl(fetchFn, "a", "t", "v1")).toBeNull();
  });
});

describe("pullCfRecordingBytes", () => {
  it("streams a ready https url into R2 at the given key", async () => {
    const fetchFn = (async () =>
      new Response("bytes", { status: 200, headers: { "content-length": "5" } })) as typeof fetch;
    const r2 = fakeR2();
    const res = await pullCfRecordingBytes(fetchFn, "https://cf.example/dl.mp4", r2 as never, "org1/e3n-recordings/v1/recording.mp4");
    expect(res).toEqual({ bytes: 5 });
    expect(r2.store.has("org1/e3n-recordings/v1/recording.mp4")).toBe(true);
  });

  it("rejects an unsafe URL (SSRF guard) without ever calling fetch/R2", async () => {
    let called = false;
    const fetchFn = (async () => {
      called = true;
      return new Response("x", { status: 200 });
    }) as typeof fetch;
    const r2 = fakeR2();
    const res = await pullCfRecordingBytes(fetchFn, "http://169.254.169.254/dl.mp4", r2 as never, "org1/e3n-recordings/v1/recording.mp4");
    expect(res).toBeNull();
    expect(called).toBe(false);
    expect(r2.store.size).toBe(0);
  });

  it("null on a non-2xx fetch, a network error, or an R2 put failure — never a partial object", async () => {
    const nonOk = (async () => new Response("no", { status: 404 })) as typeof fetch;
    expect(await pullCfRecordingBytes(nonOk, "https://cf.example/dl.mp4", fakeR2() as never, "k")).toBeNull();

    const throws = (async () => {
      throw new Error("net");
    }) as typeof fetch;
    expect(await pullCfRecordingBytes(throws, "https://cf.example/dl.mp4", fakeR2() as never, "k")).toBeNull();

    const ok = (async () => new Response("bytes", { status: 200 })) as typeof fetch;
    const failingR2 = {
      async put() {
        throw new Error("r2 boom");
      },
    };
    expect(await pullCfRecordingBytes(ok, "https://cf.example/dl.mp4", failingR2 as never, "k")).toBeNull();
  });
});

describe("e3nRecordingKey", () => {
  it("is org-prefixed and deterministic", () => {
    expect(e3nRecordingKey("org-123", "vid-abc")).toBe("org-123/e3n-recordings/vid-abc/recording.mp4");
    expect(e3nRecordingKey("org-123", "vid-abc")).toBe(e3nRecordingKey("org-123", "vid-abc"));
  });
});
