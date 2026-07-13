// #151 — Worker hosted recorder INGEST route: PUT /v1/realtime/recording-ingest/:org/:room/:sessionId/:trackName.
// Stubs the ROOM namespace (no live DO). Proves: gated behind the internal-secret chokepoint; DUAL-auth (a valid
// pre-signed capability token OR x-wave-internal); DORMANT unless RECORDER_INGEST_ENABLED (disarmed → 501, so the
// surface does not exist); armed+authed → the body streams to the DO keyed `${org}:${room}` (the SAME DO that
// owns the session's canonical object) and the DO's receipt passes straight through; bad path segment → 400.
import { describe, it, expect } from "vitest";
import worker from "../src/worker.js";
import { mintRecorderToken } from "../src/encoders/recorder-auth.js";

const ctx = { waitUntil: () => {} } as unknown as ExecutionContext;

function stubRoomNamespace(receipt: unknown = { key: "org_x/realtime-recordings/sess_ABC12345/recording.webm", bytes: 42, container: "webm" }) {
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
          return Response.json(receipt, { status: 200 });
        },
      };
    },
  };
}

function env(over: Record<string, unknown> = {}) {
  return { ROOM: stubRoomNamespace(), ...over } as never;
}

const PATH = "/v1/realtime/recording-ingest/org_x/r1/sess_ABC12345/vid"; // :org/:room/:sessionId/:trackName

function put(body: string | null, headers: Record<string, string> = {}, path = PATH): Request {
  return new Request(`https://rt.wave.online${path}`, { method: "PUT", headers, body });
}

describe("recording-ingest route — auth + gating", () => {
  it("guard ON + no auth → 401 (before the flag is even consulted)", async () => {
    const res = await worker.fetch(put("data"), env({ WAVE_INTERNAL_SECRET: "s", RECORDER_INGEST_ENABLED: "1" }), ctx);
    expect(res.status).toBe(401);
  });

  it("armed but DISARMED flag (RECORDER_INGEST_ENABLED off) → 501, even with x-wave-internal", async () => {
    const res = await worker.fetch(put("data", { "x-wave-internal": "s" }), env({ WAVE_INTERNAL_SECRET: "s" }), ctx);
    expect(res.status).toBe(501);
  });

  it("invalid path segment → 400", async () => {
    const bad = "/v1/realtime/recording-ingest/org_x/r1/sess_ABC12345/has a space";
    const res = await worker.fetch(put("data", { "x-wave-internal": "s" }, bad), env({ WAVE_INTERNAL_SECRET: "s", RECORDER_INGEST_ENABLED: "1" }), ctx);
    expect(res.status).toBe(400);
  });

  it("armed + x-wave-internal → streams to the DO keyed `${org}:${room}` and passes the receipt through", async () => {
    const ns = stubRoomNamespace();
    const res = await worker.fetch(
      put("WEBMdata", { "x-wave-internal": "s" }),
      { ROOM: ns, WAVE_INTERNAL_SECRET: "s", RECORDER_INGEST_ENABLED: "1" } as never,
      ctx,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ bytes: 42, container: "webm" });
    expect(ns.seen.name).toBe("org_x:r1"); // SAME DO as publish (org:room), not sessionId
    expect(ns.seen.forwards[0].url).toContain("/recording-ingest?org=org_x&sessionId=sess_ABC12345&trackName=vid");
  });

  it("armed + a valid PRE-SIGNED capability token (no internal header) → authorized (third-party recorder path)", async () => {
    const ns = stubRoomNamespace();
    const tok = await mintRecorderToken("s", "org_x", "sess_ABC12345", "vid");
    const res = await worker.fetch(
      put("WEBMdata", {}, `${PATH}?t=${tok}`),
      { ROOM: ns, WAVE_INTERNAL_SECRET: "s", RECORDER_INGEST_ENABLED: "1" } as never,
      ctx,
    );
    expect(res.status).toBe(200);
    expect(ns.seen.forwards.length).toBe(1);
  });

  it("wrong-scope token → 401 (token bound to a different track)", async () => {
    const tokOther = await mintRecorderToken("s", "org_x", "sess_ABC12345", "OTHERTRACK");
    const res = await worker.fetch(
      put("WEBMdata", {}, `${PATH}?t=${tokOther}`),
      env({ WAVE_INTERNAL_SECRET: "s", RECORDER_INGEST_ENABLED: "1" }),
      ctx,
    );
    expect(res.status).toBe(401);
  });
});
