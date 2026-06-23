// RT-R9 P2 — Worker recorder WS route /v1/realtime/recorder/:org/:room/:sessionId/:trackName. Stub ROOM namespace;
// no live DO/WS runtime. Proves: gated behind the internal-secret chokepoint; DORMANT unless RT_RECORD==='1'
// (disarmed → 501, so nothing dials it); non-upgrade → 426; an Upgrade with RT_RECORD='1' → 101 + the DO id is
// keyed `${org}:${room}` — the SAME DO the publish path created the tap in (REGRESSION GUARD: keying by sessionId
// instead routes frames to a tap-less DO and silently records nothing). INERT: the live wrangler default
// (RT_RECORD set but RT_ENCODER managed) still 101s the route but the DO feed is a no-op for managed.
import { describe, it, expect, beforeAll } from "vitest";
import worker from "../src/worker.js";
import { mintRecorderToken } from "../src/encoders/recorder-auth.js";

const ctx = { waitUntil: () => {} } as unknown as ExecutionContext;

// WebSocketPair is a Workers-runtime global absent in the Node test env. Stub it so the 101 upgrade path runs.
// Node's Response ALSO forbids status 101 (Workers allows it) — so we record a server.accept() call as the
// "upgrade reached" signal and the tests assert on that + the DO keying rather than the literal 101 status the
// real Workers runtime produces. The worker swallows the Node Response(101) RangeError fail-open (still a 5xx),
// so we additionally confirm it never 4xx'd and the accept fired.
let accepted = 0;
let lastServer: FakeWS | null = null;
class FakeWS {
  binaryType = "blob"; // CF Workers default — the worker should flip this to "arraybuffer"
  onMessage: ((ev: { data: unknown }) => void) | null = null;
  accept() {
    accepted += 1;
  }
  addEventListener(type: string, fn: (ev: { data: unknown }) => void) {
    if (type === "message") this.onMessage = fn;
  }
}
beforeAll(() => {
  const Pair = class {
    0 = new FakeWS();
    1 = (lastServer = new FakeWS());
  };
  (globalThis as unknown as { WebSocketPair: unknown }).WebSocketPair = Pair as unknown;
});

function stubRoomNamespace() {
  const seen: { name?: string; forwards: Request[] } = { forwards: [] };
  return {
    seen,
    idFromName(name: string) {
      seen.name = name;
      return { __name: name };
    },
    get(_id: unknown) {
      return {
        fetch: async (r: Request) => {
          seen.forwards.push(r);
          return new Response(null, { status: 204 });
        },
      };
    },
  };
}

function env(over: Record<string, unknown> = {}) {
  return { ROOM: stubRoomNamespace(), ...over } as never;
}

const PATH = "/v1/realtime/recorder/org_x/r1/sess_ABC12345/mic"; // :org/:room/:sessionId/:trackName

function req(headers: Record<string, string> = {}): Request {
  return new Request(`https://rt.wave.online${PATH}`, { method: "GET", headers });
}

describe("recorder route — gateway-trust chokepoint", () => {
  it("guard ON + missing x-wave-internal → 401", async () => {
    const res = await worker.fetch(req({ Upgrade: "websocket" }), env({ WAVE_INTERNAL_SECRET: "s", RT_RECORD: "1" }), ctx);
    expect(res.status).toBe(401);
  });
  it("guard ON + correct x-wave-internal + armed + upgrade → server accept (not 4xx)", async () => {
    accepted = 0;
    const res = await worker.fetch(
      req({ Upgrade: "websocket", "x-wave-internal": "s" }),
      env({ WAVE_INTERNAL_SECRET: "s", RT_RECORD: "1" }),
      ctx,
    );
    expect(res.status).toBeLessThan(400); // 101 on Workers; 200 fallback in the Node test env (both = upgraded)
    expect(accepted).toBe(1);
  });
});

describe("recorder route — signed capability token (?t=) authenticates the SFU dial-in", () => {
  it("valid ?t= token + upgrade → accepts auth (server accept, not 401/4xx) — no x-wave-internal needed", async () => {
    accepted = 0;
    const t = await mintRecorderToken("s", "org_x", "sess_ABC12345", "mic");
    const res = await worker.fetch(
      new Request(`https://rt.wave.online${PATH}?t=${t}`, { method: "GET", headers: { Upgrade: "websocket" } }),
      env({ WAVE_INTERNAL_SECRET: "s", RT_RECORD: "1" }),
      ctx,
    );
    expect(res.status).toBeLessThan(400);
    expect(accepted).toBe(1);
  });

  it("no token + no x-wave-internal → 401", async () => {
    const res = await worker.fetch(req({ Upgrade: "websocket" }), env({ WAVE_INTERNAL_SECRET: "s", RT_RECORD: "1" }), ctx);
    expect(res.status).toBe(401);
  });

  it("valid x-wave-internal (no token) still works → server accept", async () => {
    accepted = 0;
    const res = await worker.fetch(
      req({ Upgrade: "websocket", "x-wave-internal": "s" }),
      env({ WAVE_INTERNAL_SECRET: "s", RT_RECORD: "1" }),
      ctx,
    );
    expect(res.status).toBeLessThan(400);
    expect(accepted).toBe(1);
  });

  it("invalid token + no header → 401", async () => {
    const res = await worker.fetch(
      new Request(`https://rt.wave.online${PATH}?t=999999999999.tampered`, { method: "GET", headers: { Upgrade: "websocket" } }),
      env({ WAVE_INTERNAL_SECRET: "s", RT_RECORD: "1" }),
      ctx,
    );
    expect(res.status).toBe(401);
  });

  it("token minted for a DIFFERENT track → 401 (scoped, no cross-use)", async () => {
    const t = await mintRecorderToken("s", "org_x", "sess_ABC12345", "speaker"); // PATH track is 'mic'
    const res = await worker.fetch(
      new Request(`https://rt.wave.online${PATH}?t=${t}`, { method: "GET", headers: { Upgrade: "websocket" } }),
      env({ WAVE_INTERNAL_SECRET: "s", RT_RECORD: "1" }),
      ctx,
    );
    expect(res.status).toBe(401);
  });
});

