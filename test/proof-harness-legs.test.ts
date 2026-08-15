// #293 — concrete leg probes wired to their REAL modules (CfStreamLiveClientImpl, registerRecording,
// rtmsHandshakeSignature) with injected fake fetch/KV — no live CF/gateway/Zoom network. Proves each probe's
// pass/fail mapping matches its underlying module's success/failure, and that the two not-yet-built legs
// stay explicit stubs (no probe exported) so runProofHarness backfills them.
import { describe, it, expect } from "vitest";
import { runLeg } from "../src/proof-harness.js";
import {
  rtmpInProbe,
  vodRegisterProbe,
  rtmsInProbe,
  extRtmpOutProbe,
  extSrtOutProbe,
  type StreamInputKv,
} from "../src/proof-harness-legs.js";

function fakeKv(): StreamInputKv {
  const store = new Map<string, string>();
  return {
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

function fakeFetchOk(result: unknown): typeof fetch {
  return (async () =>
    new Response(JSON.stringify({ success: true, result }), { status: 200 })) as unknown as typeof fetch;
}

function fakeFetchErr(status: number, body: unknown = {}): typeof fetch {
  return (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;
}

describe("#293 rtmpInProbe", () => {
  it("passes when CF returns a usable rtmps endpoint", async () => {
    const probe = rtmpInProbe({
      accountId: "acct",
      apiToken: "tok",
      kv: fakeKv(),
      fetchFn: fakeFetchOk({ uid: "28064cd43cee30dd62c728da2152c61d", rtmps: { url: "rtmp://live.example/x", streamKey: "sk" } }),
    });
    const receipt = await runLeg("rtmp-in", probe, () => 0);
    expect(receipt.verdict).toBe("pass");
    expect(receipt.markers).toMatchObject({ rtmpUrl: "rtmp://live.example/x" });
  });

  it("fails when CF create-input errors", async () => {
    const probe = rtmpInProbe({ accountId: "acct", apiToken: "tok", kv: fakeKv(), fetchFn: fakeFetchErr(502) });
    const receipt = await runLeg("rtmp-in", probe, () => 0);
    expect(receipt.verdict).toBe("fail");
  });

  it("fails when CF replies with no rtmp endpoint", async () => {
    const probe = rtmpInProbe({
      accountId: "acct",
      apiToken: "tok",
      kv: fakeKv(),
      fetchFn: fakeFetchOk({ uid: "28064cd43cee30dd62c728da2152c61d" }),
    });
    const receipt = await runLeg("rtmp-in", probe, () => 0);
    expect(receipt.verdict).toBe("fail");
    expect(receipt.note).toMatch(/no usable rtmp endpoint/);
  });

  it("best-effort DELETEs the created uid after a successful create (no leaked live input)", async () => {
    const calls: { method: string; url: string }[] = [];
    const fetchFn = (async (url: string, init?: RequestInit) => {
      calls.push({ method: init?.method ?? "GET", url: String(url) });
      if ((init?.method ?? "GET") === "DELETE") return new Response("{}", { status: 200 });
      return new Response(
        JSON.stringify({ success: true, result: { uid: "28064cd43cee30dd62c728da2152c61d", rtmps: { url: "rtmp://live.example/x", streamKey: "sk" } } }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;
    const probe = rtmpInProbe({ accountId: "acct", apiToken: "tok", kv: fakeKv(), fetchFn });
    const receipt = await runLeg("rtmp-in", probe, () => 0);
    expect(receipt.verdict).toBe("pass");
    const deleteCall = calls.find((c) => c.method === "DELETE");
    expect(deleteCall).toBeDefined();
    expect(deleteCall!.url).toContain("28064cd43cee30dd62c728da2152c61d");
  });
});

describe("#293 vodRegisterProbe", () => {
  const cfg = { gatewayOrigin: "https://api.wave.example", serviceToken: "tok" };
  const ALLOW_LISTED_BUCKETS = new Set(["wave-recordings-enam", "wave-recordings-eu"]);

  /** Fake gateway that enforces the SAME residency allow-list the real gateway enforces — the fake that
   *  would have caught the original bug (a fake that always 200s never would have). */
  function fakeGatewayEnforcingAllowlist(): typeof fetch {
    return (async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}"));
      if (!ALLOW_LISTED_BUCKETS.has(body.bucket)) {
        return new Response(JSON.stringify({ reason: "residency_bucket_mismatch" }), { status: 403 });
      }
      return new Response(JSON.stringify({ recordingId: "rec_1", deduped: false }), { status: 200 });
    }) as unknown as typeof fetch;
  }

  it("passes on a 2xx register (real allow-listed bucket)", async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ recordingId: "rec_1", deduped: false }), { status: 200 })) as unknown as typeof fetch;
    const probe = vodRegisterProbe(cfg, fetchImpl, { bucket: "wave-recordings-enam" });
    const receipt = await runLeg("vod-register", probe, () => 123);
    expect(receipt.verdict).toBe("pass");
    expect(receipt.markers).toMatchObject({ recordingId: "rec_1" });
  });

  it("passes against a fake that ENFORCES the residency allow-list — the default synthetic bucket is " +
    "deliberately non-allow-listed, so the expected 403 residency_bucket_mismatch proves reachable+authed " +
    "without writing a synthetic prod row (the bug: this used to report 'fail' on every real, healthy tick)", async () => {
    const probe = vodRegisterProbe(cfg, fakeGatewayEnforcingAllowlist()); // default (non-allow-listed) bucket
    const receipt = await runLeg("vod-register", probe, () => 123);
    expect(receipt.verdict).toBe("pass");
    expect(receipt.markers).toMatchObject({ reason: "residency_bucket_mismatch", status: 403 });
  });

  it("fails on a genuine non-residency rejection (e.g. auth failure)", async () => {
    const fetchImpl = (async () => new Response(JSON.stringify({ reason: "unauthorized" }), { status: 401 })) as unknown as typeof fetch;
    const probe = vodRegisterProbe(cfg, fetchImpl);
    const receipt = await runLeg("vod-register", probe, () => 123);
    expect(receipt.verdict).toBe("fail");
    expect(receipt.markers).toMatchObject({ status: 401 });
  });

  it("fails on a 403 that is NOT the expected residency_bucket_mismatch reason", async () => {
    const fetchImpl = (async () => new Response(JSON.stringify({ reason: "forbidden_org" }), { status: 403 })) as unknown as typeof fetch;
    const probe = vodRegisterProbe(cfg, fetchImpl);
    const receipt = await runLeg("vod-register", probe, () => 123);
    expect(receipt.verdict).toBe("fail");
    expect(receipt.markers).toMatchObject({ status: 403, reason: "forbidden_org" });
  });

  it("fails when unconfigured (no gatewayOrigin/serviceToken)", async () => {
    const fetchImpl = (async () => new Response("{}", { status: 200 })) as unknown as typeof fetch;
    const probe = vodRegisterProbe({}, fetchImpl);
    const receipt = await runLeg("vod-register", probe, () => 123);
    expect(receipt.verdict).toBe("fail");
    expect(receipt.markers.reason).toBe("register_unconfigured");
  });
});

