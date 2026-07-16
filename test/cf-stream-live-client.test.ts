// WHEP-A — the concrete CfStreamLiveClient adapter. Proves it: creates a CF Stream Live input, surfaces the
// RTMPS/SRT push endpoints, writes the FORWARD org binding (bare org string the WHEP subscribe reads) + the
// REVERSE per-org discovery index, compensates (deletes the orphan input) when the required forward write fails,
// and maps every CF/KV failure to a typed non-2xx — never a half-provisioned success. Pure: injected fake fetch
// + fake KV, no real network/CF-API/KV.
import { describe, it, expect } from "vitest";
import {
  CfStreamLiveClientImpl,
  readOrgStreamInputs,
  ORG_STREAM_INPUTS_PREFIX,
  ORG_INDEX_MAX_ENTRIES,
  type StreamInputKv,
} from "../src/cf-stream-live-client.js";
import { STREAM_INPUT_ORG_PREFIX } from "../src/stream-bridge.js";
import type { CfStreamLiveIngestRequest } from "../src/ingress-cf-stream-live.js";

const UID = "28064cd43cee30dd62c728da2152c61d";

/** A fake KV with an optional set of keys whose `put` throws (to exercise compensation). */
function fakeKv(opts: { seed?: Record<string, string>; failPutPrefix?: string } = {}): StreamInputKv & {
  store: Map<string, string>;
} {
  const store = new Map<string, string>(Object.entries(opts.seed ?? {}));
  return {
    store,
    async get(k) {
      return store.get(k) ?? null;
    },
    async put(k, v) {
      if (opts.failPutPrefix && k.startsWith(opts.failPutPrefix)) throw new Error(`KV put boom for ${k}`);
      store.set(k, v);
    },
  };
}

/** A fake CF `fetch`: canned create-input success (+ optional override), records every call, 200 on DELETE. */
function fakeFetch(
  createReply: { status?: number; body?: unknown } = {},
): typeof fetch & { calls: { url: string; method: string }[] } {
  const calls: { url: string; method: string }[] = [];
  const fn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    calls.push({ url, method });
    if (method === "DELETE") return new Response("{}", { status: 200 });
    // POST create
    const status = createReply.status ?? 200;
    const body =
      createReply.body ??
      {
        success: true,
        errors: [],
        result: {
          uid: UID,
          rtmps: { url: "rtmps://live.cloudflare.com:443/live/", streamKey: "sk-abc" },
          srt: { url: "srt://live.cloudflare.com:778", streamId: UID },
          webRTC: { url: "https://customer-x.cloudflarestream.com/xyz/webRTC/publish" },
        },
      };
    return new Response(JSON.stringify(body), { status });
  }) as typeof fetch & { calls: { url: string; method: string }[] };
  fn.calls = calls;
  return fn;
}

const req = (over: Partial<CfStreamLiveIngestRequest> = {}): CfStreamLiveIngestRequest => ({
  room: "room-1",
  org: "acme",
  feed: { mode: "push", protocol: "rtmp" },
  ...over,
});

