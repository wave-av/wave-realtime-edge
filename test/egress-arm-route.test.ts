// W1 HUB egress arm/teardown (wave-zoom#46) — the spoke-facing /v1/egress/arm + /v1/egress/teardown thin HTTP
// wrap. Proves: arm returns {ok,outputId,inputId} on a clean provision, 404 when either flag is off, 400 on a
// non-rtmp dest; teardown calls deleteOutput idempotently (404 from CF → still ok), emits the rtmp-out meter,
// is fail-open when the metering emit itself would reject, and stays INERT (no network call at all) when
// metering is unprovisioned.
import { describe, it, expect } from "vitest";
import { handleEgressArmRoute, maybeHandleEgressArmRoute, EGRESS_OUTPUT_ORG_PREFIX, type EgressArmRouteEnv } from "../src/egress-arm-route.js";
import { handleEgressDestinations, type EgressDestinationsEnv } from "../src/egress-destinations.js";
import type { StreamInputKv } from "../src/cf-stream-live-client.js";
import { STREAM_INPUT_ORG_PREFIX } from "../src/stream-bridge.js";
import type { CfStreamEgressClient, CfStreamEgressRequest, CfStreamEgressResult } from "../src/egress-cf-stream-passthrough.js";
import { zoomLegEventId } from "../src/egress-leg-metering.js";
import { gatewayGate, SAFE_ORG } from "../src/dispatch-helpers.js";

function base64Key(bytes = 32): string {
  const raw = crypto.getRandomValues(new Uint8Array(bytes));
  let bin = "";
  for (const b of raw) bin += String.fromCharCode(b);
  return btoa(bin);
}

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

function fakeClient(reply: CfStreamEgressResult = { ok: true, outputId: "lo-1" }): CfStreamEgressClient & {
  calls: CfStreamEgressRequest[];
} {
  const calls: CfStreamEgressRequest[] = [];
  return {
    calls,
    async provisionOutput(req) {
      calls.push(req);
      return reply;
    },
  };
}

const publicResolver = async (h: string) => (h === "live.example.com" ? ["93.184.216.34"] : []);
const SOURCE_UID = "28064cd43cee30dd62c728da2152c61d";

async function createRtmpDestination(kv: StreamInputKv, encKey: string, org: string): Promise<string> {
  const env: EgressDestinationsEnv = { EGRESS_DEST_MGMT_ENABLED: "1", DEST_KEY_ENCRYPTION_KEY: encKey, RT_MEETING_ORG: kv };
  const res = await handleEgressDestinations(
    new Request("https://edge/v1/egress/destinations", {
      method: "POST",
      body: JSON.stringify({ kind: "rtmp", url: "rtmp://live.example.com:1935/app", streamKey: "sk-live" }),
    }),
    env,
    org,
    { resolveHost: publicResolver },
  );
  expect(res?.status).toBe(201);
  const j = (await res!.json()) as { destination: { id: string } };
  return j.destination.id;
}

function baseEnv(over: Partial<EgressArmRouteEnv> = {}): EgressArmRouteEnv {
  return {
    EGRESS_ROUTER_ENABLED: "1",
    EGRESS_DEST_MGMT_ENABLED: "1",
    CF_ACCOUNT_ID: "acct-1",
    CF_STREAM_API_TOKEN: "tok-1",
    ...over,
  } as EgressArmRouteEnv;
}