describe("#293 rtmsInProbe", () => {
  it("passes with a well-formed 64-hex HMAC-SHA256 handshake signature", async () => {
    const probe = rtmsInProbe();
    const receipt = await runLeg("rtms-in", probe, () => 0);
    expect(receipt.verdict).toBe("pass");
    expect(receipt.markers.sigLen).toBe(64);
  });

  it("fails when the signature is malformed (not 64-hex) — the historical WebCrypto-unavailable failure mode", async () => {
    const badSignFn = (async () => "not-a-hex-signature") as unknown as typeof import("../src/rtms-auth.js").rtmsHandshakeSignature;
    const probe = rtmsInProbe("proof-harness", "proof-harness-secret", badSignFn);
    const receipt = await runLeg("rtms-in", probe, () => 0);
    expect(receipt.verdict).toBe("fail");
    expect(receipt.note).toMatch(/not a 64-hex HMAC-SHA256/);
  });

  it("fails when the signature is empty/undefined", async () => {
    const badSignFn = (async () => undefined) as unknown as typeof import("../src/rtms-auth.js").rtmsHandshakeSignature;
    const probe = rtmsInProbe("proof-harness", "proof-harness-secret", badSignFn);
    const receipt = await runLeg("rtms-in", probe, () => 0);
    expect(receipt.verdict).toBe("fail");
  });
});

describe("#293 not-yet-built legs stay explicit stubs", () => {
  it("ext-rtmp-out / ext-srt-out export no probe (harness default-stubs them)", () => {
    expect(extRtmpOutProbe).toBeUndefined();
    expect(extSrtOutProbe).toBeUndefined();
  });
});
