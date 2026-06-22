// RT-R-WH — the recording.statusUpdate webhook. REAL WebCrypto (no mocked crypto): we generate an RSA
// keypair in-test, export its SPKI PEM, sign a body with the private key, and prove the module verifies it
// with the public PEM exactly as it will verify CF's live signatures. No network: the handler's key source
// and observability sink are injected.
import { describe, it, expect, beforeAll } from "vitest";
import {
  verifyRtkSignature,
  parseRtkEvent,
  pemToDer,
  b64ToBytes,
  fetchWebhookPublicKeys,
  handleRecordingWebhook,
  type WebhookDeps,
} from "../src/rtk-webhook.js";
import worker from "../src/worker.js";

let keyPair: CryptoKeyPair;
let pem: string;
let otherPem: string;

function bytesToB64(buf: ArrayBuffer): string {
  const b = new Uint8Array(buf);
  let s = "";
  for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
  return btoa(s);
}
function spkiToPem(spki: ArrayBuffer): string {
  const lines = bytesToB64(spki).match(/.{1,64}/g)!.join("\n");
  return `-----BEGIN PUBLIC KEY-----\n${lines}\n-----END PUBLIC KEY-----`;
}
async function genKeyPem(): Promise<{ kp: CryptoKeyPair; pem: string }> {
  const kp = (await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  const spki = (await crypto.subtle.exportKey("spki", kp.publicKey)) as ArrayBuffer;
  return { kp, pem: spkiToPem(spki) };
}
async function sign(kp: CryptoKeyPair, body: string): Promise<string> {
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", kp.privateKey, new TextEncoder().encode(body));
  return bytesToB64(sig);
}

beforeAll(async () => {
  const a = await genKeyPem();
  keyPair = a.kp;
  pem = a.pem;
  otherPem = (await genKeyPem()).pem; // an UNRELATED key — must NOT verify our signatures
});

describe("verifyRtkSignature — RSA-SHA256 over the raw body", () => {
  it("verifies a genuine signature against the published PEM", async () => {
    const body = '{"event":"recording.statusUpdate","recording":{"id":"r","status":"UPLOADED"}}';
    const sig = await sign(keyPair, body);
    expect(await verifyRtkSignature(new TextEncoder().encode(body), sig, [pem])).toBe(true);
  });
  it("rejects a tampered body", async () => {
    const sig = await sign(keyPair, "original");
    expect(await verifyRtkSignature(new TextEncoder().encode("TAMPERED"), sig, [pem])).toBe(false);
  });
  it("rejects a signature made by a different key", async () => {
    const body = "hello";
    const sig = await sign(keyPair, body);
    expect(await verifyRtkSignature(new TextEncoder().encode(body), sig, [otherPem])).toBe(false);
  });
  it("verifies when the correct key is ONE of several published (rotation window)", async () => {
    const body = "rotate";
    const sig = await sign(keyPair, body);
    expect(await verifyRtkSignature(new TextEncoder().encode(body), sig, [otherPem, pem])).toBe(true);
  });
  it("fail-closed on garbage signature / empty inputs (never throws)", async () => {
    expect(await verifyRtkSignature(new TextEncoder().encode("x"), "!!!not-base64!!!", [pem])).toBe(false);
    expect(await verifyRtkSignature(new TextEncoder().encode("x"), "", [pem])).toBe(false);
  });
});

describe("pemToDer / b64ToBytes", () => {
  it("strips PEM armor and decodes to non-empty DER", () => {
    expect(pemToDer(pem).length).toBeGreaterThan(0);
  });
  it("b64ToBytes round-trips bytes", () => {
    expect(Array.from(b64ToBytes(btoa("AB")))).toEqual([65, 66]);
  });
});

describe("parseRtkEvent", () => {
  it("parses recording fields (camelCase)", () => {
    const e = parseRtkEvent(
      JSON.stringify({
        event: "recording.statusUpdate",
        recording: { id: "r1", status: "UPLOADED", downloadUrl: "u", outputFileName: "o.mp4", fileSize: 99, meetingId: "m1", recordingDuration: 12 },
      }),
    );
    expect(e).toEqual({
      event: "recording.statusUpdate",
      recording: { id: "r1", status: "UPLOADED", downloadUrl: "u", outputFileName: "o.mp4", fileSize: 99, meetingId: "m1", recordingDuration: 12 },
    });
  });
  it("returns null on invalid JSON or a missing recording id", () => {
    expect(parseRtkEvent("not json")).toBeNull();
    expect(parseRtkEvent(JSON.stringify({ event: "x", recording: { status: "UPLOADED" } }))).toBeNull();
  });
});

describe("fetchWebhookPublicKeys", () => {
  it("reads the PEM from data.publicKey of the well-known doc", async () => {
    const fake = (async () =>
      new Response(JSON.stringify({ success: true, data: { publicKey: pem } }), {
        headers: { "content-type": "application/json" },
      })) as unknown as typeof fetch;
    expect(await fetchWebhookPublicKeys(fake)).toEqual([pem]);
  });
  it("throws when no key is published (fail-closed)", async () => {
    const fake = (async () => new Response(JSON.stringify({ success: true, data: {} }))) as unknown as typeof fetch;
    await expect(fetchWebhookPublicKeys(fake)).rejects.toThrow();
  });
});

function webhookReq(body: string, headers: Record<string, string>): Request {
  return new Request("https://rt.wave.online/rtk/recording-webhook", { method: "POST", headers, body });
}
function deps(over: Partial<WebhookDeps> = {}): { deps: WebhookDeps; logs: Array<{ msg: string; fields: Record<string, unknown> }> } {
  const logs: Array<{ msg: string; fields: Record<string, unknown> }> = [];
  return {
    logs,
    deps: { keys: async () => [pem], subtle: crypto.subtle, log: (msg, fields) => logs.push({ msg, fields }), ...over },
  };
}

describe("handleRecordingWebhook — signed completion signal", () => {
  it("UPLOADED with a valid signature → 200 + logs rt-recording-uploaded (no keys fetched until sig present)", async () => {
    const body = JSON.stringify({ event: "recording.statusUpdate", recording: { id: "r9", status: "UPLOADED", fileSize: 4096, outputFileName: "out.mp4", meetingId: "m9" } });
    const sig = await sign(keyPair, body);
    const { deps: d, logs } = deps();
    const res = await handleRecordingWebhook(webhookReq(body, { "rtk-signature": sig, "rtk-uuid": "u9" }), d);
    expect(res.status).toBe(200);
    expect(logs[0].msg).toBe("rt-recording-uploaded");
    expect(logs[0].fields).toMatchObject({ id: "r9", meetingId: "m9", fileSize: 4096, outputFileName: "out.mp4", uuid: "u9" });
  });

  it("ERRORED with a valid signature → 200 + logs rt-recording-errored (failures are never swallowed)", async () => {
    const body = JSON.stringify({ event: "recording.statusUpdate", recording: { id: "rE", status: "ERRORED", meetingId: "mE" } });
    const sig = await sign(keyPair, body);
    const { deps: d, logs } = deps();
    const res = await handleRecordingWebhook(webhookReq(body, { "rtk-signature": sig }), d);
    expect(res.status).toBe(200);
    expect(logs[0].msg).toBe("rt-recording-errored");
  });

  it("missing rtk-signature → 401 WITHOUT fetching keys", async () => {
    let keysCalled = false;
    const { deps: d } = deps({ keys: async () => { keysCalled = true; return [pem]; } });
    const res = await handleRecordingWebhook(webhookReq("{}", {}), d);
    expect(res.status).toBe(401);
    expect(keysCalled).toBe(false);
  });

  it("bad signature → 401", async () => {
    const body = JSON.stringify({ recording: { id: "r", status: "UPLOADED" } });
    const wrong = await sign(keyPair, "a different body");
    const res = await handleRecordingWebhook(webhookReq(body, { "rtk-signature": wrong }), deps().deps);
    expect(res.status).toBe(401);
  });

  it("keys unavailable (well-known unreachable) → 503 fail-closed", async () => {
    const body = "{}";
    const sig = await sign(keyPair, body);
    const { deps: d } = deps({ keys: async () => { throw new Error("offline"); } });
    const res = await handleRecordingWebhook(webhookReq(body, { "rtk-signature": sig }), d);
    expect(res.status).toBe(503);
  });

  it("valid signature but unparseable payload → 400", async () => {
    const body = "not-json";
    const sig = await sign(keyPair, body);
    const res = await handleRecordingWebhook(webhookReq(body, { "rtk-signature": sig }), deps().deps);
    expect(res.status).toBe(400);
  });
});

describe("worker route /rtk/recording-webhook — public + self-authed", () => {
  const ctx = { waitUntil: () => {} } as unknown as ExecutionContext;
  it("is reachable WITHOUT x-wave-internal even when the gateway gate is armed, and 401s an unsigned POST", async () => {
    // No rtk-signature → 401 from the handler BEFORE any key fetch (so this stays offline). Critically this
    // is NOT the gateway 401 (UNAUTHORIZED) — it is the webhook's own UNSIGNED 401, proving the route bypasses
    // gatewayGate and authenticates itself.
    const req = new Request("https://rt.wave.online/rtk/recording-webhook", { method: "POST", body: "{}" });
    const res = await worker.fetch(req, { WAVE_INTERNAL_SECRET: "s3cret" } as never, ctx);
    expect(res.status).toBe(401);
    expect(((await res.json()) as Record<string, unknown>).error).toBe("UNSIGNED");
  });
});
