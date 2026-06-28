// F (#55) Plane-2 direct-ingest bridge control-plane unit tests. Proves the INERT scaffold's load-bearing
// parts with NO live infra: the default-off flag gate, the gateway-trust chokepoint, server-side org (never
// from body), deterministic-room idempotency, control-only dispatch (no media seam), the fail-closed typed
// *_BRIDGE_NOT_ACTIVATED 501 when a binding is absent, the durable pending-requeue on a transient start
// failure, and the cron reconcile. Mirrors stream-bridge.test.ts.
import { describe, it, expect, vi } from "vitest";
import {
  ingestBridgeEnabled,
  asIngestProtocol,
  ingestRoomFor,
  parseIngestStartBody,
  handleIngestBridge,
  reconcileIngestPending,
  maybeHandleIngestBridge,
  BridgeNotActivatedError,
  INGEST_PENDING_PREFIX,
  MAX_INGEST_DISPATCH_ATTEMPTS,
  type IngestBridgeDeps,
  type IngestStartPayload,
} from "../src/ingest-bridge.js";
import { METER_STREAM_BRIDGE_MINUTES } from "../src/whip.js";

const WHIP_EP = "https://api.wave.online/v1/whip/publish";
const KEY_REF = "WHIP_KEY";
const SAFE_ORG = /^[A-Za-z0-9_:-]{1,128}$/;

/** A deps double that records dispatch calls. dispatchStart throws BridgeNotActivatedError if `notActivated`. */
function fakeDeps(opts: { notActivated?: boolean; startThrows?: boolean } = {}): IngestBridgeDeps & {
  starts: IngestStartPayload[];
  stops: Array<{ org: string; protocol: string; room: string }>;
  pending: Array<{ org: string; room: string }>;
  cleared: string[];
} {
  const starts: IngestStartPayload[] = [];
  const stops: Array<{ org: string; protocol: string; room: string }> = [];
  const pending: Array<{ org: string; room: string }> = [];
  const cleared: string[] = [];
  return {
    starts,
    stops,
    pending,
    cleared,
    async dispatchStart(_org, payload) {
      if (opts.notActivated) throw new BridgeNotActivatedError(payload.protocol);
      if (opts.startThrows) throw new Error("container cold");
      starts.push(payload);
    },
    async dispatchStop(org, protocol, room) {
      if (opts.notActivated) throw new BridgeNotActivatedError(protocol);
      stops.push({ org, protocol, room });
    },
    async markPending(payload, org) {
      pending.push({ org, room: payload.room });
    },
    async clearPending(_org, _protocol, room) {
      cleared.push(room);
    },
    log() {},
  };
}

function gateOk(): null {
  return null;
}
function gateDeny(): Response {
  return new Response(JSON.stringify({ error: "UNAUTHORIZED" }), { status: 401 });
}

describe("ingestBridgeEnabled — flag gate (INERT default)", () => {
  it("only 1/true/'true' enable; absent/0/false stay inert", () => {
    expect(ingestBridgeEnabled({})).toBe(false);
    expect(ingestBridgeEnabled({ INGEST_BRIDGE_ENABLED: "0" })).toBe(false);
    expect(ingestBridgeEnabled({ INGEST_BRIDGE_ENABLED: "1" })).toBe(true);
    expect(ingestBridgeEnabled({ INGEST_BRIDGE_ENABLED: true })).toBe(true);
    expect(ingestBridgeEnabled({ INGEST_BRIDGE_ENABLED: "true" })).toBe(true);
  });
});

describe("asIngestProtocol — known protocols only, no default", () => {
  it("accepts srt/rist/rtmp/moq, rejects everything else", () => {
    expect(asIngestProtocol("srt")).toBe("srt");
    expect(asIngestProtocol("rist")).toBe("rist");
    expect(asIngestProtocol("rtmp")).toBe("rtmp");
    expect(asIngestProtocol("moq")).toBe("moq");
    expect(asIngestProtocol("whip")).toBeNull(); // WHIP is Plane-1, not here
    expect(asIngestProtocol("../etc")).toBeNull();
  });
});

describe("ingestRoomFor — deterministic, protocol-namespaced", () => {
  it("one (proto,room) → one stable SFU room; namespaced across protocols", () => {
    expect(ingestRoomFor("srt", "studio-a")).toBe("srt:studio-a");
    expect(ingestRoomFor("srt", "studio-a")).toBe(ingestRoomFor("srt", "studio-a"));
    expect(ingestRoomFor("moq", "studio-a")).not.toBe(ingestRoomFor("srt", "studio-a"));
  });
});

