import { describe, it, expect } from "vitest";
import {
  pollStreamLifecycles,
  lifecycleUrl,
  livePollDeps,
  customerCodeOf,
  mediaIsFlowing,
  MAX_INPUTS_PER_TICK,
  MAX_STATE_PROBES_PER_TICK,
  type PollDeps,
  type LifecycleState,
} from "../src/stream-bridge-poll";

/**
 * #8 regression suite. The bug these guard against was NOT a crash — it was a control plane that
 * silently did nothing while every test stayed green, because the tests only exercised our own
 * assumptions. So these assert OBSERVABLE DISPATCH BEHAVIOUR (did start/stop actually fire, and
 * exactly once) rather than internal shape.
 */

interface Harness {
  deps: PollDeps;
  starts: { org: string; uid: string; room: string }[];
  stops: { org: string; uid: string }[];
  sessions: Set<string>;
  logs: { msg: string; fields: Record<string, unknown> }[];
}

function harness(o: {
  inputs?: { uid: string; org: string }[];
  states?: Record<string, LifecycleState | null>;
  sessions?: string[];
  failStart?: boolean;
  failStop?: boolean;
  /** #247 — container self-report. `undefined` omits the dep entirely (pre-#247 behaviour). */
  health?: { bridging: boolean; tracks: number } | null;
  omitProbeHealth?: boolean;
  /** #241 — the input's RTMP state from the live_inputs API. undefined → dep omitted. */
  inputState?: string | null;
}): Harness {
  const starts: Harness["starts"] = [];
  const stops: Harness["stops"] = [];
  const sessions = new Set(o.sessions ?? []);
  const logs: Harness["logs"] = [];
  return {
    starts,
    stops,
    sessions,
    logs,
    deps: {
      listInputs: async () => o.inputs ?? [{ uid: "u1", org: "org1" }],
      probeLifecycle: async (uid) => (o.states ? (o.states[uid] ?? null) : { live: true, videoUID: "v1" }),
      hasSession: async (uid) => sessions.has(uid),
      openSession: async (uid) => void sessions.add(uid),
      closeSession: async (uid) => void sessions.delete(uid),
      dispatchStart: async (org, uid, room) => {
        if (o.failStart) throw new Error("container /start → 502");
        starts.push({ org, uid, room });
      },
      dispatchStop: async (org, uid) => {
        if (o.failStop) throw new Error("container /stop → 500");
        stops.push({ org, uid });
      },
      ...(o.omitProbeHealth ? {} : { probeHealth: async () => o.health ?? null }),
      ...(o.inputState === undefined ? {} : { probeInputState: async () => o.inputState ?? null }),
      log: (msg, fields) => logs.push({ msg, fields }),
    },
  };
}