describe("POST /v1/egress/arm", () => {
  it("provisions on the clean path and returns {ok, outputId, inputId}", async () => {
    const kv = fakeKv({ [`${STREAM_INPUT_ORG_PREFIX}${SOURCE_UID}`]: "acme" });
    const encKey = base64Key();
    const destId = await createRtmpDestination(kv, encKey, "acme");
    const client = fakeClient({ ok: true, outputId: "lo-42" });

    const res = await handleEgressArmRoute(
      new Request("https://edge/v1/egress/arm", {
        method: "POST",
        body: JSON.stringify({ destId, sourceUid: SOURCE_UID }),
      }),
      baseEnv({ DEST_KEY_ENCRYPTION_KEY: encKey, RT_MEETING_ORG: kv }),
      "acme",
      { resolveHost: publicResolver, cfClient: client },
    );

    expect(res?.status).toBe(200);
    const body = (await res!.json()) as { ok: boolean; outputId: string; inputId: string };
    expect(body).toEqual({ ok: true, outputId: "lo-42", inputId: SOURCE_UID });
    expect(client.calls).toHaveLength(1);
    expect(client.calls[0].sessionId).toBe(`cfstream:${SOURCE_UID}`);
    // wre#323 HIGH fix — the outputId->org binding teardown will later verify.
    expect(kv.store.get(`${EGRESS_OUTPUT_ORG_PREFIX}lo-42`)).toBe("acme");
  });

  it("403s a sourceUid owned by a DIFFERENT org (wre#323 HIGH fix — cross-org arm)", async () => {
    const kv = fakeKv({ [`${STREAM_INPUT_ORG_PREFIX}${SOURCE_UID}`]: "org-b" });
    const encKey = base64Key();
    const destId = await createRtmpDestination(kv, encKey, "acme");
    const client = fakeClient();

    const res = await handleEgressArmRoute(
      new Request("https://edge/v1/egress/arm", {
        method: "POST",
        body: JSON.stringify({ destId, sourceUid: SOURCE_UID }),
      }),
      baseEnv({ DEST_KEY_ENCRYPTION_KEY: encKey, RT_MEETING_ORG: kv }),
      "acme", // caller is org "acme"; sourceUid is owned by "org-b"
      { resolveHost: publicResolver, cfClient: client },
    );

    expect(res?.status).toBe(403);
    expect(client.calls).toHaveLength(0); // never reaches CF provision
  });

  it("403s a sourceUid with NO known owner (never-provisioned uid), same as a foreign-org owner", async () => {
    const kv = fakeKv(); // no stream-input-org: binding at all
    const encKey = base64Key();
    const destId = await createRtmpDestination(kv, encKey, "acme");
    const client = fakeClient();

    const res = await handleEgressArmRoute(
      new Request("https://edge/v1/egress/arm", {
        method: "POST",
        body: JSON.stringify({ destId, sourceUid: SOURCE_UID }),
      }),
      baseEnv({ DEST_KEY_ENCRYPTION_KEY: encKey, RT_MEETING_ORG: kv }),
      "acme",
      { resolveHost: publicResolver, cfClient: client },
    );

    expect(res?.status).toBe(403);
    expect(client.calls).toHaveLength(0);
  });

  it("400s on a non-rtmp destination", async () => {
    const kv = fakeKv();
    const encKey = base64Key();
    const env: EgressDestinationsEnv = { EGRESS_DEST_MGMT_ENABLED: "1", DEST_KEY_ENCRYPTION_KEY: encKey, RT_MEETING_ORG: kv };
    const created = await handleEgressDestinations(
      new Request("https://edge/v1/egress/destinations", {
        method: "POST",
        body: JSON.stringify({ kind: "srt", url: "srt://live.example.com:9000", passphrase: "p" }),
      }),
      env,
      "acme",
      { resolveHost: publicResolver },
    );
    const { destination } = (await created!.json()) as { destination: { id: string } };

    const client = fakeClient();
    const res = await handleEgressArmRoute(
      new Request("https://edge/v1/egress/arm", {
        method: "POST",
        body: JSON.stringify({ destId: destination.id, sourceUid: SOURCE_UID }),
      }),
      baseEnv({ DEST_KEY_ENCRYPTION_KEY: encKey, RT_MEETING_ORG: kv }),
      "acme",
      { resolveHost: publicResolver, cfClient: client },
    );
    expect(res?.status).toBe(400);
    expect(client.calls).toHaveLength(0);
  });

  it("404s (route-level, no I/O) when EGRESS_ROUTER_ENABLED is off", async () => {
    const req = new Request("https://edge/v1/egress/arm", {
      method: "POST",
      headers: { "x-wave-org": "acme" },
      body: JSON.stringify({ destId: "whatever", sourceUid: SOURCE_UID }),
    });
    const res = await maybeHandleEgressArmRoute(req, baseEnv({ EGRESS_ROUTER_ENABLED: "0" }), gatewayGate, SAFE_ORG);
    expect(res).toBeNull(); // maybeHandle falls through (null) when INERT — dispatcher's 501 catch-all applies
  });

  it("404s when EGRESS_DEST_MGMT_ENABLED is off", async () => {
    const req = new Request("https://edge/v1/egress/arm", {
      method: "POST",
      headers: { "x-wave-org": "acme" },
      body: JSON.stringify({ destId: "whatever", sourceUid: SOURCE_UID }),
    });
    const res = await maybeHandleEgressArmRoute(req, baseEnv({ EGRESS_DEST_MGMT_ENABLED: "0" }), gatewayGate, SAFE_ORG);
    expect(res).toBeNull();
  });

  it("surfaces a refused arm (e.g. absent destId) as a distinct non-2xx, never a silent 200", async () => {
    const kv = fakeKv();
    const client = fakeClient();
    const res = await handleEgressArmRoute(
      new Request("https://edge/v1/egress/arm", {
        method: "POST",
        body: JSON.stringify({ destId: "does-not-exist", sourceUid: SOURCE_UID }),
      }),
      baseEnv({ DEST_KEY_ENCRYPTION_KEY: base64Key(), RT_MEETING_ORG: kv }),
      "acme",
      { resolveHost: publicResolver, cfClient: client },
    );
    expect(res?.status).toBe(404);
    expect(res?.status).not.toBe(200);
  });
});

