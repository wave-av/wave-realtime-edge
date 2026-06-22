// RT-R9 P2 — Worker recorder WS route /v1/realtime/recorder/:org/:sessionId/:trackName. Stub ROOM namespace;
// no live DO/WS runtime. Proves: gated behind the internal-secret chokepoint; DORMANT unless RT_RECORD==='1'
// (disarmed → 501, so nothing dials it); non-upgrade → 426; an Upgrade with RT_RECORD='1' → 101 + the DO id is
// keyed `${org}:${sessionId}` (per-org isolation). INERT: the live wrangler default (RT_RECORD set but
// RT_ENCODER managed) still 101s the route but the DO feed is a no-op for managed — covered in orchestration.
import { describe, it, expect, beforeAll } from "vitest";
import worker from "../src/worker.js";

const ctx = { waitUntil: () => {} } as unknown as ExecutionContext;

// WebSocketPair is a Workers-runtime global absent in the Node test env. Stub it so the 101 upgrade path runs.
// Node's Response ALSO forbids status 101 (Workers allows it) — so we record a server.accept() call as the
// "upgrade reached" signal and the tests assert on that + the DO keying rather than the literal 101 status the
// real Workers runtime produces. The worker swallows the Node Response(101) RangeError fail-open (still a 5xx),
// so we additionally confirm it never 4xx'd and the accept fired.
let accepted = 0;
class FakeWS {
  accept() {
    accepted += 1;
  }
  addEventListener() {}
}
beforeAll(() => {
  const Pair = class {
    0 = new FakeWS();
    1 = new FakeWS();
  };
  (globalThis as unknown as { WebSocketPair: unknown }).WebSocketPair = Pair as unknown;
});

function stubRoomNamespace() {
  const seen: { name?: string } = {};
  return {
    seen,
    idFromName(name: string) {
      seen.name = name;
      return { __name: name };
    },
    get(_id: unknown) {
      return { fetch: async () => new Response(null, { status: 204 }) };
    },
  };
}

function env(over: Record<string, unknown> = {}) {
  return { ROOM: stubRoomNamespace(), ...over } as never;
}

const PATH = "/v1/realtime/recorder/org_x/sess_ABC12345/mic";

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
  it("armed + upgrade → upgraded (not 4xx) and DO id keyed `${org}:${sessionId}`", async () => {
    accepted = 0;
    const ns = stubRoomNamespace();
    const res = await worker.fetch(req({ Upgrade: "websocket" }), env({ RT_RECORD: "1", ROOM: ns }), ctx);
    expect(res.status).toBeLessThan(400);
    expect(accepted).toBe(1);
    expect(ns.seen.name).toBe("org_x:sess_ABC12345");
  });
  it("armed + upgrade but no ROOM binding → 400 (loud, not silent)", async () => {
    const res = await worker.fetch(req({ Upgrade: "websocket" }), { RT_RECORD: "1" } as never, ctx);
    expect(res.status).toBe(400);
  });
});