describe("pollStreamLifecycles — edge-triggered dispatch", () => {
  it("live && no session → START (this is the dispatch that never happened before #8)", async () => {
    const h = harness({ states: { u1: { live: true, videoUID: "v1" } } });
    const r = await pollStreamLifecycles(h.deps);
    expect(h.starts).toHaveLength(1);
    expect(h.starts[0]).toMatchObject({ org: "org1", uid: "u1" });
    expect(h.starts[0].room).toBeTruthy();
    expect(r).toMatchObject({ scanned: 1, started: 1, stopped: 0, failed: 0 });
    expect(h.sessions.has("u1")).toBe(true);
  });

  it("live && session already open → NO re-dispatch (edge-triggered, not level-triggered)", async () => {
    const h = harness({ states: { u1: { live: true, videoUID: "v1" } }, sessions: ["u1"] });
    const r = await pollStreamLifecycles(h.deps);
    expect(h.starts).toHaveLength(0);
    expect(r).toMatchObject({ started: 0, stopped: 0 });
  });

  it("!live && session open → STOP (this is what books the duration meter)", async () => {
    const h = harness({ states: { u1: { live: false, videoUID: null } }, sessions: ["u1"] });
    const r = await pollStreamLifecycles(h.deps);
    expect(h.stops).toEqual([{ org: "org1", uid: "u1" }]);
    expect(r).toMatchObject({ stopped: 1 });
    expect(h.sessions.has("u1")).toBe(false);
  });

  it("!live && no session → nothing at all", async () => {
    const h = harness({ states: { u1: { live: false, videoUID: null } } });
    const r = await pollStreamLifecycles(h.deps);
    expect(h.starts).toHaveLength(0);
    expect(h.stops).toHaveLength(0);
    expect(r).toMatchObject({ started: 0, stopped: 0 });
  });

  it("a full broadcast drives exactly one start and one stop across ticks", async () => {
    let live = true;
    const sessions = new Set<string>();
    const starts: string[] = [];
    const stops: string[] = [];
    const deps: PollDeps = {
      listInputs: async () => [{ uid: "u1", org: "org1" }],
      probeLifecycle: async () => ({ live, videoUID: live ? "v1" : null }),
      hasSession: async (uid) => sessions.has(uid),
      openSession: async (uid) => void sessions.add(uid),
      closeSession: async (uid) => void sessions.delete(uid),
      dispatchStart: async (_o, uid) => void starts.push(uid),
      dispatchStop: async (_o, uid) => void stops.push(uid),
    };
    await pollStreamLifecycles(deps); // going live
    await pollStreamLifecycles(deps); // still live
    await pollStreamLifecycles(deps); // still live
    live = false;
    await pollStreamLifecycles(deps); // ended
    await pollStreamLifecycles(deps); // still ended
    expect(starts).toEqual(["u1"]);
    expect(stops).toEqual(["u1"]);
  });
});

describe("pollStreamLifecycles — failure semantics (never guess, never strand)", () => {
  it("probe failure SKIPS — it must not be read as 'not live' and tear down a healthy broadcast", async () => {
    const h = harness({ states: { u1: null }, sessions: ["u1"] });
    const r = await pollStreamLifecycles(h.deps);
    expect(h.stops).toHaveLength(0); // the critical assertion
    expect(r).toMatchObject({ skipped: 1, stopped: 0 });
    expect(h.sessions.has("u1")).toBe(true);
    expect(h.logs.some((l) => l.msg === "stream-poll-probe-failed")).toBe(true);
  });

  it("a throwing probe is treated as a skip, not a crash", async () => {
    const h = harness({ states: { u1: { live: true, videoUID: "v" } } });
    h.deps.probeLifecycle = async () => {
      throw new Error("network");
    };
    const r = await pollStreamLifecycles(h.deps);
    expect(r).toMatchObject({ skipped: 1, started: 0 });
  });

  it("failed start records NO session, so the next tick retries", async () => {
    const h = harness({ states: { u1: { live: true, videoUID: "v1" } }, failStart: true });
    const r = await pollStreamLifecycles(h.deps);
    expect(r).toMatchObject({ failed: 1, started: 0 });
    expect(h.sessions.has("u1")).toBe(false); // retried next tick
    expect(h.logs.some((l) => l.msg === "stream-poll-start-failed")).toBe(true);
  });

  it("failed stop KEEPS the session so the stop retries — dropping it would strand the meter open", async () => {
    const h = harness({ states: { u1: { live: false, videoUID: null } }, sessions: ["u1"], failStop: true });
    const r = await pollStreamLifecycles(h.deps);
    expect(r).toMatchObject({ failed: 1, stopped: 0 });
    expect(h.sessions.has("u1")).toBe(true); // the revenue-integrity assertion
  });

  it("one bad input does not abort the tick for the others", async () => {
    const h = harness({
      inputs: [
        { uid: "bad", org: "org1" },
        { uid: "good", org: "org2" },
      ],
      states: { bad: null, good: { live: true, videoUID: "v" } },
    });
    const r = await pollStreamLifecycles(h.deps);
    expect(h.starts.map((s) => s.uid)).toEqual(["good"]);
    expect(r).toMatchObject({ scanned: 2, skipped: 1, started: 1 });
  });

  it("caps the inputs examined per tick", async () => {
    const many = Array.from({ length: MAX_INPUTS_PER_TICK + 25 }, (_, i) => ({ uid: `u${i}`, org: "o" }));
    const h = harness({ inputs: many, states: {} });
    const r = await pollStreamLifecycles(h.deps);
    expect(r.scanned).toBe(MAX_INPUTS_PER_TICK);
  });
});