describe("CfStreamLiveClientImpl — createLiveInput", () => {
  it("creates the input, returns uid + rtmp/srt endpoints, writes forward + reverse KV", async () => {
    const kv = fakeKv();
    const fetchFn = fakeFetch();
    const client = new CfStreamLiveClientImpl({ accountId: "acct1", apiToken: "tok", kv, fetchFn, now: () => 1000 });

    const res = await client.createLiveInput(req());
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.input.uid).toBe(UID);
    const protocols = res.input.endpoints.map((e) => e.protocol).sort();
    expect(protocols).toEqual(["rtmp", "srt"]);
    const rtmp = res.input.endpoints.find((e) => e.protocol === "rtmp");
    expect(rtmp?.streamKey).toBe("sk-abc");

    // Forward binding is the BARE org string (what whep.ts resolveInputOrgMatch compares ===).
    expect(kv.store.get(`${STREAM_INPUT_ORG_PREFIX}${UID}`)).toBe("acme");
    // Reverse index has the entry.
    const idx = await readOrgStreamInputs(kv, "acme");
    expect(idx).toEqual([{ uid: UID, room: "room-1", createdAt: 1000 }]);
    // The POST create call targeted the account's live_inputs.
    expect(fetchFn.calls[0].url).toContain("/accounts/acct1/stream/live_inputs");
    expect(fetchFn.calls[0].method).toBe("POST");
  });

  it("uses the DEFAULT global fetch bound to globalThis (regression: Illegal invocation)", async () => {
    // Reproduces the real runtime: Workers/undici `fetch` throws "Illegal invocation" unless called with
    // `this === globalThis`. The adapter must bind the default fetch, else `this.fetchFn(...)` leaks the
    // instance as `this`. Injected-fetch tests can't catch this — only the DEFAULT (uninjected) path does.
    const original = globalThis.fetch;
    const strictFetch = function (this: unknown, _input: RequestInfo | URL, init?: RequestInit) {
      if (this !== globalThis && this !== undefined) {
        throw new TypeError("Illegal invocation: function called with incorrect `this` reference.");
      }
      const method = (init?.method ?? "GET").toUpperCase();
      if (method === "DELETE") return Promise.resolve(new Response("{}", { status: 200 }));
      return Promise.resolve(
        new Response(
          JSON.stringify({
            success: true,
            errors: [],
            result: { uid: UID, rtmps: { url: "rtmps://x/live/", streamKey: "k" }, srt: { url: "srt://x:778" } },
          }),
          { status: 200 },
        ),
      );
    } as unknown as typeof fetch;
    globalThis.fetch = strictFetch;
    try {
      const kv = fakeKv();
      // NO fetchFn injected → exercises the constructor's `fetch.bind(globalThis)` default.
      const client = new CfStreamLiveClientImpl({ accountId: "acct1", apiToken: "tok", kv, now: () => 1 });
      const res = await client.createLiveInput(req());
      expect(res.ok).toBe(true);
    } finally {
      globalThis.fetch = original;
    }
  });

  it("reverse index is newest-first, deduped by uid, capped", async () => {
    const kv = fakeKv();
    let t = 0;
    const client = new CfStreamLiveClientImpl({ accountId: "a", apiToken: "t", kv, fetchFn: fakeFetch(), now: () => ++t });
    // Seed the reverse index past the cap with distinct uids.
    const seeded = Array.from({ length: ORG_INDEX_MAX_ENTRIES }, (_, i) => ({
      uid: `old${i}`.padEnd(32, "0"),
      room: "r",
      createdAt: i,
    }));
    kv.store.set(`${ORG_STREAM_INPUTS_PREFIX}acme`, JSON.stringify(seeded));

    await client.createLiveInput(req());
    const idx = await readOrgStreamInputs(kv, "acme");
    expect(idx.length).toBe(ORG_INDEX_MAX_ENTRIES); // capped
    expect(idx[0].uid).toBe(UID); // newest-first (prepended)
    // Newest-first + cap: the OLDEST seeded entry (old99, last in the list) fell off; old0 is still present.
    expect(idx.some((e) => e.uid === "old99".padEnd(32, "0"))).toBe(false);
    expect(idx.some((e) => e.uid === "old0".padEnd(32, "0"))).toBe(true);
  });

  it("maps a CF non-2xx to a typed {ok:false} with the status", async () => {
    const kv = fakeKv();
    const client = new CfStreamLiveClientImpl({
      accountId: "a",
      apiToken: "t",
      kv,
      fetchFn: fakeFetch({ status: 403, body: { success: false, errors: [{ code: 9109, message: "forbidden" }] } }),
    });
    const res = await client.createLiveInput(req());
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.status).toBe(403);
    expect(res.reason).toContain("9109");
    // No KV written on a failed create.
    expect(kv.store.size).toBe(0);
  });

  it("rejects a create reply with no/invalid uid (502) and writes no KV", async () => {
    const kv = fakeKv();
    const client = new CfStreamLiveClientImpl({
      accountId: "a",
      apiToken: "t",
      kv,
      fetchFn: fakeFetch({ body: { success: true, result: { uid: "not-hex" } } }),
    });
    const res = await client.createLiveInput(req());
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.status).toBe(502);
    expect(kv.store.size).toBe(0);
  });

  it("compensates (deletes the orphan input) when the required forward KV write fails → {ok:false,500}", async () => {
    const kv = fakeKv({ failPutPrefix: STREAM_INPUT_ORG_PREFIX });
    const fetchFn = fakeFetch();
    const client = new CfStreamLiveClientImpl({ accountId: "acct1", apiToken: "t", kv, fetchFn });
    const res = await client.createLiveInput(req());
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.status).toBe(500);
    // The just-created input was DELETEd (compensation) — no orphan on CF.
    const del = fetchFn.calls.find((c) => c.method === "DELETE");
    expect(del?.url).toContain(`/stream/live_inputs/${UID}`);
  });

  it("a reverse-index failure does NOT fail a valid provision (forward binding already subscribable)", async () => {
    const kv = fakeKv({ failPutPrefix: ORG_STREAM_INPUTS_PREFIX });
    const client = new CfStreamLiveClientImpl({ accountId: "a", apiToken: "t", kv, fetchFn: fakeFetch() });
    const res = await client.createLiveInput(req());
    expect(res.ok).toBe(true); // provision succeeds despite reverse-index write throwing
    expect(kv.store.get(`${STREAM_INPUT_ORG_PREFIX}${UID}`)).toBe("acme");
  });
});

describe("readOrgStreamInputs", () => {
  it("returns [] for absent and tolerates corrupt / non-array values", async () => {
    const kv = fakeKv({ seed: { [`${ORG_STREAM_INPUTS_PREFIX}bad`]: "{not json", [`${ORG_STREAM_INPUTS_PREFIX}obj`]: "{}" } });
    expect(await readOrgStreamInputs(kv, "missing")).toEqual([]);
    expect(await readOrgStreamInputs(kv, "bad")).toEqual([]);
    expect(await readOrgStreamInputs(kv, "obj")).toEqual([]);
  });
});