describe("parseIngestStartBody — validate-before-sink", () => {
  it("requires a path-safe room (or streamKey); narrows inbound fields", () => {
    expect(parseIngestStartBody({ room: "r1", inbound: { host: "h", port: 778, extra: "drop" } })).toEqual({
      room: "r1",
      inbound: { host: "h", port: 778 },
    });
    expect(parseIngestStartBody({ streamKey: "sk1" })).toEqual({ room: "sk1", inbound: {} });
    expect("error" in parseIngestStartBody({})).toBe(true);
    expect("error" in parseIngestStartBody({ room: "../bad" })).toBe(true);
    expect("error" in parseIngestStartBody({ room: "srt:r1" })).toBe(true); // ':' is reserved for the namespace separator
  });
});

describe("handleIngestBridge — control-only dispatch, server-side org", () => {
  it("start + activated binding → dispatchStart with full payload, 201", async () => {
    const deps = fakeDeps();
    const res = await handleIngestBridge("start", "srt", "org_a", { room: "r1", inbound: { host: "h", port: 778 } }, WHIP_EP, KEY_REF, deps);
    expect(res.status).toBe(201);
    expect(deps.starts).toHaveLength(1);
    const p = deps.starts[0];
    expect(p).toMatchObject({
      protocol: "srt",
      room: "srt:r1",
      whipEndpoint: WHIP_EP,
      bridgeKeyRef: KEY_REF,
      meter: METER_STREAM_BRIDGE_MINUTES,
      inbound: { host: "h", port: 778 },
    });
    expect(deps.cleared).toContain("srt:r1");
  });

  it("start with binding ABSENT → typed *_BRIDGE_NOT_ACTIVATED 501, NO requeue", async () => {
    const deps = fakeDeps({ notActivated: true });
    const res = await handleIngestBridge("start", "rist", "org_a", { room: "r1" }, WHIP_EP, KEY_REF, deps);
    expect(res.status).toBe(501);
    expect(await res.json()).toMatchObject({ error: "RIST_BRIDGE_NOT_ACTIVATED" });
    expect(deps.pending).toHaveLength(0); // a config gap is NOT a transient failure
  });

  it("start transient failure → durable pending requeue, accepts 202", async () => {
    const deps = fakeDeps({ startThrows: true });
    const res = await handleIngestBridge("start", "moq", "org_a", { room: "r1" }, WHIP_EP, KEY_REF, deps);
    expect(res.status).toBe(202);
    expect(deps.pending).toEqual([{ org: "org_a", room: "moq:r1" }]);
  });

  it("start bad body (no room) → 400, no dispatch", async () => {
    const deps = fakeDeps();
    const res = await handleIngestBridge("start", "srt", "org_a", {}, WHIP_EP, KEY_REF, deps);
    expect(res.status).toBe(400);
    expect(deps.starts).toHaveLength(0);
  });

  it("stop + activated → dispatchStop, 200", async () => {
    const deps = fakeDeps();
    const res = await handleIngestBridge("stop", "srt", "org_a", { room: "r1" }, "", "", deps);
    expect(res.status).toBe(200);
    expect(deps.stops).toEqual([{ org: "org_a", protocol: "srt", room: "r1" }]);
  });

  it("stop CLEARS the pending under the SAME namespaced key markPending stored (no ghost re-dispatch)", async () => {
    // markPending (start path) keys on the NAMESPACED room ("srt:r1"); a stop carries the RAW room ("r1") and must
    // clear that same key — else a stopped leg's pending record survives and the cron re-dispatches a dead leg.
    // Regression for the clearPending key mismatch.
    const deps = fakeDeps();
    await handleIngestBridge("stop", "srt", "org_a", { room: "r1" }, "", "", deps);
    expect(deps.cleared).toEqual([ingestRoomFor("srt", "r1")]); // "srt:r1", NOT the raw "r1"
  });

  it("stop best-effort (dispatchStop throws) STILL clears the namespaced pending key", async () => {
    const deps = fakeDeps();
    deps.dispatchStop = async () => {
      throw new Error("container gone");
    };
    const res = await handleIngestBridge("stop", "srt", "org_a", { room: "r1" }, "", "", deps);
    expect(res.status).toBe(200);
    expect(deps.cleared).toEqual([ingestRoomFor("srt", "r1")]);
  });

  it("rejects a caller-injected namespaced room on stop (':' reserved) → 400, no dispatch", async () => {
    const deps = fakeDeps();
    const res = await handleIngestBridge("stop", "srt", "org_a", { room: "srt:r1" }, "", "", deps);
    expect(res.status).toBe(400);
    expect(deps.stops).toHaveLength(0);
  });

  it("control-only: payload fields are TEXT — never a media stream", async () => {
    const deps = fakeDeps();
    await handleIngestBridge("start", "srt", "org_a", { room: "r1", inbound: { host: "h" } }, WHIP_EP, KEY_REF, deps);
    const p = deps.starts[0];
    expect(typeof p.protocol).toBe("string");
    expect(typeof p.room).toBe("string");
    expect(typeof p.whipEndpoint).toBe("string");
    expect(typeof p.bridgeKeyRef).toBe("string");
  });
});

