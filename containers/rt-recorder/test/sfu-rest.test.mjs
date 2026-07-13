import { describe, it, expect } from "vitest";
import { makeSfuClient } from "../server/sfu-rest.mjs";

/** A fake fetch that records calls and returns scripted responses keyed by URL suffix. */
function fakeFetch(routes) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url, method: init.method, headers: init.headers, body: init.body });
    for (const [suffix, resp] of Object.entries(routes)) {
      if (url.endsWith(suffix)) {
        return {
          ok: resp.status < 400,
          status: resp.status,
          text: async () => JSON.stringify(resp.body ?? {}),
        };
      }
    }
    return { ok: false, status: 404, text: async () => "no route" };
  };
  impl.calls = calls;
  return impl;
}

const CREDS = { appId: "abc123", appSecret: "sekret-value", sfuBase: "https://sfu.example/v1" };

describe("makeSfuClient — the proven three-call subscribe handshake", () => {
  it("createSession posts the offer and returns the parsed session", async () => {
    const f = fakeFetch({ "/sessions/new": { status: 201, body: { sessionId: "sub-1", sessionDescription: { type: "answer", sdp: "x" } } } });
    const client = makeSfuClient({ ...CREDS, fetchImpl: f });
    const s = await client.createSession("v=0 offer");
    expect(s.sessionId).toBe("sub-1");
    expect(f.calls[0].url).toBe("https://sfu.example/v1/apps/abc123/sessions/new");
    expect(f.calls[0].method).toBe("POST");
    expect(JSON.parse(f.calls[0].body).sessionDescription).toEqual({ type: "offer", sdp: "v=0 offer" });
  });

  it("pullRemoteTrack requests the remote track and surfaces the renegotiation offer", async () => {
    const f = fakeFetch({ "/tracks/new": { status: 200, body: { requiresImmediateRenegotiation: true, sessionDescription: { type: "offer", sdp: "reneg" } } } });
    const client = makeSfuClient({ ...CREDS, fetchImpl: f });
    const t = await client.pullRemoteTrack("sub-1", "pub-9", "cam");
    expect(t.requiresImmediateRenegotiation).toBe(true);
    const sent = JSON.parse(f.calls[0].body);
    expect(sent.tracks[0]).toEqual({ location: "remote", sessionId: "pub-9", trackName: "cam" });
  });

  it("renegotiate PUTs the answer and returns the status", async () => {
    const f = fakeFetch({ "/renegotiate": { status: 200 } });
    const client = makeSfuClient({ ...CREDS, fetchImpl: f });
    const status = await client.renegotiate("sub-1", "v=0 answer");
    expect(status).toBe(200);
    expect(f.calls[0].method).toBe("PUT");
  });

  it("throws an actionable error WITHOUT leaking the Bearer secret on a non-2xx", async () => {
    const f = fakeFetch({ "/sessions/new": { status: 401, body: { error: "bad app" } } });
    const client = makeSfuClient({ ...CREDS, fetchImpl: f });
    await expect(client.createSession("x")).rejects.toThrow(/SFU POST .*401/);
    await expect(client.createSession("x")).rejects.not.toThrow(/sekret-value/);
  });

  it("carries the Bearer secret in the Authorization header (not the URL/body)", async () => {
    const f = fakeFetch({ "/sessions/new": { status: 201, body: { sessionId: "s" } } });
    const client = makeSfuClient({ ...CREDS, fetchImpl: f });
    await client.createSession("x");
    expect(f.calls[0].headers.Authorization).toBe("Bearer sekret-value");
    expect(f.calls[0].url).not.toContain("sekret-value");
  });

  it("requires appId + appSecret", () => {
    expect(() => makeSfuClient({ appId: "", appSecret: "x" })).toThrow(/required/);
  });

  it("trims trailing slashes from sfuBase (linear, ReDoS-safe) without doubling the path slash", async () => {
    const f = fakeFetch({ "/sessions/new": { status: 201, body: { sessionId: "s" } } });
    const client = makeSfuClient({ ...CREDS, sfuBase: "https://sfu.example/v1///", fetchImpl: f });
    await client.createSession("x");
    expect(f.calls[0].url).toBe("https://sfu.example/v1/apps/abc123/sessions/new");
  });
});
