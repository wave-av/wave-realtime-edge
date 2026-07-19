// B1 (#91-a) CF Stream bridge control-plane unit tests. Proves the INERT scaffold's load-bearing parts with
// NO live infra: the HMAC verify-before-parse (constant-time, replay-guarded, fail-closed), org-attribution
// fail-closed admission, deterministic-room idempotency, control-only dispatch (no media seam), and the cron
// lifecycle-poll reconcile. The signature is computed in-test with webcrypto — the same construction the live
// CF Stream subscription uses (`${time}.${body}` HMAC-SHA256).
import { describe, it, expect, vi } from "vitest";
import {
  streamBridgeEnabled,
  bridgeRoomFor,
  parseWebhookSignature,
  timingSafeEqualHex,
  verifyStreamSignature,
  handleStreamBridge,
  reconcileStreamPending,
  STREAM_PENDING_PREFIX,
  MAX_STREAM_DISPATCH_ATTEMPTS,
  type StreamBridgeDeps,
} from "../src/stream-bridge.js";
import { parseStreamEvent } from "../src/stream-bridge-payload.js";

const TEST_KEY = "rt-stream-bridge-test-key";

/** Sign `${time}.${body}` exactly as CF Stream's webhook does → the `Webhook-Signature` header value. */
async function signHeader(body: string, time: number, secret = TEST_KEY): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${time}.${body}`));
  const hex = [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `time=${time},sig1=${hex}`;
}

function req(body: string, sigHeader?: string): Request {
  return new Request("https://rt.wave.online/v1/stream/bridge/webhook", {
    method: "POST",
    headers: sigHeader ? { "webhook-signature": sigHeader } : {},
    body,
  });
}

/** A deps double that records dispatch calls; resolveOrg returns the map's value (null = miss). */
function fakeDeps(orgMap: Record<string, string | null>): StreamBridgeDeps & {
  starts: Array<{ org: string; uid: string; room: string }>;
  stops: Array<{ org: string; uid: string }>;
  pending: Array<{ uid: string; org: string }>;
  cleared: string[];
} {
  const starts: Array<{ org: string; uid: string; room: string }> = [];
  const stops: Array<{ org: string; uid: string }> = [];
  const pending: Array<{ uid: string; org: string }> = [];
  const cleared: string[] = [];
  return {
    starts,
    stops,
    pending,
    cleared,
    async resolveOrg(uid) {
      return uid in orgMap ? orgMap[uid] : null;
    },
    async dispatchStart(org, uid, room) {
      starts.push({ org, uid, room });
    },
    async dispatchStop(org, uid) {
      stops.push({ org, uid });
    },
    async markPending(uid, org) {
      pending.push({ uid, org });
    },
    async clearPending(uid) {
      cleared.push(uid);
    },
    log() {},
  };
}

describe("streamBridgeEnabled — flag gate (INERT default)", () => {
  it("only 1/true enable; absent/0/false stay inert", () => {
    expect(streamBridgeEnabled({})).toBe(false);
    expect(streamBridgeEnabled({ STREAM_BRIDGE_ENABLED: "0" })).toBe(false);
    expect(streamBridgeEnabled({ STREAM_BRIDGE_ENABLED: "1" })).toBe(true);
    expect(streamBridgeEnabled({ STREAM_BRIDGE_ENABLED: true })).toBe(true);
    expect(streamBridgeEnabled({ STREAM_BRIDGE_ENABLED: "true" })).toBe(true);
  });
});

describe("bridgeRoomFor — deterministic idempotency key", () => {
  it("one input → one stable room", () => {
    expect(bridgeRoomFor("abc123")).toBe("cfstream:abc123");
    expect(bridgeRoomFor("abc123")).toBe(bridgeRoomFor("abc123"));
  });
});

describe("parseWebhookSignature", () => {
  it("parses time+sig1, rejects malformed", () => {
    expect(parseWebhookSignature("time=1700000000,sig1=deadbeef")).toEqual({ time: 1700000000, sig: "deadbeef" });
    expect(parseWebhookSignature(null)).toBeNull();
    expect(parseWebhookSignature("sig1=deadbeef")).toBeNull(); // no time
    expect(parseWebhookSignature("time=abc,sig1=x")).toBeNull(); // non-numeric time
  });
});

describe("timingSafeEqualHex", () => {
  it("true on equal, false on diff or length mismatch", () => {
    expect(timingSafeEqualHex("abcd", "abcd")).toBe(true);
    expect(timingSafeEqualHex("abcd", "abce")).toBe(false);
    expect(timingSafeEqualHex("abcd", "abcde")).toBe(false);
  });
});

describe("verifyStreamSignature — fail-closed HMAC", () => {
  const now = 1_700_000_000_000; // fixed clock
  const time = Math.floor(now / 1000);
  const body = JSON.stringify({ notificationName: "live_input.connected", input_id: "vid1" });

  it("valid signature within window → true", async () => {
    const header = await signHeader(body, time);
    expect(await verifyStreamSignature(new TextEncoder().encode(body), header, TEST_KEY, now)).toBe(true);
  });

  it("tampered body → false", async () => {
    const header = await signHeader(body, time);
    const tampered = new TextEncoder().encode(body + " ");
    expect(await verifyStreamSignature(tampered, header, TEST_KEY, now)).toBe(false);
  });

  it("wrong secret → false", async () => {
    const header = await signHeader(body, time, "other-test-key");
    expect(await verifyStreamSignature(new TextEncoder().encode(body), header, TEST_KEY, now)).toBe(false);
  });

  it("stale timestamp (> tolerance) → false (replay guard)", async () => {
    const staleTime = time - 60 * 60; // 1h old
    const header = await signHeader(body, staleTime);
    expect(await verifyStreamSignature(new TextEncoder().encode(body), header, TEST_KEY, now)).toBe(false);
  });

  it("empty secret → false (never trust unconfigured)", async () => {
    const header = await signHeader(body, time);
    expect(await verifyStreamSignature(new TextEncoder().encode(body), header, "", now)).toBe(false);
  });

  it("missing header → false", async () => {
    expect(await verifyStreamSignature(new TextEncoder().encode(body), null, TEST_KEY, now)).toBe(false);
  });
});

describe("parseStreamEvent — tolerant of field-name variants", () => {
  it("connected / disconnected / uid variants", () => {
    expect(parseStreamEvent(JSON.stringify({ notificationName: "live_input.connected", input_id: "u1" }))).toEqual({
      uid: "u1",
      lifecycle: "connected",
      live: undefined,
      keys: ["notificationName", "input_id"],
    });
    expect(parseStreamEvent(JSON.stringify({ eventType: "live_input.disconnected", uid: "u2" }))?.lifecycle).toBe(
      "disconnected",
    );
    expect(parseStreamEvent(JSON.stringify({ event: "live_input.connected", live_input: { uid: "u3", live: true } }))).toEqual(
      { uid: "u3", lifecycle: "connected", live: true, keys: ["event", "live_input", "live_input.uid", "live_input.live"] },
    );
  });
  it("no uid → null; bad json → null", () => {
    expect(parseStreamEvent(JSON.stringify({ notificationName: "live_input.connected" }))).toBeNull();
    expect(parseStreamEvent("{not json")).toBeNull();
  });

  // #8 regression. The 2026-07-18 outage: a real CF push landed in `other`, so the container bridge never
  // dispatched and nothing billed — while every test above stayed green, because they only ever asserted our
  // OWN invented key names back at us. These pin the property that actually matters: the lifecycle is found
  // by the event-name VALUE, under a key this parser has never heard of.
  it("finds the lifecycle under an UNKNOWN key (value-keyed match)", () => {
    expect(
      parseStreamEvent(JSON.stringify({ some_future_field: "live_input.connected", input_id: "u4" }))?.lifecycle,
    ).toBe("connected");
    expect(
      parseStreamEvent(JSON.stringify({ some_future_field: "live_input.disconnected", input_id: "u5" }))?.lifecycle,
    ).toBe("disconnected");
  });

  it("handles the snake_case `event_type` key CF uses on the live surface", () => {
    expect(parseStreamEvent(JSON.stringify({ event_type: "live_input.connected", input_id: "u6" }))?.lifecycle).toBe(
      "connected",
    );
  });

  it("a genuinely unrelated event still parses as `other` and carries the payload keys for diagnosis", () => {
    const evt = parseStreamEvent(JSON.stringify({ event_type: "video.ready", input_id: "u7" }));
    expect(evt?.lifecycle).toBe("other");
    expect(evt?.keys).toEqual(["event_type", "input_id"]);
  });

  it("keys carries NAMES only — never values (unvetted third-party input must not reach logs)", () => {
    const evt = parseStreamEvent(JSON.stringify({ event_type: "live_input.connected", input_id: "u8", meta: "secret-ish" }));
    expect(evt?.keys).toEqual(["event_type", "input_id", "meta"]);
    expect(JSON.stringify(evt?.keys)).not.toContain("secret-ish");
  });

  // THE REAL CF SHAPE, verbatim from the Stream Live webhooks docs. Both the uid and the event name are
  // nested under `data` — the root-only parser found NEITHER, which is why a real push dispatched nothing.
  // This is the one test in this file written against CF's documented body rather than our invention.
  it("parses CF's documented nested live webhook body", () => {
    const real = JSON.stringify({
      name: "Live Webhook Test",
      text: "Notification type: Stream Live Input\nEvent type: live_input.connected",
      data: {
        notification_name: "Stream Live Input",
        input_id: "eb222fcca08eeb1ae84c981ebe8aeeb6",
        event_type: "live_input.connected",
        updated_at: "2022-01-13T11:43:41.855717910Z",
      },
      ts: 1642074233,
    });
    expect(parseStreamEvent(real)).toMatchObject({
      uid: "eb222fcca08eeb1ae84c981ebe8aeeb6",
      lifecycle: "connected",
    });
    // replaceAll, not replace: the human-readable `text` field repeats the event name, so a single
    // replace would flip only that copy and leave data.event_type saying "connected".
    expect(parseStreamEvent(real.replaceAll("live_input.connected", "live_input.disconnected"))?.lifecycle).toBe(
      "disconnected",
    );
  });

  it("finds fields at ARBITRARY depth, not just one known envelope", () => {
    const deep = JSON.stringify({ a: { b: { c: { event_type: "live_input.connected", input_id: "deep1" } } } });
    expect(parseStreamEvent(deep)).toMatchObject({ uid: "deep1", lifecycle: "connected" });
  });

  it("walks arrays too — a field inside a list is still found", () => {
    const inArray = JSON.stringify({ events: [{ event_type: "live_input.disconnected", input_id: "arr1" }] });
    expect(parseStreamEvent(inArray)).toMatchObject({ uid: "arr1", lifecycle: "disconnected" });
  });

  it("shallower field wins over a deeper one of the same name (breadth-first)", () => {
    const both = JSON.stringify({ input_id: "root", data: { input_id: "nested" } });
    expect(parseStreamEvent(both)?.uid).toBe("root");
  });

  it("keys reports DOTTED PATHS so the failing shape is identifiable", () => {
    const evt = parseStreamEvent(JSON.stringify({ ts: 1, data: { input_id: "u9", event_type: "video.ready" } }));
    expect(evt?.lifecycle).toBe("other");
    expect(evt?.keys).toContain("data.event_type");
    expect(evt?.keys).toContain("data.input_id");
  });

  // The payload is unvetted third-party input: bounded on depth AND node count so it cannot become a CPU sink.
  it("survives a pathological payload without hanging", () => {
    let deep: Record<string, unknown> = { input_id: "bomb" };
    for (let i = 0; i < 200; i++) deep = { nest: deep };
    expect(() => parseStreamEvent(JSON.stringify(deep))).not.toThrow();

    const wide: Record<string, unknown> = { input_id: "wide" };
    for (let i = 0; i < 5000; i++) wide[`k${i}`] = `v${i}`;
    const started = Date.now();
    parseStreamEvent(JSON.stringify(wide));
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it("is cycle-safe (a self-referential object cannot loop the walk)", () => {
    // JSON.parse can't produce a cycle, so drive the walk through a body with heavy shared nesting.
    const shared = { event_type: "live_input.connected", input_id: "cyc1" };
    expect(parseStreamEvent(JSON.stringify({ a: shared, b: shared, c: { d: shared } }))).toMatchObject({
      uid: "cyc1",
      lifecycle: "connected",
    });
  });
});

describe("handleStreamBridge — verify-before-parse, fail-closed admission, control-only", () => {
  const now = 1_700_000_000_000;
  const time = Math.floor(now / 1000);

  it("bad/absent signature → 401 BEFORE any dispatch", async () => {
    const deps = fakeDeps({ vid1: "org_a" });
    const body = JSON.stringify({ notificationName: "live_input.connected", input_id: "vid1" });
    const res = await handleStreamBridge(req(body, "time=1,sig1=bad"), TEST_KEY, deps, now);
    expect(res.status).toBe(401);
    expect(deps.starts).toHaveLength(0); // nothing acted on
  });

  it("valid connected + org → dispatchStart into the DETERMINISTIC room, 200", async () => {
    const deps = fakeDeps({ vid1: "org_a" });
    const body = JSON.stringify({ notificationName: "live_input.connected", input_id: "vid1" });
    const res = await handleStreamBridge(req(body, await signHeader(body, time)), TEST_KEY, deps, now);
    expect(res.status).toBe(200);
    expect(deps.starts).toEqual([{ org: "org_a", uid: "vid1", room: "cfstream:vid1" }]);
    expect(deps.cleared).toContain("vid1"); // cleared its pending on success
  });

  it("connected + org MISS → fail-closed skip: NO dispatch, skipped:no-org, 200", async () => {
    const deps = fakeDeps({}); // no org for the uid
    const body = JSON.stringify({ notificationName: "live_input.connected", input_id: "orphan" });
    const res = await handleStreamBridge(req(body, await signHeader(body, time)), TEST_KEY, deps, now);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ skipped: "no-org" });
    expect(deps.starts).toHaveLength(0); // NEVER admits media for an un-attributed input
  });

  it("disconnected + org → dispatchStop, 200", async () => {
    const deps = fakeDeps({ vid1: "org_a" });
    const body = JSON.stringify({ eventType: "live_input.disconnected", input_id: "vid1" });
    const res = await handleStreamBridge(req(body, await signHeader(body, time)), TEST_KEY, deps, now);
    expect(res.status).toBe(200);
    expect(deps.stops).toEqual([{ org: "org_a", uid: "vid1" }]);
  });

  it("start failure → enqueues a durable pending record (cron re-dispatch), still acks 200", async () => {
    const deps = fakeDeps({ vid1: "org_a" });
    deps.dispatchStart = vi.fn(async () => {
      throw new Error("container cold");
    });
    const body = JSON.stringify({ notificationName: "live_input.connected", input_id: "vid1" });
    const res = await handleStreamBridge(req(body, await signHeader(body, time)), TEST_KEY, deps, now);
    expect(res.status).toBe(200); // fail-open behind the signed ack
    expect(deps.pending).toEqual([{ uid: "vid1", org: "org_a" }]);
  });

  it("control-only: dispatch args are TEXT (uid/org/room) — never a media stream", async () => {
    const deps = fakeDeps({ vid1: "org_a" });
    const body = JSON.stringify({ notificationName: "live_input.connected", input_id: "vid1" });
    await handleStreamBridge(req(body, await signHeader(body, time)), TEST_KEY, deps, now);
    for (const s of deps.starts) {
      expect(typeof s.org).toBe("string");
      expect(typeof s.uid).toBe("string");
      expect(typeof s.room).toBe("string");
    }
  });
});

describe("reconcileStreamPending — cron lifecycle-poll backstop", () => {
  /** Minimal in-memory KV double (list/get/put/delete) over a Map. */
  function fakeKv(seed: Record<string, string> = {}) {
    const m = new Map(Object.entries(seed));
    return {
      async list({ prefix, cursor }: { prefix?: string; cursor?: string }) {
        void cursor;
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

  it("re-dispatches a pending record and CLEARS it on success", async () => {
    const kv = fakeKv({ [`${STREAM_PENDING_PREFIX}vid1`]: JSON.stringify({ org: "org_a", attempts: 0 }) });
    const starts: string[] = [];
    await reconcileStreamPending(kv, { async dispatchStart(_o, uid) { starts.push(uid); }, log() {} });
    expect(starts).toEqual(["vid1"]);
    expect(await kv.get(`${STREAM_PENDING_PREFIX}vid1`)).toBeNull(); // cleared
  });

  it("bumps attempts on failure, gives up loudly after the max", async () => {
    const kv = fakeKv({
      [`${STREAM_PENDING_PREFIX}vid1`]: JSON.stringify({ org: "org_a", attempts: MAX_STREAM_DISPATCH_ATTEMPTS - 1 }),
    });
    await reconcileStreamPending(kv, {
      async dispatchStart() {
        throw new Error("still cold");
      },
      log() {},
    });
    expect(await kv.get(`${STREAM_PENDING_PREFIX}vid1`)).toBeNull(); // gave up → deleted
  });
});
