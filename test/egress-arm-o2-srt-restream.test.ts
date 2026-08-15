// W1 SLICE-2B O2 (wre#288) — external-SRT restream arm wiring (egress-arm.ts). Mirrors
// egress-arm-o1-restream.test.ts EXACTLY but for the SRT/NVENC path: proves armExternalSrtRestream refuses
// (404, no dispatch) for an absent/foreign-org destId; refuses (400) on a kind mismatch; refuses (403, no
// dispatch) when SSRF-at-connect rejects a rebound destination; dispatches the injected RunpodNvencClient on a
// clean path WITH the resolved destination attached; surfaces a non-ok NVENC reply as a typed refusal; fails
// closed when resolveDestinationForArm throws; and stays INERT (no lookups, no dispatch) with either flag off.
// Also confirms validateDestinationUrl (via assertDestinationSafeAtConnect) accepts a public srt:// host.
import { describe, it, expect } from "vitest";
import {
  assertDestinationSafeAtConnect,
  armExternalSrtRestream,
  type ExternalSrtRestreamArmEnv,
} from "../src/egress-arm.js";
import { handleEgressDestinations, type EgressDestinationsEnv } from "../src/egress-destinations.js";
import type { StreamInputKv } from "../src/cf-stream-live-client.js";
import type { RunpodNvencClient, RunpodNvencEncodeRequest, RunpodNvencResult } from "../src/egress-runpod-nvenc.js";

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

function fakeClient(
  reply: RunpodNvencResult = { ok: true, streamed: true, codec: "hevc", gpuSeconds: 3 },
): RunpodNvencClient & { calls: RunpodNvencEncodeRequest[] } {
  const calls: RunpodNvencEncodeRequest[] = [];
  return {
    calls,
    async encode(req) {
      calls.push(req);
      return reply;
    },
  };
}

const BASE_REQUEST: Omit<RunpodNvencEncodeRequest, "destination"> = {
  width: 3840,
  height: 2160,
  codec: "hevc",
  output: "simulcast",
  latency: "realTime",
  sources: [{ participantId: "p1", trackName: "cam-1", bytes: new Uint8Array([1, 2, 3]), ts: 1000 }],
};

/** Create a real SRT destination through the actual create flow (SSRF-checked at create time), returning its id. */
async function createSrtDestination(
  kv: StreamInputKv,
  encKey: string,
  org: string,
  resolveHost: (h: string) => Promise<string[]>,
): Promise<string> {
  const env: EgressDestinationsEnv = { EGRESS_DEST_MGMT_ENABLED: "1", DEST_KEY_ENCRYPTION_KEY: encKey, RT_MEETING_ORG: kv };
  const res = await handleEgressDestinations(
    new Request("https://edge/v1/egress/destinations", {
      method: "POST",
      body: JSON.stringify({ kind: "srt", url: "srt://live.example.com:9000", passphrase: "srt-pass" }),
    }),
    env,
    org,
    { resolveHost },
  );
  expect(res?.status).toBe(201);
  const j = (await res!.json()) as { destination: { id: string } };
  return j.destination.id;
}

function armEnv(over: Partial<ExternalSrtRestreamArmEnv> = {}): ExternalSrtRestreamArmEnv {
  return {
    EGRESS_ROUTER_ENABLED: "1",
    EGRESS_DEST_MGMT_ENABLED: "1",
    ...over,
  } as ExternalSrtRestreamArmEnv;
}

describe("assertDestinationSafeAtConnect — srt:// scheme acceptance + DNS-rebind re-check", () => {
  it("passes a public srt:// host at connect time (confirms validateDestinationUrl accepts kind='srt')", async () => {
    const stableResolver = async (h: string) => (h === "live.example.com" ? ["93.184.216.34"] : []);
    const result = await assertDestinationSafeAtConnect(
      { kind: "srt", url: "srt://live.example.com:9000" },
      { resolveHost: stableResolver },
    );
    expect(result.ok).toBe(true);
  });

  it("REFUSES an srt:// dest that resolves to a link-local IP at connect (the rebind case)", async () => {
    const rebindResolver = async (h: string) => (h === "live.example.com" ? ["169.254.169.254"] : []);
    const result = await assertDestinationSafeAtConnect(
      { kind: "srt", url: "srt://live.example.com:9000" },
      { resolveHost: rebindResolver },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/disallowed|not allowed|denied/);
  });
});