describe("mediaIsFlowing — live:true alone is NOT a broadcast", () => {
  // Captured from the real endpoint 2026-07-18: an idle input answers
  // {"isInput":true,"videoUID":"unknown","live":true,"status":"ready"}. Dispatching on that made the
  // container return `502 source leg failed (no live media)` for 5 inputs on EVERY tick.
  it("rejects the idle-input response CF actually returns (live:true, videoUID:'unknown')", () => {
    expect(mediaIsFlowing({ live: true, videoUID: "unknown", status: "ready" })).toBe(false);
  });

  it("accepts a real broadcast (live:true with a concrete videoUID)", () => {
    expect(mediaIsFlowing({ live: true, videoUID: "abc123", status: "connected" })).toBe(true);
  });

  it("rejects a disconnected input", () => {
    expect(mediaIsFlowing({ live: false, videoUID: null, status: "disconnected" })).toBe(false);
  });

  it("rejects live:false even if a stale videoUID lingers", () => {
    expect(mediaIsFlowing({ live: false, videoUID: "abc123" })).toBe(false);
  });

  it("an idle input is NOT dispatched — the container-thrash regression", async () => {
    const h = harness({ states: { u1: { live: true, videoUID: "unknown", status: "ready" } } });
    const r = await pollStreamLifecycles(h.deps);
    expect(h.starts).toHaveLength(0); // the critical assertion: no container spun up
    expect(r).toMatchObject({ scanned: 1, started: 0, failed: 0, skipped: 0 });
  });

  it("an input that goes idle mid-session is STOPPED (the meter must not stay open)", async () => {
    const h = harness({ states: { u1: { live: true, videoUID: "unknown", status: "ready" } }, sessions: ["u1"] });
    const r = await pollStreamLifecycles(h.deps);
    expect(h.stops).toEqual([{ org: "org1", uid: "u1" }]);
    expect(r).toMatchObject({ stopped: 1 });
  });
});

describe("customerCodeOf — an EMPTY binding must not shadow a working one", () => {
  // This is the defect that kept #8 open after the poll shipped: `??` falls through only on
  // null/undefined, so CF_STREAM_CUSTOMER_CODE bound to "" shadowed the fallback and the poll
  // reported hasCode:false forever. The CF API listed the secret as present the whole time.
  it("skips an empty-string binding and falls through to the next candidate", () => {
    expect(customerCodeOf({ CF_STREAM_CUSTOMER_CODE: "", CLOUDFLARE_STREAM_CUSTOMER_CODE: "good" })).toBe("good");
  });

  it("skips a whitespace-only binding too", () => {
    expect(customerCodeOf({ CF_STREAM_CUSTOMER_CODE: "   ", CLOUDFLARE_STREAM_CUSTOMER_CODE: "good" })).toBe("good");
  });

  it("prefers the primary when it is genuinely set", () => {
    expect(customerCodeOf({ CF_STREAM_CUSTOMER_CODE: "primary", CLOUDFLARE_STREAM_CUSTOMER_CODE: "fallback" })).toBe(
      "primary",
    );
  });

  it("is undefined when every candidate is missing or empty", () => {
    expect(customerCodeOf({})).toBeUndefined();
    expect(customerCodeOf({ CF_STREAM_CUSTOMER_CODE: "", CLOUDFLARE_STREAM_CUSTOMER_CODE: "" })).toBeUndefined();
  });

  it("livePollDeps is INERT — not half-configured — when the code is bound but empty", () => {
    const kv = { list: async () => ({ keys: [] }), get: async () => null } as unknown as KVNamespace;
    expect(
      livePollDeps(
        { STREAM_BRIDGE_ENABLED: "1", RT_MEETING_ORG: kv, CF_STREAM_CUSTOMER_CODE: "" },
        { dispatchStart: async () => {}, dispatchStop: async () => {} },
      ),
    ).toBeNull();
  });
});