describe("maybeHandleIngestBridge — INERT default + gateway-trust + server-side org", () => {
  function postReq(path: string, org?: string, body: unknown = {}): Request {
    return new Request(`https://rt.wave.online${path}`, {
      method: "POST",
      headers: org ? { "content-type": "application/json", "x-wave-org": org } : { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  it("flag OFF → null (falls through to the worker 501 catch-all) — INERT", async () => {
    const res = await maybeHandleIngestBridge(postReq("/v1/ingest/srt/session", "org_a", { room: "r1" }), {}, gateOk, SAFE_ORG);
    expect(res).toBeNull();
  });

  it("flag ON but binding absent → typed 501 (honest fail-closed, not a fake transport)", async () => {
    const env = { INGEST_BRIDGE_ENABLED: "1" };
    const res = await maybeHandleIngestBridge(postReq("/v1/ingest/srt/session", "org_a", { room: "r1" }), env, gateOk, SAFE_ORG);
    expect(res).not.toBeNull();
    expect(res!.status).toBe(501);
    expect(await res!.json()).toMatchObject({ error: "SRT_BRIDGE_NOT_ACTIVATED" });
  });

  it("flag ON, unknown protocol → 400", async () => {
    const env = { INGEST_BRIDGE_ENABLED: "1" };
    const res = await maybeHandleIngestBridge(postReq("/v1/ingest/webrtc/session", "org_a"), env, gateOk, SAFE_ORG);
    expect(res!.status).toBe(400);
  });

  it("flag ON, gateway-trust denied → the gate's 401 (never dispatches)", async () => {
    const env = { INGEST_BRIDGE_ENABLED: "1" };
    const res = await maybeHandleIngestBridge(postReq("/v1/ingest/srt/session", "org_a", { room: "r1" }), env, gateDeny, SAFE_ORG);
    expect(res!.status).toBe(401);
  });

  it("flag ON, missing x-wave-org → 400 (org is server-side, never from body)", async () => {
    const env = { INGEST_BRIDGE_ENABLED: "1" };
    const res = await maybeHandleIngestBridge(postReq("/v1/ingest/srt/session", undefined, { room: "r1", org: "spoofed" }), env, gateOk, SAFE_ORG);
    expect(res!.status).toBe(400);
  });

  it("non-matching path → null (fall-through)", async () => {
    const env = { INGEST_BRIDGE_ENABLED: "1" };
    const res = await maybeHandleIngestBridge(postReq("/v1/whip/publish", "org_a"), env, gateOk, SAFE_ORG);
    expect(res).toBeNull();
  });
});

describe("reconcileIngestPending — cron backstop", () => {
  function fakeKv(seed: Record<string, string> = {}) {
    const m = new Map(Object.entries(seed));
    return {
      async list({ prefix }: { prefix?: string; cursor?: string }) {
        const keys = [...m.keys()].filter((k) => !prefix || k.startsWith(prefix)).map((name) => ({ name }));
        return { keys, list_complete: true, cursor: "" };
      },
      async get(k: string) {
        return m.get(k) ?? null;
      },
      async put(k: string, v: string) {
        m.set(k, v);
      },
      async delete(k: string) {
        m.delete(k);
      },
      _map: m,
    } as unknown as KVNamespace & { _map: Map<string, string> };
  }

  const payload: IngestStartPayload = {
    protocol: "srt",
    inbound: { host: "h", port: 778 },
    whipEndpoint: WHIP_EP,
    bridgeKeyRef: KEY_REF,
    room: "srt:r1",
    meter: METER_STREAM_BRIDGE_MINUTES,
  };

  it("re-dispatches a pending record and CLEARS it on success", async () => {
    const kv = fakeKv({ [`${INGEST_PENDING_PREFIX}org_a:srt:srt:r1`]: JSON.stringify({ org: "org_a", payload, attempts: 0 }) });
    const starts: string[] = [];
    await reconcileIngestPending(kv, {
      async dispatchStart(_o, p) {
        starts.push(p.room);
      },
      log() {},
    });
    expect(starts).toEqual(["srt:r1"]);
    expect(kv._map.size).toBe(0); // cleared
  });

  it("gives up loudly after the max attempts", async () => {
    const kv = fakeKv({
      [`${INGEST_PENDING_PREFIX}org_a:srt:srt:r1`]: JSON.stringify({ org: "org_a", payload, attempts: MAX_INGEST_DISPATCH_ATTEMPTS - 1 }),
    });
    await reconcileIngestPending(kv, {
      async dispatchStart() {
        throw new Error("still cold");
      },
      log() {},
    });
    expect(kv._map.size).toBe(0); // gave up → deleted
  });
});
