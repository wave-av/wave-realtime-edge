// W1 SLICE-2B O1 (wre#287) — the concrete `CfStreamEgressClient` adapter. Proves it: builds the correct real CF
// Live Output request (URL shape, method, auth header, {url, streamKey} body split from the combined
// rtmp(s)://host/app/streamKey the passthrough backend already carries), derives the live-input uid from a
// bridged `cfstream:{uid}` sessionId (never guesses), and maps a non-2xx CF reply / malformed input to a typed
// `{ok:false}` — never a throw into the media path. Pure: injected fake fetch, no real network.
import { describe, it, expect } from "vitest";
import {
  CfStreamEgressLiveOutputClient,
  deleteOutput,
  deriveLiveInputId,
  splitRtmpUrl,
} from "../src/egress-cf-stream-live-output-client.js";

const UID = "28064cd43cee30dd62c728da2152c61d";
const SESSION_ID = `cfstream:${UID}`;

/** A fake CF `fetch`: canned create-output reply, records every call. */
function fakeFetch(reply: { status?: number; body?: unknown } = {}): typeof fetch & {
  calls: { url: string; method: string; headers: Record<string, string>; body: unknown }[];
} {
  const calls: { url: string; method: string; headers: Record<string, string>; body: unknown }[] = [];
  const fn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    const headers = Object.fromEntries(new Headers(init?.headers).entries());
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ url, method, headers, body });
    const status = reply.status ?? 200;
    const respBody = reply.body ?? { success: true, result: { uid: "lo-out-1" } };
    return new Response(JSON.stringify(respBody), { status });
  }) as typeof fetch;
  (fn as unknown as { calls: unknown }).calls = calls;
  return fn as typeof fetch & { calls: typeof calls };
}

describe("deriveLiveInputId", () => {
  it("recovers the uid from a bridged cfstream room", () => {
    expect(deriveLiveInputId(SESSION_ID)).toBe(UID);
  });
  it("returns null (never guesses) for a non-bridged sessionId", () => {
    expect(deriveLiveInputId("sess-1")).toBeNull();
    expect(deriveLiveInputId("cfstream:not-hex")).toBeNull();
  });
});

describe("splitRtmpUrl", () => {
  it("splits host/app/key into {url, streamKey}", () => {
    expect(splitRtmpUrl("rtmp://live.example/app/key")).toEqual({ url: "rtmp://live.example/app", streamKey: "key" });
  });
  it("returns null for an unparseable url or one with no key segment", () => {
    expect(splitRtmpUrl("not a url")).toBeNull();
    expect(splitRtmpUrl("rtmp://live.example/")).toBeNull();
  });
});