describe("lifecycleUrl / livePollDeps", () => {
  it("builds the secret-free deterministic lifecycle URL", () => {
    expect(lifecycleUrl("abc123", "uid1")).toBe("https://customer-abc123.cloudflarestream.com/uid1/lifecycle");
  });

  it("is INERT when KV or the customer code is missing (never half-configured)", () => {
    expect(livePollDeps({ STREAM_BRIDGE_ENABLED: "1" }, { dispatchStart: async () => {}, dispatchStop: async () => {} })).toBeNull();
  });

  it("probe returns null on a non-200 and on an unrecognised body — never a guessed transition", async () => {
    const kv = {
      list: async () => ({ keys: [] }),
      get: async () => null,
      put: async () => {},
      delete: async () => {},
    } as unknown as KVNamespace;

    const mk = (res: Response) =>
      livePollDeps(
        { STREAM_BRIDGE_ENABLED: "1", RT_MEETING_ORG: kv, CF_STREAM_CUSTOMER_CODE: "code1" },
        { dispatchStart: async () => {}, dispatchStop: async () => {} },
        (async () => res) as unknown as typeof fetch,
      );

    expect(await mk(new Response("nope", { status: 404 }))!.probeLifecycle("u1")).toBeNull();
    expect(await mk(new Response(JSON.stringify({ isInput: true })))!.probeLifecycle("u1")).toBeNull();
    expect(
      await mk(new Response(JSON.stringify({ live: true, videoUID: "v9", status: "connected" })))!.probeLifecycle("u1"),
    ).toEqual({ live: true, videoUID: "v9", status: "connected" });

    // `status` is diagnostic and optional — a body without it still parses, as null.
    expect(await mk(new Response(JSON.stringify({ live: true, videoUID: "v9" })))!.probeLifecycle("u1")).toEqual({
      live: true,
      videoUID: "v9",
      status: null,
    });
  });
});

describe("a failed start must RELEASE its container instance — the wedge regression (#231)", () => {
  it("releases the instance when /start fails", async () => {
    const h = harness({ states: { u1: { live: true, videoUID: "v1" } }, failStart: true });
    const r = await pollStreamLifecycles(h.deps);

    // The critical assertion: the slot is handed back, not held forever.
    expect(h.stops).toEqual([{ org: "org1", uid: "u1" }]);
    expect(r).toMatchObject({ started: 0, failed: 1 });
    expect(h.logs.map((l) => l.msg)).toContain("stream-poll-start-released");
  });

  it("still records NO session on a failed start (so the next tick retries)", async () => {
    const h = harness({ states: { u1: { live: true, videoUID: "v1" } }, failStart: true });
    await pollStreamLifecycles(h.deps);
    expect(h.sessions.has("u1")).toBe(false);
  });

  it("a failing release is logged but never masks the start error or aborts the tick", async () => {
    const h = harness({
      inputs: [
        { uid: "u1", org: "org1" },
        { uid: "u2", org: "org2" },
      ],
      states: { u1: { live: true, videoUID: "v1" }, u2: { live: true, videoUID: "v2" } },
      failStart: true,
      failStop: true,
    });
    const r = await pollStreamLifecycles(h.deps);

    const msgs = h.logs.map((l) => l.msg);
    expect(msgs).toContain("stream-poll-start-failed"); // original error still surfaced
    expect(msgs).toContain("stream-poll-start-release-failed");
    // u2 was still scanned — one input's release failure does not abort the rest of the tick.
    expect(r).toMatchObject({ scanned: 2, failed: 2 });
  });

  it("N consecutive failed starts release N instances — slots never accumulate", async () => {
    const inputs = ["u1", "u2", "u3", "u4", "u5"].map((uid) => ({ uid, org: "org1" }));
    const states = Object.fromEntries(inputs.map(({ uid }) => [uid, { live: true, videoUID: `vid-${uid}` }]));
    const h = harness({ inputs, states, failStart: true });

    await pollStreamLifecycles(h.deps);

    // Exactly the scenario that wedged prod: 5 failing inputs against max_instances. Every one is
    // released, so capacity returns to zero-held rather than five-held.
    expect(h.stops).toHaveLength(5);
  });
});