describe("armExternalSrtRestream", () => {
  const publicResolver = async (h: string) => (h === "live.example.com" ? ["93.184.216.34"] : []);
  const rebindResolver = async (h: string) => (h === "live.example.com" ? ["169.254.169.254"] : []);

  it("dispatches on the clean path: resolves dest, SSRF-at-connect passes, calls encode() with destination attached", async () => {
    const kv = fakeKv();
    const encKey = base64Key();
    const destId = await createSrtDestination(kv, encKey, "acme", publicResolver);
    const client = fakeClient({ ok: true, streamed: true, codec: "hevc", gpuSeconds: 5 });

    const outcome = await armExternalSrtRestream(
      armEnv({ DEST_KEY_ENCRYPTION_KEY: encKey, RT_MEETING_ORG: kv }),
      "acme",
      destId,
      BASE_REQUEST,
      client,
      { resolveHost: publicResolver },
    );

    expect(outcome).toEqual({ status: "streamed", result: { ok: true, streamed: true, codec: "hevc", gpuSeconds: 5 } });
    expect(client.calls).toHaveLength(1);
    expect(client.calls[0]).toEqual({
      ...BASE_REQUEST,
      destination: { url: "srt://live.example.com:9000", passphrase: "srt-pass" },
    });
  });

  it("refuses (404) for an absent destId — NO dispatch", async () => {
    const kv = fakeKv();
    const client = fakeClient();
    const outcome = await armExternalSrtRestream(
      armEnv({ DEST_KEY_ENCRYPTION_KEY: base64Key(), RT_MEETING_ORG: kv }),
      "acme",
      "does-not-exist-00000000",
      BASE_REQUEST,
      client,
      { resolveHost: publicResolver },
    );
    expect(outcome.status).toBe("refused");
    if (outcome.status === "refused") expect(outcome.httpStatus).toBe(404);
    expect(client.calls).toHaveLength(0);
  });

  it("refuses (404) for a foreign-org destId — NO dispatch", async () => {
    const kv = fakeKv();
    const encKey = base64Key();
    const destId = await createSrtDestination(kv, encKey, "acme", publicResolver);
    const client = fakeClient();
    const outcome = await armExternalSrtRestream(
      armEnv({ DEST_KEY_ENCRYPTION_KEY: encKey, RT_MEETING_ORG: kv }),
      "someone-else",
      destId,
      BASE_REQUEST,
      client,
      { resolveHost: publicResolver },
    );
    expect(outcome.status).toBe("refused");
    if (outcome.status === "refused") expect(outcome.httpStatus).toBe(404);
    expect(client.calls).toHaveLength(0);
  });

  it("refuses (403) when SSRF-at-connect rejects a rebound destination — NO dispatch reaches the NVENC client", async () => {
    const kv = fakeKv();
    const encKey = base64Key();
    const destId = await createSrtDestination(kv, encKey, "acme", publicResolver);
    const client = fakeClient();
    const outcome = await armExternalSrtRestream(
      armEnv({ DEST_KEY_ENCRYPTION_KEY: encKey, RT_MEETING_ORG: kv }),
      "acme",
      destId,
      BASE_REQUEST,
      client,
      { resolveHost: rebindResolver }, // rebind at connect time, even though create-time passed
    );
    expect(outcome.status).toBe("refused");
    if (outcome.status === "refused") expect(outcome.httpStatus).toBe(403);
    expect(client.calls).toHaveLength(0);
  });

  it("surfaces a non-ok NVENC encode() reply as a typed refusal, never a throw", async () => {
    const kv = fakeKv();
    const encKey = base64Key();
    const destId = await createSrtDestination(kv, encKey, "acme", publicResolver);
    const client = fakeClient({ ok: false, status: 503, reason: "runpod endpoint unavailable" });
    const outcome = await armExternalSrtRestream(
      armEnv({ DEST_KEY_ENCRYPTION_KEY: encKey, RT_MEETING_ORG: kv }),
      "acme",
      destId,
      BASE_REQUEST,
      client,
      { resolveHost: publicResolver },
    );
    expect(outcome).toEqual({ status: "refused", httpStatus: 503, reason: "runpod endpoint unavailable" });
  });

  it("stays INERT (no lookups, no dispatch) when EGRESS_ROUTER_ENABLED is off", async () => {
    const kv = fakeKv();
    const encKey = base64Key();
    const destId = await createSrtDestination(kv, encKey, "acme", publicResolver);
    const client = fakeClient();
    const outcome = await armExternalSrtRestream(
      armEnv({ EGRESS_ROUTER_ENABLED: "0", DEST_KEY_ENCRYPTION_KEY: encKey, RT_MEETING_ORG: kv }),
      "acme",
      destId,
      BASE_REQUEST,
      client,
      { resolveHost: publicResolver },
    );
    expect(outcome).toEqual({ status: "refused", httpStatus: 404, reason: "external srt restream is not armed" });
    expect(client.calls).toHaveLength(0);
  });

  it("stays INERT when EGRESS_DEST_MGMT_ENABLED is off", async () => {
    const kv = fakeKv();
    const encKey = base64Key();
    const destId = await createSrtDestination(kv, encKey, "acme", publicResolver);
    const client = fakeClient();
    const outcome = await armExternalSrtRestream(
      armEnv({ EGRESS_DEST_MGMT_ENABLED: "0", DEST_KEY_ENCRYPTION_KEY: encKey, RT_MEETING_ORG: kv }),
      "acme",
      destId,
      BASE_REQUEST,
      client,
      { resolveHost: publicResolver },
    );
    expect(outcome.status).toBe("refused");
    expect(client.calls).toHaveLength(0);
  });

  it("refuses (400) a destination whose kind is not srt — NO dispatch", async () => {
    const kv = fakeKv();
    const encKey = base64Key();
    const env: EgressDestinationsEnv = { EGRESS_DEST_MGMT_ENABLED: "1", DEST_KEY_ENCRYPTION_KEY: encKey, RT_MEETING_ORG: kv };
    const res = await handleEgressDestinations(
      new Request("https://edge/v1/egress/destinations", {
        method: "POST",
        body: JSON.stringify({ kind: "rtmp", url: "rtmp://live.example.com:1935/app", streamKey: "sk" }),
      }),
      env,
      "acme",
      { resolveHost: publicResolver },
    );
    expect(res?.status).toBe(201);
    const j = (await res!.json()) as { destination: { id: string } };
    const destId = j.destination.id;

    const client = fakeClient();
    const outcome = await armExternalSrtRestream(
      armEnv({ DEST_KEY_ENCRYPTION_KEY: encKey, RT_MEETING_ORG: kv }),
      "acme",
      destId,
      BASE_REQUEST,
      client,
      { resolveHost: publicResolver },
    );
    expect(outcome.status).toBe("refused");
    if (outcome.status === "refused") {
      expect(outcome.httpStatus).toBe(400);
      expect(outcome.reason).toMatch(/kind/);
    }
    expect(client.calls).toHaveLength(0);
  });

  it("refuses (fail-closed, NO dispatch) when resolveDestinationForArm throws", async () => {
    const kv = fakeKv();
    const encKey = base64Key();
    const destId = await createSrtDestination(kv, encKey, "acme", publicResolver);
    const client = fakeClient();
    const outcome = await armExternalSrtRestream(
      // Missing DEST_KEY_ENCRYPTION_KEY → `getAesKey` throws inside `resolveDestinationForArm`.
      armEnv({ RT_MEETING_ORG: kv }),
      "acme",
      destId,
      BASE_REQUEST,
      client,
      { resolveHost: publicResolver },
    );
    expect(outcome.status).toBe("refused");
    if (outcome.status === "refused") expect(outcome.httpStatus).toBe(500);
    expect(client.calls).toHaveLength(0);
  });
});