describe("CfStreamEgressLiveOutputClient.provisionOutput", () => {
  it("builds the correct CF request: URL (accountId + derived liveInputId), POST, bearer auth, {url,streamKey} body", async () => {
    const fetchFn = fakeFetch();
    const resolveHost = async (h: string) => (h === "a.rtmp.youtube.com" ? ["93.184.216.34"] : []);
    const client = new CfStreamEgressLiveOutputClient({ accountId: "acct123", apiToken: "tok-abc", fetchFn, resolveHost });
    const result = await client.provisionOutput({
      sessionId: SESSION_ID,
      trackName: "cam-1",
      output: "simulcast",
      rtmpDestination: "rtmp://a.rtmp.youtube.com/live2/ykey-9",
    });
    expect(result).toEqual({ ok: true, outputId: "lo-out-1" });
    expect(fetchFn.calls).toHaveLength(1);
    const call = fetchFn.calls[0];
    expect(call.url).toBe(`https://api.cloudflare.com/client/v4/accounts/acct123/stream/live_inputs/${UID}/outputs`);
    expect(call.method).toBe("POST");
    expect(call.headers.authorization).toBe("Bearer tok-abc");
    expect(call.body).toEqual({ url: "rtmp://a.rtmp.youtube.com/live2", streamKey: "ykey-9" });
  });

  it("maps a non-2xx CF reply to a typed error, never a throw", async () => {
    const fetchFn = fakeFetch({ status: 401, body: { success: false, errors: [{ code: 10000, message: "unauthorized" }] } });
    const resolveHost = async (h: string) => (h === "live.example" ? ["93.184.216.34"] : []);
    const client = new CfStreamEgressLiveOutputClient({ accountId: "acct123", apiToken: "bad-tok", fetchFn, resolveHost });
    const result = await client.provisionOutput({
      sessionId: SESSION_ID,
      trackName: "cam-1",
      output: "simulcast",
      rtmpDestination: "rtmp://live.example/app/key",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(401);
      expect(result.reason).toMatch(/unauthorized/);
    }
  });

  it("refuses (never calls fetch) when sessionId is not a bridged cfstream room", async () => {
    const fetchFn = fakeFetch();
    const client = new CfStreamEgressLiveOutputClient({ accountId: "acct123", apiToken: "tok", fetchFn });
    const result = await client.provisionOutput({
      sessionId: "not-bridged",
      trackName: "cam-1",
      output: "simulcast",
      rtmpDestination: "rtmp://live.example/app/key",
    });
    expect(result.ok).toBe(false);
    expect(fetchFn.calls).toHaveLength(0);
  });

  it("refuses a record output (no external destination) — this adapter serves simulcast only", async () => {
    const fetchFn = fakeFetch();
    const client = new CfStreamEgressLiveOutputClient({ accountId: "acct123", apiToken: "tok", fetchFn });
    const result = await client.provisionOutput({ sessionId: SESSION_ID, trackName: "cam-1", output: "record" });
    expect(result.ok).toBe(false);
    expect(fetchFn.calls).toHaveLength(0);
  });

  // wre#320 sec-review MEDIUM fix: `provisionOutput` is the SHARED chokepoint both the passthrough backend and
  // the O1 arm funnel into — prove the SSRF-at-connect re-check lives HERE, not only on the arm's own call path.
  describe("SSRF-at-connect chokepoint (wre#320 sec-review)", () => {
    it("refuses (403, no CF fetch) when rtmpDestination resolves to a private/metadata IP", async () => {
      const fetchFn = fakeFetch();
      const rebindResolver = async (h: string) => (h === "internal.example" ? ["169.254.169.254"] : []);
      const client = new CfStreamEgressLiveOutputClient({
        accountId: "acct123",
        apiToken: "tok",
        fetchFn,
        resolveHost: rebindResolver,
      });
      const result = await client.provisionOutput({
        sessionId: SESSION_ID,
        trackName: "cam-1",
        output: "simulcast",
        rtmpDestination: "rtmp://internal.example:1935/app/key",
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.status).toBe(403);
        expect(result.reason).toMatch(/SSRF-at-connect/);
      }
      expect(fetchFn.calls).toHaveLength(0);
    });

    it("provisions (calls CF) when rtmpDestination resolves to a public IP", async () => {
      const fetchFn = fakeFetch();
      const publicResolver = async (h: string) => (h === "live.example.com" ? ["93.184.216.34"] : []);
      const client = new CfStreamEgressLiveOutputClient({
        accountId: "acct123",
        apiToken: "tok",
        fetchFn,
        resolveHost: publicResolver,
      });
      const result = await client.provisionOutput({
        sessionId: SESSION_ID,
        trackName: "cam-1",
        output: "simulcast",
        rtmpDestination: "rtmp://live.example.com:1935/app/key",
      });
      expect(result).toEqual({ ok: true, outputId: "lo-out-1" });
      expect(fetchFn.calls).toHaveLength(1);
    });
  });
});

describe("deleteOutput — W1 teardown half", () => {
  function fakeDeleteFetch(status: number): typeof fetch & { calls: { url: string; method: string }[] } {
    const calls: { url: string; method: string }[] = [];
    const fn = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), method: (init?.method ?? "GET").toUpperCase() });
      return new Response(status >= 400 ? JSON.stringify({ success: false, errors: [{ code: 9, message: "nope" }] }) : null, { status });
    }) as typeof fetch;
    (fn as unknown as { calls: unknown }).calls = calls;
    return fn as typeof fetch & { calls: typeof calls };
  }

  it("DELETEs the exact CF outputs URL with bearer auth on success", async () => {
    const fetchFn = fakeDeleteFetch(200);
    const result = await deleteOutput(fetchFn, "acct123", "tok", UID, "lo-out-1");
    expect(result).toEqual({ ok: true, notFound: false });
    expect(fetchFn.calls).toEqual([
      { url: `https://api.cloudflare.com/client/v4/accounts/acct123/stream/live_inputs/${UID}/outputs/lo-out-1`, method: "DELETE" },
    ]);
  });

  it("is idempotent — a CF 404 is a SUCCESS shape (already gone), never a refusal", async () => {
    const fetchFn = fakeDeleteFetch(404);
    const result = await deleteOutput(fetchFn, "acct123", "tok", UID, "lo-gone");
    expect(result).toEqual({ ok: true, notFound: true });
  });

  it("surfaces any other non-2xx as a typed refusal, never a throw", async () => {
    const fetchFn = fakeDeleteFetch(401);
    const result = await deleteOutput(fetchFn, "acct123", "tok", UID, "lo-out-1");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(401);
  });

  it("maps a thrown fetch error to a typed 502 refusal, never a throw", async () => {
    const throwingFetch = (async () => {
      throw new Error("network down");
    }) as typeof fetch;
    const result = await deleteOutput(throwingFetch, "acct123", "tok", UID, "lo-out-1");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(502);
  });
});
