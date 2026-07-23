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
});

describe("#293 vodRegisterProbe", () => {
  const cfg = { gatewayOrigin: "https://api.wave.example", serviceToken: "tok" };

  it("passes on a 2xx register", async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ recordingId: "rec_1", deduped: false }), { status: 200 })) as unknown as typeof fetch;
    const probe = vodRegisterProbe(cfg, fetchImpl);
    const receipt = await runLeg("vod-register", probe, () => 123);
    expect(receipt.verdict).toBe("pass");
    expect(receipt.markers).toMatchObject({ recordingId: "rec_1" });
  });

  it("fails on a non-2xx register", async () => {
    const fetchImpl = (async () => new Response(JSON.stringify({ reason: "residency_bucket_mismatch" }), { status: 403 })) as unknown as typeof fetch;
    const probe = vodRegisterProbe(cfg, fetchImpl);
    const receipt = await runLeg("vod-register", probe, () => 123);
    expect(receipt.verdict).toBe("fail");
    expect(receipt.markers).toMatchObject({ status: 403 });
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
});

describe("#293 not-yet-built legs stay explicit stubs", () => {
  it("ext-rtmp-out / ext-srt-out export no probe (harness default-stubs them)", () => {
    expect(extRtmpOutProbe).toBeUndefined();
    expect(extSrtOutProbe).toBeUndefined();
  });
});