describe("POST /v1/egress/teardown", () => {
  it("calls deleteOutput and emits the rtmp-out meter", async () => {
    const calls: Array<{ url: string; method?: string }> = [];
    const fetchFn: typeof fetch = async (input, init) => {
      const url = typeof input === "string" ? input : (input as URL).toString();
      calls.push({ url, method: init?.method });
      if (url.includes("/outputs/")) return new Response(null, { status: 200 });
      if (url.includes("/v1/internal/usage")) return new Response(JSON.stringify({ ok: true }), { status: 200 });
      return new Response("unexpected", { status: 500 });
    };

    const kv = fakeKv({ [`${EGRESS_OUTPUT_ORG_PREFIX}lo42`]: "acme" });
    const res = await handleEgressArmRoute(
      new Request("https://edge/v1/egress/teardown", {
        method: "POST",
        body: JSON.stringify({
          inputId: SOURCE_UID,
          outputId: "lo42",
          org: "acme",
          meetingUuid: "mtg-1",
          durationMs: 60_000,
        }),
      }),
      baseEnv({ GATEWAY_BASE_URL: "https://api.wave.online", WAVE_SERVICE_TOKEN: "svc-tok", RT_MEETING_ORG: kv }),
      "acme",
      { fetchFn },
    );

    expect(res?.status).toBe(200);
    expect(await res!.json()).toEqual({ ok: true });

    const deleteCall = calls.find((c) => c.url.includes("/outputs/"));
    expect(deleteCall?.method).toBe("DELETE");
    expect(deleteCall?.url).toContain(`/live_inputs/${SOURCE_UID}/outputs/lo42`);

    const meterCall = calls.find((c) => c.url.includes("/v1/internal/usage"));
    expect(meterCall).toBeDefined();
    // wre#323 HIGH fix — the binding is cleaned up once the output is actually torn down.
    expect(kv.store.has(`${EGRESS_OUTPUT_ORG_PREFIX}lo42`)).toBe(false);
  });

  it("is idempotent — a CF 404 on delete is still ok:true (already gone)", async () => {
    const fetchFn: typeof fetch = async (input) => {
      const url = typeof input === "string" ? input : (input as URL).toString();
      if (url.includes("/outputs/")) return new Response(null, { status: 404 });
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    };
    const kv = fakeKv({ [`${EGRESS_OUTPUT_ORG_PREFIX}logone`]: "acme" });
    const res = await handleEgressArmRoute(
      new Request("https://edge/v1/egress/teardown", {
        method: "POST",
        body: JSON.stringify({ inputId: SOURCE_UID, outputId: "logone", org: "acme", meetingUuid: "mtg-1" }),
      }),
      baseEnv({ RT_MEETING_ORG: kv }),
      "acme",
      { fetchFn },
    );
    expect(res?.status).toBe(200);
    expect(await res!.json()).toEqual({ ok: true });
  });

  it("is fail-open: teardown returns ok:true even when the metering POST itself would reject", async () => {
    const fetchFn: typeof fetch = async (input) => {
      const url = typeof input === "string" ? input : (input as URL).toString();
      if (url.includes("/outputs/")) return new Response(null, { status: 200 });
      if (url.includes("/v1/internal/usage")) throw new Error("gateway unreachable");
      return new Response("unexpected", { status: 500 });
    };
    const kv = fakeKv({ [`${EGRESS_OUTPUT_ORG_PREFIX}lo42`]: "acme" });
    const res = await handleEgressArmRoute(
      new Request("https://edge/v1/egress/teardown", {
        method: "POST",
        body: JSON.stringify({
          inputId: SOURCE_UID,
          outputId: "lo42",
          org: "acme",
          meetingUuid: "mtg-1",
          durationMs: 30_000,
        }),
      }),
      baseEnv({ GATEWAY_BASE_URL: "https://api.wave.online", WAVE_SERVICE_TOKEN: "svc-tok", RT_MEETING_ORG: kv }),
      "acme",
      { fetchFn },
    );
    expect(res?.status).toBe(200);
    expect(await res!.json()).toEqual({ ok: true });
  });

  it("stays INERT for metering (no /v1/internal/usage call) when GATEWAY_BASE_URL/WAVE_SERVICE_TOKEN are unprovisioned", async () => {
    const calls: string[] = [];
    const fetchFn: typeof fetch = async (input) => {
      const url = typeof input === "string" ? input : (input as URL).toString();
      calls.push(url);
      if (url.includes("/outputs/")) return new Response(null, { status: 200 });
      return new Response("unexpected — should never be called", { status: 500 });
    };
    const kv = fakeKv({ [`${EGRESS_OUTPUT_ORG_PREFIX}lo42`]: "acme" });
    const res = await handleEgressArmRoute(
      new Request("https://edge/v1/egress/teardown", {
        method: "POST",
        body: JSON.stringify({ inputId: SOURCE_UID, outputId: "lo42", org: "acme", meetingUuid: "mtg-1", durationMs: 30_000 }),
      }),
      baseEnv({ RT_MEETING_ORG: kv }), // no GATEWAY_BASE_URL / WAVE_SERVICE_TOKEN
      "acme",
      { fetchFn },
    );
    expect(res?.status).toBe(200);
    expect(calls.some((u) => u.includes("/v1/internal/usage"))).toBe(false);
  });

  it("emits the SAME event_id formula (zoomLegEventId) a redelivered teardown would reproduce — dedup-safe", () => {
    expect(zoomLegEventId("mtg-1", "rtmp-out")).toBe("zoom-egress:mtg-1:rtmp-out");
  });

  // wre#323 sec-review HIGH fix — cross-org teardown IDOR.
  it("403s a teardown when outputId is bound to a DIFFERENT org than the gateway-stamped caller", async () => {
    const calls: string[] = [];
    const fetchFn: typeof fetch = async (input) => {
      calls.push(typeof input === "string" ? input : (input as URL).toString());
      return new Response(null, { status: 200 });
    };
    const kv = fakeKv({ [`${EGRESS_OUTPUT_ORG_PREFIX}lo42`]: "org-b" });
    const res = await handleEgressArmRoute(
      new Request("https://edge/v1/egress/teardown", {
        method: "POST",
        // body asserts org "acme" — but the GATEWAY-STAMPED caller org (3rd arg) is what must be checked.
        body: JSON.stringify({ inputId: SOURCE_UID, outputId: "lo42", org: "acme", meetingUuid: "mtg-1" }),
      }),
      baseEnv({ RT_MEETING_ORG: kv }),
      "acme", // gateway-stamped caller; the binding says "org-b" owns lo42
      { fetchFn },
    );
    expect(res?.status).toBe(403);
    expect(calls).toHaveLength(0); // never reaches deleteOutput / CF
  });

  it("404s a teardown for an outputId with no known arm binding — never a silent success", async () => {
    const calls: string[] = [];
    const fetchFn: typeof fetch = async (input) => {
      calls.push(typeof input === "string" ? input : (input as URL).toString());
      return new Response(null, { status: 200 });
    };
    const kv = fakeKv(); // no binding at all for "lo42"
    const res = await handleEgressArmRoute(
      new Request("https://edge/v1/egress/teardown", {
        method: "POST",
        body: JSON.stringify({ inputId: SOURCE_UID, outputId: "lo42", org: "acme", meetingUuid: "mtg-1" }),
      }),
      baseEnv({ RT_MEETING_ORG: kv }),
      "acme",
      { fetchFn },
    );
    expect(res?.status).toBe(404);
    expect(calls).toHaveLength(0);
  });

  // wre#323 sec-review LOW fix — billing attribution: the metering emit must use the VERIFIED gateway-stamped
  // caller org, never the body-asserted `org` field (which the ownership check does not constrain).
  it("meters against the gateway-stamped callerOrg, NOT a mismatched body-asserted org field", async () => {
    let meterBody: unknown;
    const fetchFn: typeof fetch = async (input, init) => {
      const url = typeof input === "string" ? input : (input as URL).toString();
      if (url.includes("/outputs/")) return new Response(null, { status: 200 });
      if (url.includes("/v1/internal/usage")) {
        meterBody = JSON.parse(String(init?.body ?? "{}"));
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      return new Response("unexpected", { status: 500 });
    };
    const kv = fakeKv({ [`${EGRESS_OUTPUT_ORG_PREFIX}lo42`]: "acme" });
    const res = await handleEgressArmRoute(
      new Request("https://edge/v1/egress/teardown", {
        method: "POST",
        // body claims org "org-b" — a caller-controlled field the fix must NOT trust for billing.
        body: JSON.stringify({ inputId: SOURCE_UID, outputId: "lo42", org: "org-b", meetingUuid: "mtg-1", durationMs: 30_000 }),
      }),
      baseEnv({ GATEWAY_BASE_URL: "https://api.wave.online", WAVE_SERVICE_TOKEN: "svc-tok", RT_MEETING_ORG: kv }),
      "acme", // gateway-stamped caller — matches the outputId's bound owner
      { fetchFn },
    );
    expect(res?.status).toBe(200);
    expect((meterBody as { org?: string } | undefined)?.org).toBe("acme");
  });
});

describe("maybeHandleEgressArmRoute dispatch wrapper", () => {
  it("falls through (null) for an unrelated path", async () => {
    const req = new Request("https://edge/v1/whep/sources", { method: "GET" });
    const res = await maybeHandleEgressArmRoute(req, baseEnv(), gatewayGate, SAFE_ORG);
    expect(res).toBeNull();
  });

  it("400s a missing/malformed x-wave-org when flags are armed", async () => {
    const req = new Request("https://edge/v1/egress/arm", { method: "POST", body: "{}" });
    const res = await maybeHandleEgressArmRoute(req, baseEnv(), gatewayGate, SAFE_ORG);
    expect(res?.status).toBe(400);
  });
});
