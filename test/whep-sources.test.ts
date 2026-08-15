// WHEP-A — the /v1/whep/sources provision + discovery + teardown handler. Proves: GET lists the org's sources
// (org-scoped), POST provisions ONLY the cfStreamLive plane (whip → deferred → WRONG_PLANE; bad job → 400),
// DELETE tears down (best-effort CF delete + both KV keys cleaned, idempotent when unknown, 403 on foreign org),
// misconfig fails LOUD (503), a wrong method 405s, an unrecognized path falls through (null). Injected fake CF
// fetch + fake KV.
import { describe, it, expect } from "vitest";
import { handleWhepSources, maybeHandleWhepSources, type WhepSourcesEnv } from "../src/whep-sources.js";
import {
  ORG_STREAM_INPUTS_PREFIX,
  type StreamInputKv,
} from "../src/cf-stream-live-client.js";
import { STREAM_INPUT_ORG_PREFIX } from "../src/stream-bridge.js";
import { gatewayGate } from "../src/dispatch-helpers.js";

const UID = "28064cd43cee30dd62c728da2152c61d";
const SAFE_ORG = /^[a-z0-9_-]+$/i;

function fakeKv(seed: Record<string, string> = {}): StreamInputKv & { store: Map<string, string> } {
  const store = new Map<string, string>(Object.entries(seed));
  return {
    store,
    async get(k) {
      return store.get(k) ?? null;
    },
    async put(k, v) {
      store.set(k, v);
    },
    async delete(k) {
      store.delete(k);
    },
  };
}

function okFetch(): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    if ((init?.method ?? "GET").toUpperCase() === "DELETE") return new Response("{}", { status: 200 });
    return new Response(
      JSON.stringify({
        success: true,
        result: { uid: UID, rtmps: { url: "rtmps://x/live/", streamKey: "sk" }, srt: { url: "srt://x:778" } },
      }),
      { status: 200 },
    );
  }) as typeof fetch;
}

function env(over: Partial<WhepSourcesEnv> = {}): WhepSourcesEnv {
  return {
    INGRESS_ROUTER_ENABLED: "1",
    CF_ACCOUNT_ID: "acct1",
    CF_STREAM_API_TOKEN: "tok",
    RT_MEETING_ORG: fakeKv(),
    ...over,
  };
}

const post = (body: unknown) =>
  new Request("https://edge/v1/whep/sources", { method: "POST", body: JSON.stringify(body) });
const get = () => new Request("https://edge/v1/whep/sources", { method: "GET" });