describe("pollStreamLifecycles — dead-bridge reconcile (#247)", () => {
  const LIVE = { live: true, videoUID: "v1" };

  it("clears the session when the container reports it is NOT bridging, so the next tick re-dispatches", async () => {
    // The failure this fixes: a container that crashed, was evicted, or was DRAINED by a rollout (#235)
    // leaves the KV session record behind. hasSession keeps answering true, the poll never re-dispatches,
    // and the broadcast stays dark until the TTL expires — while stream-poll-tick reports a clean started:0.
    const h = harness({ states: { u1: LIVE }, sessions: ["u1"], health: { bridging: false, tracks: 0 } });
    const r = await pollStreamLifecycles(h.deps);
    expect(r.revived).toBe(1);
    expect(h.sessions.has("u1")).toBe(false);
    expect(h.stops).toEqual([{ org: "org1", uid: "u1" }]); // dead instance's slot released (#231)
    expect(h.logs.some((l) => l.msg === "stream-poll-bridge-dead")).toBe(true);
  });

  it("re-dispatches on the FOLLOWING tick — one start path, not a second", async () => {
    const h = harness({ states: { u1: LIVE }, sessions: ["u1"], health: { bridging: false, tracks: 0 } });
    await pollStreamLifecycles(h.deps);
    expect(h.starts).toHaveLength(0); // the revive tick itself does NOT start
    const h2 = harness({ states: { u1: LIVE }, sessions: [], health: { bridging: true, tracks: 2 } });
    const r2 = await pollStreamLifecycles(h2.deps);
    expect(r2.started).toBe(1);
  });

  it("leaves a HEALTHY bridge completely alone, and SAYS it confirmed health", async () => {
    // `revived:0` alone is ambiguous — it reads identically whether the probe said healthy or could not
    // answer. That ambiguity made the first live proof of this feature unfalsifiable, so the tick must
    // distinguish the two. Same silence-is-not-evidence defect as #231/#235/#241.
    const h = harness({ states: { u1: LIVE }, sessions: ["u1"], health: { bridging: true, tracks: 2 } });
    const r = await pollStreamLifecycles(h.deps);
    expect(r).toMatchObject({ revived: 0, healthy: 1, healthUnknown: 0, started: 0, stopped: 0, failed: 0 });
    expect(h.sessions.has("u1")).toBe(true);
    expect(h.stops).toHaveLength(0);
  });

  it("FAILS SAFE on an unreadable probe — null must never be read as dead", async () => {
    // Tearing down a healthy customer broadcast on a transient blip is far worse than a late re-dispatch.
    // This is the same reasoning-from-absence trap as #229 (empty instance list), #233 (empty track list)
    // and #241 (missing videoUID) — the most repeated defect in this subsystem.
    const h = harness({ states: { u1: LIVE }, sessions: ["u1"], health: null });
    const r = await pollStreamLifecycles(h.deps);
    expect(r.revived).toBe(0);
    // ...and it is DISTINGUISHABLE from a confirmed-healthy tick.
    expect(r).toMatchObject({ healthy: 0, healthUnknown: 1 });
    expect(h.sessions.has("u1")).toBe(true);
    expect(h.stops).toHaveLength(0);
  });

  it("FAILS SAFE when the probe throws", async () => {
    const h = harness({ states: { u1: LIVE }, sessions: ["u1"] });
    h.deps.probeHealth = async () => { throw new Error("DO unreachable"); };
    const r = await pollStreamLifecycles(h.deps);
    expect(r.revived).toBe(0);
    expect(h.sessions.has("u1")).toBe(true);
  });

  it("still clears the session even if releasing the dead instance fails", async () => {
    // The stale record is the thing blocking re-dispatch; a failed release must not strand the broadcast.
    const h = harness({ states: { u1: LIVE }, sessions: ["u1"], health: { bridging: false, tracks: 0 }, failStop: true });
    const r = await pollStreamLifecycles(h.deps);
    expect(r.revived).toBe(1);
    expect(h.sessions.has("u1")).toBe(false);
    expect(h.logs.some((l) => l.msg === "stream-poll-revive-stop-failed")).toBe(true);
  });

  it("is byte-identical to pre-#247 when no probeHealth dep is supplied", async () => {
    const h = harness({ states: { u1: LIVE }, sessions: ["u1"], omitProbeHealth: true });
    const r = await pollStreamLifecycles(h.deps);
    expect(r).toMatchObject({ revived: 0, started: 0, stopped: 0, failed: 0 });
    expect(h.sessions.has("u1")).toBe(true);
  });

  it("does NOT probe health for an input that is not flowing — teardown still owns that edge", async () => {
    let probed = false;
    const h = harness({ states: { u1: { live: false, videoUID: null } }, sessions: ["u1"] });
    h.deps.probeHealth = async () => { probed = true; return null; };
    const r = await pollStreamLifecycles(h.deps);
    expect(probed).toBe(false);
    expect(r.stopped).toBe(1);
  });
});

