/**
 * LK-rip #77 — egress.completed emit test. After an UPLOADED pull lands byte-exact, the injected
 * emitEgressCompleted fires EXACTLY ONCE with the canonical key/bytes/org; it does NOT fire without a sink
 * or on a non-UPLOADED event. Real RSA keypair + real crypto.subtle (mirrors rtk-webhook.test.ts); the R2
 * bucket + RTK pull are faked so no network is touched.
 */
import { describe, it, expect, vi, beforeAll } from "vitest";
import { handleRecordingWebhook, type WebhookDeps, type RecordingPullSink } from "../src/rtk-webhook.js";

let pem: string;
let priv: CryptoKey;
beforeAll(async () => {
  const kp = (await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  priv = kp.privateKey;
  const spki = (await crypto.subtle.exportKey("spki", kp.publicKey)) as ArrayBuffer;
  const b64 = btoa(String.fromCharCode(...new Uint8Array(spki)));
  pem = `-----BEGIN PUBLIC KEY-----\n${b64.match(/.{1,64}/g)!.join("\n")}\n-----END PUBLIC KEY-----`;
});

async function signedReq(obj: unknown): Promise<Request> {
  const body = JSON.stringify(obj);
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", priv, new TextEncoder().encode(body));
  const sigB64 = btoa(String.fromCharCode(...new Uint8Array(sig)));
  return new Request("https://rt.wave.online/rtk/recording-webhook", {
    method: "POST",
    headers: { "rtk-signature": sigB64, "content-type": "application/json" },
    body,
  });
}

function fakeSink(): RecordingPullSink {
  const enc = new TextEncoder();
  const objects = new Map<string, number>();
  const bucket = {
    createMultipartUpload: async (key: string) => ({
      key,
      uploadId: "u1",
      uploadPart: async (n: number) => ({ partNumber: n, etag: `e${n}` }),
      complete: async () => void objects.set(key, 1),
      abort: async () => {},
    }),
    head: async (key: string) => (objects.has(key) ? {} : null),
  } as never;
  return {
    lookupOrg: async () => "org_abc",
    resolveDownloadUrl: async () => "https://cdn.example.com/r.mp4",
    fetchRecording: async () =>
      new ReadableStream<Uint8Array>({ start(c) { c.enqueue(enc.encode("hello-bytes")); c.close(); } }),
    bucket,
  };
}

const deps = (over: Partial<WebhookDeps>): WebhookDeps => ({ keys: async () => [pem], subtle: crypto.subtle, ...over });
const UPLOADED = { event: "recording.statusUpdate", recording: { id: "rec_1", status: "UPLOADED", meetingId: "m_1", downloadUrl: "https://cdn.example.com/r.mp4" } };

describe("LK-rip #77 egress.completed emit", () => {
  it("fires exactly once after a successful pull, with key/bytes/org", async () => {
    const emit = vi.fn(async () => {});
    const res = await handleRecordingWebhook(await signedReq(UPLOADED), deps({ sink: fakeSink(), emitEgressCompleted: emit }));
    expect(res.status).toBe(200);
    expect(emit).toHaveBeenCalledTimes(1);
    const calls = emit.mock.calls as unknown as Array<Array<{ egressId: string; org: string; bytes: number; key: string }>>;
    const arg = calls[0][0] as { egressId: string; org: string; bytes: number; key: string };
    expect(arg.egressId).toBe("m_1");
    expect(arg.org).toBe("org_abc");
    expect(arg.bytes).toBeGreaterThan(0);
    expect(arg.key).toContain("org_abc/realtime-recordings/m_1/");
  });
  it("does NOT emit when there is no sink (observe-only)", async () => {
    const emit = vi.fn(async () => {});
    await handleRecordingWebhook(await signedReq(UPLOADED), deps({ emitEgressCompleted: emit }));
    expect(emit).not.toHaveBeenCalled();
  });
  it("does NOT emit on a non-UPLOADED event", async () => {
    const emit = vi.fn(async () => {});
    const ev = { event: "recording.statusUpdate", recording: { id: "r", status: "RECORDING", meetingId: "m_1" } };
    await handleRecordingWebhook(await signedReq(ev), deps({ sink: fakeSink(), emitEgressCompleted: emit }));
    expect(emit).not.toHaveBeenCalled();
  });
});
