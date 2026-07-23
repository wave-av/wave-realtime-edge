// W1 SLICE-2B O1 (wre#287) — SSRF-at-connect + the external-RTMP restream arm wiring (egress-arm.ts). Proves:
// assertDestinationSafeAtConnect REFUSES a dest that resolves to a private/link-local IP at connect-time even
// though it passed the SSRF guard at create-time (the DNS-rebind gap this closes); armExternalRtmpRestream
// refuses (404, no provision call) for an absent/foreign-org destId; refuses (403, no provision call) when
// SSRF-at-connect rejects; provisions via the injected CfStreamEgressClient on a clean path; surfaces a non-2xx
// CF reply as a typed refusal; and stays INERT (no provision) with either flag off.
import { describe, it, expect } from "vitest";
import {
  assertDestinationSafeAtConnect,
  armExternalRtmpRestream,
  type ExternalRtmpRestreamArmEnv,
} from "../src/egress-arm.js";
import { handleEgressDestinations, type EgressDestinationsEnv } from "../src/egress-destinations.js";
import type { StreamInputKv } from "../src/cf-stream-live-client.js";
import type { CfStreamEgressClient, CfStreamEgressRequest, CfStreamEgressResult } from "../src/egress-cf-stream-passthrough.js";

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

const SESSION_ID = "cfstream:28064cd43cee30dd62c728da2152c61d";
const TARGET = { sessionId: SESSION_ID, trackName: "cam-1" };

/** Create a real destination through the actual create flow (SSRF-checked at create time), returning its id. */
async function createDestination(
  kv: StreamInputKv,
  encKey: string,
  org: string,
  resolveHost: (h: string) => Promise<string[]>,
): Promise<string> {
  const env: EgressDestinationsEnv = { EGRESS_DEST_MGMT_ENABLED: "1", DEST_KEY_ENCRYPTION_KEY: encKey, RT_MEETING_ORG: kv };
  const res = await handleEgressDestinations(
    new Request("https://edge/v1/egress/destinations", {
      method: "POST",
      body: JSON.stringify({ kind: "rtmp", url: "rtmp://live.example.com:1935/app", streamKey: "sk-live" }),
    }),
    env,
    org,
    { resolveHost },
  );
  expect(res?.status).toBe(201);
  const j = (await res!.json()) as { destination: { id: string } };
  return j.destination.id;
}

function armEnv(over: Partial<ExternalRtmpRestreamArmEnv> = {}): ExternalRtmpRestreamArmEnv {
  return {
    EGRESS_ROUTER_ENABLED: "1",
    EGRESS_DEST_MGMT_ENABLED: "1",
    ...over,
  } as ExternalRtmpRestreamArmEnv;
}

describe("assertDestinationSafeAtConnect — DNS-rebind re-check at connect time", () => {
  it("REFUSES a dest whose host resolves to a public IP at create but a link-local IP at connect (the rebind case)", async () => {
    // "create" would have used a resolver returning a public IP (see createDestination below); this proves the
    // CONNECT-time call, given a resolver that now returns link-local, independently rejects — never trusting a
    // stale create-time pass.
    const rebindResolver = async (h: string) => (h === "live.example.com" ? ["169.254.169.254"] : []);
    const result = await assertDestinationSafeAtConnect(
      { kind: "rtmp", url: "rtmp://live.example.com:1935/app" },
      { resolveHost: rebindResolver },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/disallowed|not allowed|denied/);
  });

  it("passes a dest that still resolves to a public IP at connect time", async () => {
    const stableResolver = async (h: string) => (h === "live.example.com" ? ["93.184.216.34"] : []);
    const result = await assertDestinationSafeAtConnect(
      { kind: "rtmp", url: "rtmp://live.example.com:1935/app" },
      { resolveHost: stableResolver },
    );
    expect(result.ok).toBe(true);
  });
});