describe("recorder route — DORMANT unless RT_RECORD='1'", () => {
  it("disarmed (no RT_RECORD) → 501 (route does not exist; nothing dials it)", async () => {
    const res = await worker.fetch(req({ Upgrade: "websocket" }), env(), ctx);
    expect(res.status).toBe(501);
  });
  it("RT_RECORD='0' → 501", async () => {
    const res = await worker.fetch(req({ Upgrade: "websocket" }), env({ RT_RECORD: "0" }), ctx);
    expect(res.status).toBe(501);
  });
});

describe("recorder route — upgrade + routing", () => {
  it("armed but NOT an Upgrade request → 426", async () => {
    const res = await worker.fetch(req(), env({ RT_RECORD: "1" }), ctx);
    expect(res.status).toBe(426);
  });
  it("armed + upgrade → upgraded (not 4xx) and DO id keyed `${org}:${room}` (NOT sessionId — the tap's DO)", async () => {
    accepted = 0;
    const ns = stubRoomNamespace();
    const res = await worker.fetch(req({ Upgrade: "websocket" }), env({ RT_RECORD: "1", ROOM: ns }), ctx);
    expect(res.status).toBeLessThan(400);
    expect(accepted).toBe(1);
    expect(ns.seen.name).toBe("org_x:r1"); // regression: must address the publish-path DO (org:room), not org:sessionId
  });
  it("a legacy 3-segment path (no :room) does NOT match the recorder route → 501 fallback (never a tap-less accept)", async () => {
    accepted = 0;
    const res = await worker.fetch(
      new Request("https://rt.wave.online/v1/realtime/recorder/org_x/sess_ABC12345/mic", { method: "GET", headers: { Upgrade: "websocket" } }),
      env({ WAVE_INTERNAL_SECRET: "s", RT_RECORD: "1" }),
      ctx,
    );
    expect(res.status).toBe(501); // unmatched → REALTIME_NOT_IMPLEMENTED fallback, not a recorder accept
    expect(accepted).toBe(0); // and crucially never opened a WS to a tap-less DO
  });
  it("armed + upgrade but no ROOM binding → 400 (loud, not silent)", async () => {
    const res = await worker.fetch(req({ Upgrade: "websocket" }), { RT_RECORD: "1" } as never, ctx);
    expect(res.status).toBe(400);
  });
});

describe("recorder route — binary frame forwarding (REGRESSION: CF delivers binary as Blob, not ArrayBuffer)", () => {
  async function upgrade(ns: ReturnType<typeof stubRoomNamespace>) {
    const waits: Promise<unknown>[] = [];
    const wctx = { waitUntil: (p: Promise<unknown>) => waits.push(p) } as unknown as ExecutionContext;
    await worker.fetch(req({ Upgrade: "websocket", "x-wave-internal": "s" }), env({ WAVE_INTERNAL_SECRET: "s", RT_RECORD: "1", ROOM: ns }), wctx);
    return waits;
  }

  it("requests arraybuffer delivery AND forwards a Blob media frame to the room DO (the live bug: 1221 frames dropped)", async () => {
    const ns = stubRoomNamespace();
    const waits = await upgrade(ns);
    expect(lastServer).not.toBeNull();
    expect(lastServer!.binaryType).toBe("arraybuffer"); // worker asked the runtime for ArrayBuffer delivery
    lastServer!.onMessage!({ data: new Blob([new Uint8Array([1, 2, 3, 4])]) }); // ...but a Blob still forwards
    await Promise.all(waits);
    expect(ns.seen.forwards).toHaveLength(1);
    expect(ns.seen.forwards[0].url).toContain("/recorder-frame?sessionId=sess_ABC12345&trackName=mic");
  });

  it("an ArrayBuffer media frame also forwards", async () => {
    const ns = stubRoomNamespace();
    const waits = await upgrade(ns);
    lastServer!.onMessage!({ data: new Uint8Array([5, 6, 7]).buffer });
    await Promise.all(waits);
    expect(ns.seen.forwards).toHaveLength(1);
  });

  it("a text/keepalive (string) message is NOT forwarded", async () => {
    const ns = stubRoomNamespace();
    const waits = await upgrade(ns);
    lastServer!.onMessage!({ data: "keepalive" });
    await Promise.all(waits);
    expect(ns.seen.forwards).toHaveLength(0);
  });
});