describe("handleWhepSources", () => {
  it("GET lists ONLY the caller org's sources from the reverse index", async () => {
    const kv = fakeKv({
      [`${ORG_STREAM_INPUTS_PREFIX}acme`]: JSON.stringify([{ uid: UID, room: "r1", createdAt: 5 }]),
      [`${ORG_STREAM_INPUTS_PREFIX}other`]: JSON.stringify([{ uid: "z".repeat(32), room: "r9", createdAt: 9 }]),
    });
    const res = await handleWhepSources(get(), env({ RT_MEETING_ORG: kv }), "acme");
    expect(res?.status).toBe(200);
    const j = (await res!.json()) as { sources: { uid: string }[] };
    expect(j.sources).toEqual([{ uid: UID, room: "r1", createdAt: 5 }]); // no cross-org leak
  });

  it("POST rtmpPush provisions → 201 {uid, endpoints} and writes the forward org binding", async () => {
    const kv = fakeKv();
    const res = await handleWhepSources(
      post({ sourceKind: "rtmpPush", room: "room-1" }),
      env({ RT_MEETING_ORG: kv }),
      "acme",
      { fetchFn: okFetch(), now: () => 1 },
    );
    expect(res?.status).toBe(201);
    const j = (await res!.json()) as { uid: string; endpoints: { protocol: string }[] };
    expect(j.uid).toBe(UID);
    expect(j.endpoints.map((e) => e.protocol).sort()).toEqual(["rtmp", "srt"]);
    expect(kv.store.get(`${STREAM_INPUT_ORG_PREFIX}${UID}`)).toBe("acme");
  });

  it("POST whip source → deferred to the SFU plane → 409 WHEP_WRONG_PLANE", async () => {
    const res = await handleWhepSources(post({ sourceKind: "whip", room: "room-1" }), env(), "acme", {
      fetchFn: okFetch(),
    });
    expect(res?.status).toBe(409);
    const j = (await res!.json()) as { error: string };
    expect(j.error).toBe("WHEP_WRONG_PLANE");
  });

  it("POST with a bad room → 400 (unroutable)", async () => {
    const res = await handleWhepSources(post({ sourceKind: "rtmpPush", room: "" }), env(), "acme", {
      fetchFn: okFetch(),
    });
    expect(res?.status).toBe(400);
  });

  it("POST rejects a bad sourceKind at the boundary → 400", async () => {
    const res = await handleWhepSources(post({ sourceKind: "telepathy", room: "room-1" }), env(), "acme");
    expect(res?.status).toBe(400);
  });

  it("503 when CF creds are absent (config-no-silent-noop)", async () => {
    const res = await handleWhepSources(
      post({ sourceKind: "rtmpPush", room: "room-1" }),
      env({ CF_STREAM_API_TOKEN: "", CLOUDFLARE_STREAM_API_TOKEN: "" }),
      "acme",
    );
    expect(res?.status).toBe(503);
  });

  it("503 when the KV binding is missing", async () => {
    const res = await handleWhepSources(get(), env({ RT_MEETING_ORG: undefined }), "acme");
    expect(res?.status).toBe(503);
  });

  it("405 on an unsupported method for the path", async () => {
    const res = await handleWhepSources(
      new Request("https://edge/v1/whep/sources", { method: "PUT" }),
      env(),
      "acme",
    );
    expect(res?.status).toBe(405);
  });

  it("null (fall-through) for a path that is not /v1/whep/sources", async () => {
    const res = await handleWhepSources(new Request("https://edge/v1/whep/subscribe"), env(), "acme");
    expect(res).toBeNull();
  });

  it("propagates a CF provision failure as a typed non-2xx", async () => {
    const failFetch = (async () =>
      new Response(JSON.stringify({ success: false, errors: [{ code: 9109, message: "no" }] }), {
        status: 403,
      })) as typeof fetch;
    const res = await handleWhepSources(post({ sourceKind: "srtPush", room: "room-1" }), env(), "acme", {
      fetchFn: failFetch,
    });
    expect(res?.status).toBe(403);
    const j = (await res!.json()) as { error: string };
    expect(j.error).toBe("WHEP_SOURCE_PROVISION_FAILED");
  });

  describe("DELETE /v1/whep/sources/{uid} — teardown", () => {
    const del = (uid: string) => new Request(`https://edge/v1/whep/sources/${uid}`, { method: "DELETE" });

    it("calls bestEffortDeleteInput + cleans both KV keys, returns 200", async () => {
      const kv = fakeKv({
        [`${STREAM_INPUT_ORG_PREFIX}${UID}`]: "acme",
        [`${ORG_STREAM_INPUTS_PREFIX}acme`]: JSON.stringify([{ uid: UID, room: "r1", createdAt: 5 }]),
      });
      const calls: { url: string; method: string }[] = [];
      const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
        calls.push({ url: String(input), method: (init?.method ?? "GET").toUpperCase() });
        return new Response("{}", { status: 200 });
      }) as typeof fetch;

      const res = await handleWhepSources(del(UID), env({ RT_MEETING_ORG: kv }), "acme", { fetchFn });
      expect(res?.status).toBe(200);
      const j = (await res!.json()) as { ok: boolean; uid: string };
      expect(j).toEqual({ ok: true, uid: UID });

      expect(calls).toEqual([{ url: expect.stringContaining(`/stream/live_inputs/${UID}`), method: "DELETE" }]);
      expect(kv.store.has(`${STREAM_INPUT_ORG_PREFIX}${UID}`)).toBe(false);
      expect(kv.store.has(`${ORG_STREAM_INPUTS_PREFIX}acme`) && kv.store.get(`${ORG_STREAM_INPUTS_PREFIX}acme`)).not.toContain(UID);
    });

    it("is idempotent when uid is unknown — 200, no throw, no CF call", async () => {
      const kv = fakeKv();
      let cfCalled = false;
      const fetchFn = (async () => {
        cfCalled = true;
        return new Response("{}", { status: 200 });
      }) as typeof fetch;

      const res = await handleWhepSources(del(UID), env({ RT_MEETING_ORG: kv }), "acme", { fetchFn });
      expect(res?.status).toBe(200);
      const j = (await res!.json()) as { ok: boolean; uid: string };
      expect(j).toEqual({ ok: true, uid: UID });
      expect(cfCalled).toBe(false); // already-gone: never reaches the CF delete
    });

    it("403 when x-wave-org does not own the uid", async () => {
      const kv = fakeKv({ [`${STREAM_INPUT_ORG_PREFIX}${UID}`]: "other-org" });
      const res = await handleWhepSources(del(UID), env({ RT_MEETING_ORG: kv }), "acme", { fetchFn: okFetch() });
      expect(res?.status).toBe(403);
      // ownership untouched — no KV mutation on a rejected teardown.
      expect(kv.store.get(`${STREAM_INPUT_ORG_PREFIX}${UID}`)).toBe("other-org");
    });

    it("fails open on the CF call — bestEffortDeleteInput never throws, KV cleanup still happens", async () => {
      const kv = fakeKv({ [`${STREAM_INPUT_ORG_PREFIX}${UID}`]: "acme" });
      const throwingFetch = (async () => {
        throw new Error("network boom");
      }) as typeof fetch;
      const res = await handleWhepSources(del(UID), env({ RT_MEETING_ORG: kv }), "acme", { fetchFn: throwingFetch });
      expect(res?.status).toBe(200);
      expect(kv.store.has(`${STREAM_INPUT_ORG_PREFIX}${UID}`)).toBe(false);
    });

    it("400 WHEP_BAD_REQUEST on malformed percent-encoding — never a thrown 500", async () => {
      const kv = fakeKv();
      const req = new Request("https://edge/v1/whep/sources/%", { method: "DELETE" });
      const res = await handleWhepSources(req, env({ RT_MEETING_ORG: kv }), "acme", { fetchFn: okFetch() });
      expect(res?.status).toBe(400);
      const j = (await res!.json()) as { error: string };
      expect(j.error).toBe("WHEP_BAD_REQUEST");
    });

    it("400 WHEP_BAD_REQUEST when the decoded uid doesn't match the CF live-input shape", async () => {
      const kv = fakeKv();
      const res = await handleWhepSources(del("not-a-valid-uid"), env({ RT_MEETING_ORG: kv }), "acme", {
        fetchFn: okFetch(),
      });
      expect(res?.status).toBe(400);
      const j = (await res!.json()) as { error: string };
      expect(j.error).toBe("WHEP_BAD_REQUEST");
    });

    it("401/gateway-reject without x-wave-internal (dispatch wrapper)", async () => {
      const e = { ...env(), WAVE_INTERNAL_SECRET: "s3cret" };
      const res = await maybeHandleWhepSources(del(UID), e, gatewayGate, SAFE_ORG);
      expect(res?.status).toBe(401);
    });

    it("501 (null fall-through) when INGRESS_ROUTER_ENABLED is off (dispatch wrapper)", async () => {
      const e = { ...env({ INGRESS_ROUTER_ENABLED: undefined }) };
      const res = await maybeHandleWhepSources(del(UID), e, gatewayGate, SAFE_ORG);
      expect(res).toBeNull(); // route-dispatch falls through to the 501 catch-all when INERT
    });
  });
});