describe("armExternalRtmpRestream", () => {
  const publicResolver = async (h: string) => (h === "live.example.com" ? ["93.184.216.34"] : []);
  const rebindResolver = async (h: string) => (h === "live.example.com" ? ["169.254.169.254"] : []);

  it("provisions on the clean path: resolves dest, SSRF-at-connect passes, calls provisionOutput with the correct request", async () => {
    const kv = fakeKv();
    const encKey = base64Key();
    const destId = await createDestination(kv, encKey, "acme", publicResolver);
    const client = fakeClient({ ok: true, outputId: "lo-42" });

    const outcome = await armExternalRtmpRestream(
      armEnv({ DEST_KEY_ENCRYPTION_KEY: encKey, RT_MEETING_ORG: kv }),
      "acme",
      destId,
      TARGET,
      client,
      { resolveHost: publicResolver },
    );

    expect(outcome).toEqual({ status: "provisioned", outputId: "lo-42" });
    expect(client.calls).toHaveLength(1);
    expect(client.calls[0]).toEqual({
      sessionId: SESSION_ID,
      trackName: "cam-1",
      output: "simulcast",
      rtmpDestination: "rtmp://live.example.com:1935/app/sk-live",
    });
  });

  it("refuses (404) for an absent destId — NO provision call", async () => {
    const kv = fakeKv();
    const client = fakeClient();
    const outcome = await armExternalRtmpRestream(
      armEnv({ DEST_KEY_ENCRYPTION_KEY: base64Key(), RT_MEETING_ORG: kv }),
      "acme",
      "does-not-exist-00000000",
      TARGET,
      client,
      { resolveHost: publicResolver },
    );
    expect(outcome.status).toBe("refused");
    if (outcome.status === "refused") expect(outcome.httpStatus).toBe(404);
    expect(client.calls).toHaveLength(0);
  });

  it("refuses (404) for a foreign-org destId — NO provision call", async () => {
    const kv = fakeKv();
    const encKey = base64Key();
    const destId = await createDestination(kv, encKey, "acme", publicResolver);
    const client = fakeClient();
    const outcome = await armExternalRtmpRestream(
      armEnv({ DEST_KEY_ENCRYPTION_KEY: encKey, RT_MEETING_ORG: kv }),
      "someone-else",
      destId,
      TARGET,
      client,
      { resolveHost: publicResolver },
    );
    expect(outcome.status).toBe("refused");
    if (outcome.status === "refused") expect(outcome.httpStatus).toBe(404);
    expect(client.calls).toHaveLength(0);
  });

  it("refuses (403) when SSRF-at-connect rejects a rebound destination — NO provision call reaches CF", async () => {
    const kv = fakeKv();
    const encKey = base64Key();
    const destId = await createDestination(kv, encKey, "acme", publicResolver);
    const client = fakeClient();
    const outcome = await armExternalRtmpRestream(
      armEnv({ DEST_KEY_ENCRYPTION_KEY: encKey, RT_MEETING_ORG: kv }),
      "acme",
      destId,
      TARGET,
      client,
      { resolveHost: rebindResolver }, // rebind at connect time, even though create-time passed
    );
    expect(outcome.status).toBe("refused");
    if (outcome.status === "refused") expect(outcome.httpStatus).toBe(403);
    expect(client.calls).toHaveLength(0);
  });

  it("surfaces a non-2xx CF provisionOutput reply as a typed refusal, never a throw", async () => {
    const kv = fakeKv();
    const encKey = base64Key();
    const destId = await createDestination(kv, encKey, "acme", publicResolver);
    const client = fakeClient({ ok: false, status: 401, reason: "cf api unauthorized" });
    const outcome = await armExternalRtmpRestream(
      armEnv({ DEST_KEY_ENCRYPTION_KEY: encKey, RT_MEETING_ORG: kv }),
      "acme",
      destId,
      TARGET,
      client,
      { resolveHost: publicResolver },
    );
    expect(outcome).toEqual({ status: "refused", httpStatus: 401, reason: "cf api unauthorized" });
  });

  it("stays INERT (no lookups, no provision) when EGRESS_ROUTER_ENABLED is off", async () => {
    const kv = fakeKv();
    const encKey = base64Key();
    const destId = await createDestination(kv, encKey, "acme", publicResolver);
    const client = fakeClient();
    const outcome = await armExternalRtmpRestream(
      armEnv({ EGRESS_ROUTER_ENABLED: "0", DEST_KEY_ENCRYPTION_KEY: encKey, RT_MEETING_ORG: kv }),
      "acme",
      destId,
      TARGET,
      client,
      { resolveHost: publicResolver },
    );
    expect(outcome).toEqual({ status: "refused", httpStatus: 404, reason: "external rtmp restream is not armed" });
    expect(client.calls).toHaveLength(0);
  });

  it("stays INERT when EGRESS_DEST_MGMT_ENABLED is off", async () => {
    const kv = fakeKv();
    const encKey = base64Key();
    const destId = await createDestination(kv, encKey, "acme", publicResolver);
    const client = fakeClient();
    const outcome = await armExternalRtmpRestream(
      armEnv({ EGRESS_DEST_MGMT_ENABLED: "0", DEST_KEY_ENCRYPTION_KEY: encKey, RT_MEETING_ORG: kv }),
      "acme",
      destId,
      TARGET,
      client,
      { resolveHost: publicResolver },
    );
    expect(outcome.status).toBe("refused");
    expect(client.calls).toHaveLength(0);
  });
});
