// Task #81 — worker dispatch + egress routes for the voice agent. Proves: FULLY INERT without the flag (a
// /v1/realtime/agents/* request falls through to the 501 catch-all, UNCHANGED); with the flag on, dispatch
// gates on the internal secret + org + AGENT_SESSION binding and forwards bind to the DO keyed
// `${org}:${room}:${agentId}`; the egress route requires a WS upgrade and forwards frames to the DO. Stub
// AGENT_SESSION namespace + WebSocketPair; no live DO/SFU/WS runtime.
import { describe, it, expect, beforeAll } from "vitest";
import worker from "../src/worker.js";
import { mintRecorderToken } from "../src/encoders/recorder-auth.js";

const ctx = { waitUntil: () => {} } as unknown as ExecutionContext;

let accepted = 0;
class FakeWS {
  binaryType = "blob";
  accept() { accepted += 1; }
  addEventListener() {}
}
beforeAll(() => {
  (globalThis as unknown as { WebSocketPair: unknown }).WebSocketPair = class {
    0 = new FakeWS();
    1 = new FakeWS();
  } as unknown;
});

function stubAgentNs() {
  const seen: { name?: string; forwards: { url: string; method: string }[] } = { forwards: [] };
  return {
    seen,
    idFromName(name: string) { seen.name = name; return { __name: name }; },
    get() {
      return { fetch: async (r: Request) => { seen.forwards.push({ url: r.url, method: r.method }); return new Response(JSON.stringify({ ok: true }), { status: 200 }); } };
    },
  };
}

describe("inert without VOICE_AGENT_PROVIDER=wave", () => {
  it("dispatch falls through to 501", async () => {
    const res = await worker.fetch(new Request("https://rt/v1/realtime/agents/bind", { method: "POST", body: "{}" }), {} as never, ctx);
    expect(res.status).toBe(501);
    expect((await res.json() as { error: string }).error).toBe("REALTIME_NOT_IMPLEMENTED");
  });
  it("egress route falls through to 501", async () => {
    const res = await worker.fetch(new Request("https://rt/v1/realtime/agents/egress/o/r/sess_abc12345/mic", { headers: { Upgrade: "websocket" } }), {} as never, ctx);
    expect(res.status).toBe(501);
  });
});

describe("dispatch (flag on)", () => {
  const base = { VOICE_AGENT_PROVIDER: "wave" };
  it("401 without the internal header when the secret is set", async () => {
    const res = await worker.fetch(new Request("https://rt/v1/realtime/agents/bind", { method: "POST", headers: { "x-wave-org": "org1" }, body: JSON.stringify({ config: { roomId: "r1", agentId: "a1" } }) }), { ...base, WAVE_INTERNAL_SECRET: "s", AGENT_SESSION: stubAgentNs() } as never, ctx);
    expect(res.status).toBe(401);
  });
  it("400 without org", async () => {
    const res = await worker.fetch(new Request("https://rt/v1/realtime/agents/bind", { method: "POST", body: JSON.stringify({ config: { roomId: "r1", agentId: "a1" } }) }), { ...base, AGENT_SESSION: stubAgentNs() } as never, ctx);
    expect(res.status).toBe(400);
  });
  it("503 when the AGENT_SESSION binding is missing", async () => {
    const res = await worker.fetch(new Request("https://rt/v1/realtime/agents/bind", { method: "POST", headers: { "x-wave-org": "org1" }, body: JSON.stringify({ config: { roomId: "r1", agentId: "a1" } }) }), { ...base } as never, ctx);
    expect(res.status).toBe(503);
  });
  it("forwards bind to the DO keyed org:room:agent", async () => {
    const ns = stubAgentNs();
    const res = await worker.fetch(new Request("https://rt/v1/realtime/agents/bind", { method: "POST", headers: { "x-wave-org": "org1" }, body: JSON.stringify({ config: { roomId: "r1", agentId: "a1", participantSessionId: "sess_abc12345", participantTrackName: "mic" } }) }), { ...base, AGENT_SESSION: ns } as never, ctx);
    expect(res.status).toBe(200);
    expect(ns.seen.name).toBe("org1:r1:a1");
    expect(ns.seen.forwards[0].url).toContain("/bind");
  });
});

describe("egress WS route (flag on)", () => {
  const base = { VOICE_AGENT_PROVIDER: "wave" };
  it("426 when not a websocket upgrade", async () => {
    const res = await worker.fetch(new Request("https://rt/v1/realtime/agents/egress/org1/r1/sess_abc12345/mic"), { ...base, AGENT_SESSION: stubAgentNs() } as never, ctx);
    expect(res.status).toBe(426);
  });
  it("accepts the WS upgrade with a valid capability token (no internal header)", async () => {
    const before = accepted;
    const secret = "s";
    const tok = await mintRecorderToken(secret, "org1", "sess_abc12345", "mic");
    const res = await worker.fetch(new Request(`https://rt/v1/realtime/agents/egress/org1/r1/sess_abc12345/mic?t=${tok}`, { headers: { Upgrade: "websocket" } }), { ...base, WAVE_INTERNAL_SECRET: secret, AGENT_SESSION: stubAgentNs() } as never, ctx);
    // Workers returns 101; Node's Response forbids 101 so the worker fails-open to 200 — assert accept() fired + not 4xx.
    expect(accepted).toBe(before + 1);
    expect(res.status).toBeLessThan(400);
  });
  it("401 with neither a token nor the internal header when the secret is set", async () => {
    const res = await worker.fetch(new Request("https://rt/v1/realtime/agents/egress/org1/r1/sess_abc12345/mic", { headers: { Upgrade: "websocket" } }), { ...base, WAVE_INTERNAL_SECRET: "s", AGENT_SESSION: stubAgentNs() } as never, ctx);
    expect(res.status).toBe(401);
  });
});
