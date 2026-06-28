// E3.P2/P4 (#127) — unit tests for the gateway register() client (src/recordings-register.ts). Injected
// fetch, no live network. Proves: the payload shape for BOTH zones (org-prefixed key + residency-correct
// bucket + WaveZone), input validation (UUID org + org-prefix), unconfigured/network/non-2xx → fail-loud
// non-throwing result, and 200 → ok.
import { describe, it, expect, vi } from "vitest";
import { buildRegisterBody, registerRecording } from "../src/recordings-register.js";

const ENAM_ORG = "11111111-1111-4111-8111-111111111111";
const EU_ORG = "22222222-2222-4222-8222-222222222222";

describe("buildRegisterBody (#127)", () => {
  it("builds the enam payload (us-east → wave-recordings-enam), org-prefixed key, kind+protocol defaulted", () => {
    const body = buildRegisterBody({
      org: ENAM_ORG,
      r2Key: `${ENAM_ORG}/realtime-recordings/us-east/sess1/recording.webm`,
      bucket: "wave-recordings-enam",
      zone: "us-east",
    });
    expect(body).toEqual({
      principal: { org: ENAM_ORG },
      r2Key: `${ENAM_ORG}/realtime-recordings/us-east/sess1/recording.webm`,
      bucket: "wave-recordings-enam",
      zone: "us-east",
      kind: "recording",
      sourceProtocol: "whip",
    });
  });

  it("builds the eu payload (eu-west → wave-recordings-eu)", () => {
    const body = buildRegisterBody({
      org: EU_ORG,
      r2Key: `${EU_ORG}/realtime-recordings/eu-west/sess2/recording.webm`,
      bucket: "wave-recordings-eu",
      zone: "eu-west",
    });
    expect(body?.bucket).toBe("wave-recordings-eu");
    expect(body?.zone).toBe("eu-west");
    expect(body?.r2Key.startsWith(`${EU_ORG}/`)).toBe(true);
  });

  it("rejects a non-UUID org", () => {
    expect(buildRegisterBody({ org: "not-a-uuid", r2Key: "not-a-uuid/x", bucket: "b", zone: "us-east" })).toBeNull();
  });

  it("rejects a key not under the org prefix (storage-side tenant boundary)", () => {
    expect(
      buildRegisterBody({ org: ENAM_ORG, r2Key: `${EU_ORG}/realtime-recordings/x`, bucket: "b", zone: "us-east" }),
    ).toBeNull();
  });

  it("rejects empty bucket or zone", () => {
    expect(buildRegisterBody({ org: ENAM_ORG, r2Key: `${ENAM_ORG}/x`, bucket: "", zone: "us-east" })).toBeNull();
    expect(buildRegisterBody({ org: ENAM_ORG, r2Key: `${ENAM_ORG}/x`, bucket: "b", zone: "" })).toBeNull();
  });
});

describe("registerRecording (#127, fail-loud never-throws)", () => {
  const input = {
    org: ENAM_ORG,
    r2Key: `${ENAM_ORG}/realtime-recordings/us-east/sess1/recording.webm`,
    bucket: "wave-recordings-enam",
    zone: "us-east",
  };

  it("POSTs the right URL + bearer + body, returns ok on 200", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({ ok: true, recordingId: "rec-1", deduped: false }), { status: 200 });
    }) as unknown as typeof fetch;
    const res = await registerRecording(
      input,
      { gatewayOrigin: "https://api.wave.online", serviceToken: "svc-tok" },
      undefined,
      fetchImpl,
    );
    expect(res).toEqual({ ok: true, recordingId: "rec-1", deduped: false });
    expect(calls[0].url).toBe("https://api.wave.online/v1/internal/recordings/register");
    const h = calls[0].init.headers as Record<string, string>;
    expect(h.authorization).toBe("Bearer svc-tok");
    expect(JSON.parse(calls[0].init.body as string)).toMatchObject({ zone: "us-east", bucket: "wave-recordings-enam" });
  });

  it("returns fail (no throw) when unconfigured", async () => {
    const res = await registerRecording(input, { gatewayOrigin: "", serviceToken: "" });
    expect(res).toEqual({ ok: false, reason: "register_unconfigured" });
  });

  it("surfaces the gateway reason on a non-2xx (e.g. residency_bucket_mismatch), no throw", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ ok: false, reason: "residency_bucket_mismatch" }), { status: 403 }),
    ) as unknown as typeof fetch;
    const res = await registerRecording(
      input,
      { gatewayOrigin: "https://api.wave.online", serviceToken: "t" },
      undefined,
      fetchImpl,
    );
    expect(res).toEqual({ ok: false, reason: "residency_bucket_mismatch", status: 403 });
  });

  it("returns a network-error reason (no throw) when fetch rejects", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("boom");
    }) as unknown as typeof fetch;
    const res = await registerRecording(
      input,
      { gatewayOrigin: "https://api.wave.online", serviceToken: "t" },
      undefined,
      fetchImpl,
    );
    expect(res).toEqual({ ok: false, reason: "register_network_error" });
  });
});
