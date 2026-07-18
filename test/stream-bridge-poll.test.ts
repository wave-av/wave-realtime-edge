import { describe, it, expect } from "vitest";
import {
  pollStreamLifecycles,
  lifecycleUrl,
  livePollDeps,
  MAX_INPUTS_PER_TICK,
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
    expect(await mk(new Response(JSON.stringify({ live: true, videoUID: "v9" })))!.probeLifecycle("u1")).toEqual({
      live: true,
      videoUID: "v9",
    });
  });
});