describe("pollStreamLifecycles — RTMP-connected but no videoUID (#241)", () => {
  const NO_VIDEO = { live: true, videoUID: "unknown", status: "ready" };

  it("names the silent condition: input connected, no videoUID, no bridge", async () => {
    // The 2026-07-19 case: a 13-minute push with CF reporting connected the whole time and ZERO dispatches.
    // Every tick read {"scanned":7,"started":0,"failed":0,"skipped":0} — byte-identical to a quiet night.
    const h = harness({ states: { u1: NO_VIDEO }, inputState: "connected" });
    const r = await pollStreamLifecycles(h.deps);
    expect(r.connectedNoVideo).toBe(1);
    const line = h.logs.find((l) => l.msg === "stream-poll-connected-no-video");
    expect(line?.fields).toMatchObject({ uid: "u1", inputState: "connected", videoUID: "unknown" });
  });

  it("does NOT dispatch on it — widening mediaIsFlowing would bridge idle inputs and bill dead air", async () => {
    const h = harness({ states: { u1: NO_VIDEO }, inputState: "connected" });
    const r = await pollStreamLifecycles(h.deps);
    expect(h.starts).toHaveLength(0);
    expect(r.started).toBe(0);
  });

  it("stays quiet for a genuinely idle input (disconnected) — no false positives", async () => {
    // An idle-ready input reads IDENTICALLY on the lifecycle endpoint, which is exactly why the
    // authenticated input-state probe is required to tell them apart.
    const h = harness({ states: { u1: NO_VIDEO }, inputState: "disconnected" });
    const r = await pollStreamLifecycles(h.deps);
    expect(r.connectedNoVideo).toBe(0);
    expect(h.logs.some((l) => l.msg === "stream-poll-connected-no-video")).toBe(false);
  });

  it("stays quiet when the state probe is unreadable — a flaky API cannot manufacture a report", async () => {
    const h = harness({ states: { u1: NO_VIDEO }, inputState: null });
    const r = await pollStreamLifecycles(h.deps);
    expect(r.connectedNoVideo).toBe(0);
  });

  it("does not probe an input that is already bridging", async () => {
    let probed = false;
    const h = harness({ states: { u1: { live: true, videoUID: "v1" } }, sessions: ["u1"], health: { bridging: true, tracks: 2 } });
    h.deps.probeInputState = async () => { probed = true; return "connected"; };
    await pollStreamLifecycles(h.deps);
    expect(probed).toBe(false);
  });

  it("bounds the authenticated probes per tick", async () => {
    let probes = 0;
    const inputs = Array.from({ length: 40 }, (_, i) => ({ uid: `u${i}`, org: "org1" }));
    const states = Object.fromEntries(inputs.map((i) => [i.uid, NO_VIDEO]));
    const h = harness({ inputs, states });
    h.deps.probeInputState = async () => { probes++; return "disconnected"; };
    await pollStreamLifecycles(h.deps);
    expect(probes).toBe(MAX_STATE_PROBES_PER_TICK);
  });

  it("is byte-identical to pre-#241 when the dep is absent", async () => {
    const h = harness({ states: { u1: NO_VIDEO } });
    const r = await pollStreamLifecycles(h.deps);
    expect(r).toMatchObject({ connectedNoVideo: 0, started: 0, failed: 0 });
  });
});
