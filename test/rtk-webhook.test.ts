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

// ── RT-P2.5 PULL mode — fetch the finished recording into OUR R2 at an org-rooted SKIP key. ───────────────
import {
  isSafePublicHttpsUrl,
  pullUploadedRecording,
  reconcilePending,
  UNATTRIBUTED_ORG,
  PENDING_PREFIX,
  MAX_PULL_ATTEMPTS,
  type RecordingPullSink,
  type RtkRecording,
} from "../src/rtk-webhook.js";

// In-memory R2 multipart fake (spies on get/put/delete to re-assert the SKIP invariant: the pull never
// touches a dedup/claim path — it only ever createMultipartUpload→uploadPart→complete on ONE key).
class FakeUpload {
  parts: Array<{ partNumber: number; size: number }> = [];
  completed: Array<{ partNumber: number; etag: string }> | null = null;
  aborted = false;
  constructor(public key: string, public uploadId: string) {}
  async uploadPart(partNumber: number, data: Uint8Array) {
    this.parts.push({ partNumber, size: data.length });
    return { partNumber, etag: `etag-${partNumber}` };
  }
  async complete(parts: Array<{ partNumber: number; etag: string }>) {
    this.completed = parts;
    return {} as R2Object;
  }
  async abort() {
    this.aborted = true;
  }
}
class FakeBucket {
  created: FakeUpload[] = [];
  getCalls = 0;
  putCalls = 0;
  deleteCalls = 0;
  private seq = 0;
  async createMultipartUpload(key: string) {
    const u = new FakeUpload(key, `upload-${++this.seq}`);
    this.created.push(u);
    return u as unknown as R2MultipartUpload;
  }
  resumeMultipartUpload(key: string, uploadId: string) {
    return new FakeUpload(key, uploadId) as unknown as R2MultipartUpload;
  }
  async get() {
    this.getCalls += 1;
    return null;
  }
  async put() {
    this.putCalls += 1;
    return {} as R2Object;
  }
  async delete() {
    this.deleteCalls += 1;
  }
  async head() {
    return null;
  }
}

const PULL_ORG = "22222222-2222-2222-2222-222222222222";
const MEETING = "meeting-abc";

/** A finished MP4 byte-stream (first bytes = ISO-BMFF ftyp so the recorder sniffs "mp4" → .mp4 key). */
function mp4Stream(totalBytes: number, chunkSize = 256 * 1024): ReadableStream<Uint8Array> {
  let offset = 0;
  let first = true;
  return new ReadableStream<Uint8Array>({
    pull(c) {
      if (offset >= totalBytes) {
        c.close();
        return;
      }
      const n = Math.min(chunkSize, totalBytes - offset);
      const buf = new Uint8Array(n);
      if (first) {
        buf.set([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70], 0); // ftyp box on the leading chunk
        first = false;
      }
      offset += n;
      c.enqueue(buf);
    },
  });
}

function pullSink(
  bucket: FakeBucket,
  over: Partial<RecordingPullSink> = {},
): RecordingPullSink {
  return {
    lookupOrg: async () => PULL_ORG,
    resolveDownloadUrl: async () => "https://cdn.example.com/rec.mp4",
    fetchRecording: async () => mp4Stream(8 * 1024 * 1024),
    bucket: bucket as unknown as R2Bucket,
    ...over,
  };
}

const REC_UPLOADED: RtkRecording = { id: "rec-9", status: "UPLOADED", meetingId: MEETING, downloadUrl: "https://cdn.example.com/rec.mp4" };

describe("isSafePublicHttpsUrl — SSRF guard for the download fetch", () => {
  it("allows https public hosts", () => {
    expect(isSafePublicHttpsUrl("https://cdn.example.com/rec.mp4")).toBe(true);
    expect(isSafePublicHttpsUrl("https://abc123.r2.cloudflarestorage.com/x")).toBe(true);
  });
  it("rejects non-https + private/reserved/loopback hosts", () => {
    expect(isSafePublicHttpsUrl("http://cdn.example.com/x")).toBe(false);
    expect(isSafePublicHttpsUrl("https://localhost/x")).toBe(false);
    expect(isSafePublicHttpsUrl("https://127.0.0.1/x")).toBe(false);
    expect(isSafePublicHttpsUrl("https://169.254.169.254/latest/meta-data")).toBe(false);
    expect(isSafePublicHttpsUrl("https://10.0.0.5/x")).toBe(false);
    expect(isSafePublicHttpsUrl("https://192.168.1.1/x")).toBe(false);
    expect(isSafePublicHttpsUrl("https://172.16.0.1/x")).toBe(false);
    expect(isSafePublicHttpsUrl("not a url")).toBe(false);
  });
  it("rejects ALL bracketed IPv6 literals (loopback, public, and IPv4-mapped/NAT64 smuggling)", () => {
    expect(isSafePublicHttpsUrl("https://[::1]/x")).toBe(false);
    expect(isSafePublicHttpsUrl("https://[2001:db8::1]/x")).toBe(false); // would-be public v6 literal — still rejected
    expect(isSafePublicHttpsUrl("https://[::ffff:169.254.169.254]/x")).toBe(false); // IPv4-mapped metadata
    expect(isSafePublicHttpsUrl("https://[fe80::1]/x")).toBe(false);
  });
});

describe("pullUploadedRecording — stream the finished recording into the SKIP sink", () => {
  it("org found → ONE canonical org-rooted .mp4 object, bytes preserved, NO dedup path touched", async () => {
    const b = new FakeBucket();
    const logs: Array<{ msg: string; fields: Record<string, unknown> }> = [];
    const res = await pullUploadedRecording(REC_UPLOADED, pullSink(b), (msg, fields) => logs.push({ msg, fields }));
    expect(res).not.toBeNull();
    expect(res!.key).toBe(`${PULL_ORG}/realtime-recordings/${MEETING}/recording.mp4`);
    expect(res!.container).toBe("mp4");
    expect(res!.bytes).toBe(8 * 1024 * 1024);
    expect(b.created).toHaveLength(1);
    expect(b.created[0].completed).not.toBeNull();
    expect(b.getCalls + b.putCalls + b.deleteCalls).toBe(0); // SKIP: no claim/_dup/refcount move
    expect(logs.some((l) => l.msg === "rt-pull-stored")).toBe(true);
  });

  it("org-map MISS → bytes preserved under __unattributed__/ + a loud alarm (never dropped)", async () => {
    const b = new FakeBucket();
    const logs: Array<{ msg: string; fields: Record<string, unknown> }> = [];
    const res = await pullUploadedRecording(
      REC_UPLOADED,
      pullSink(b, { lookupOrg: async () => null }),
      (msg, fields) => logs.push({ msg, fields }),
    );
    expect(res!.key).toBe(`${UNATTRIBUTED_ORG}/realtime-recordings/${MEETING}/recording.mp4`);
    expect(logs.some((l) => l.msg === "rt-pull-unattributed")).toBe(true);
  });

  it("uses the event's downloadUrl directly (no resolveDownloadUrl); falls back to resolve when absent", async () => {
    const b1 = new FakeBucket();
    let resolved = 0;
    await pullUploadedRecording(REC_UPLOADED, pullSink(b1, { resolveDownloadUrl: async () => { resolved++; return "https://cdn.example.com/r.mp4"; } }));
    expect(resolved).toBe(0); // event carried the URL

    const b2 = new FakeBucket();
    await pullUploadedRecording(
      { ...REC_UPLOADED, downloadUrl: undefined },
      pullSink(b2, { resolveDownloadUrl: async () => { resolved++; return "https://cdn.example.com/r.mp4"; } }),
    );
    expect(resolved).toBe(1); // had to resolve a fresh URL
  });

  it("unsafe (private/non-https) URL → null, nothing written", async () => {
    const b = new FakeBucket();
    const logs: Array<{ msg: string; fields: Record<string, unknown> }> = [];
    const res = await pullUploadedRecording(
      { ...REC_UPLOADED, downloadUrl: "http://169.254.169.254/x" },
      pullSink(b),
      (msg, fields) => logs.push({ msg, fields }),
    );
    expect(res).toBeNull();
    expect(b.created).toHaveLength(0);
    expect(logs.some((l) => l.msg === "rt-pull-skip-unsafe-url")).toBe(true);
  });

  it("empty body → null, never a 0-byte object", async () => {
    const b = new FakeBucket();
    const res = await pullUploadedRecording(REC_UPLOADED, pullSink(b, { fetchRecording: async () => mp4Stream(0) }));
    expect(res).toBeNull();
    expect(b.created).toHaveLength(0);
  });

  it("missing meetingId → null (cannot attribute), nothing fetched", async () => {
    const b = new FakeBucket();
    let fetched = 0;
    const res = await pullUploadedRecording(
      { ...REC_UPLOADED, meetingId: undefined },
      pullSink(b, { fetchRecording: async () => { fetched++; return mp4Stream(1024); } }),
    );
    expect(res).toBeNull();
    expect(fetched).toBe(0);
  });

  it("transient fetch error → RETHROWS (so the handler can let RTK retry); upload aborted", async () => {
    const b = new FakeBucket();
    await expect(
      pullUploadedRecording(REC_UPLOADED, pullSink(b, { fetchRecording: async () => { throw new Error("network"); } })),
    ).rejects.toThrow(/network/);
  });
});

describe("handleRecordingWebhook — PULL on UPLOADED (sink wired)", () => {
  it("UPLOADED with a sink → 200 + pulls the recording into our R2 (awaited when no waitUntil)", async () => {
    const b = new FakeBucket();
    const body = JSON.stringify({ event: "recording.statusUpdate", recording: { id: "r9", status: "UPLOADED", meetingId: MEETING, downloadUrl: "https://cdn.example.com/r.mp4" } });
    const sig = await sign(keyPair, body);
    const { deps: d, logs } = deps({ sink: pullSink(b) });
    const res = await handleRecordingWebhook(webhookReq(body, { "rtk-signature": sig }), d);
    expect(res.status).toBe(200);
    expect(b.created).toHaveLength(1);
    expect(b.created[0].key).toBe(`${PULL_ORG}/realtime-recordings/${MEETING}/recording.mp4`);
    expect(logs.some((l) => l.msg === "rt-pull-stored")).toBe(true);
  });

  it("a pull failure → 200 ack + alarm + a durable pending-pull record is enqueued (markPending)", async () => {
    const b = new FakeBucket();
    const pending: Array<{ recordingId: string; meetingId: string }> = [];
    const body = JSON.stringify({ event: "recording.statusUpdate", recording: { id: "rX", status: "UPLOADED", meetingId: MEETING, downloadUrl: "https://cdn.example.com/r.mp4" } });
    const sig = await sign(keyPair, body);
    const sink = pullSink(b, {
      fetchRecording: async () => { throw new Error("boom"); },
      markPending: async (recordingId, meetingId) => { pending.push({ recordingId, meetingId }); },
    });
    const { deps: d, logs } = deps({ sink });
    const res = await handleRecordingWebhook(webhookReq(body, { "rtk-signature": sig }), d);
    expect(res.status).toBe(200);
    expect(logs.some((l) => l.msg === "rt-pull-failed")).toBe(true);
    expect(pending).toEqual([{ recordingId: "rX", meetingId: MEETING }]); // durable retry seeded
  });

  it("UPLOADED with NO sink → 200 observe-only (no write attempted)", async () => {
    const body = JSON.stringify({ event: "recording.statusUpdate", recording: { id: "r0", status: "UPLOADED", meetingId: MEETING } });
    const sig = await sign(keyPair, body);
    const { deps: d, logs } = deps(); // no sink
    const res = await handleRecordingWebhook(webhookReq(body, { "rtk-signature": sig }), d);
    expect(res.status).toBe(200);
    expect(logs[0].msg).toBe("rt-recording-uploaded");
    expect(logs.some((l) => l.msg.startsWith("rt-pull"))).toBe(false);
  });
});

describe("parseRtkEvent — snake_case download_url tolerance", () => {
  it("accepts download_url (snake_case) as well as downloadUrl", () => {
    const e = parseRtkEvent(JSON.stringify({ event: "x", recording: { id: "r1", status: "UPLOADED", download_url: "https://cdn/x.mp4" } }));
    expect(e!.recording.downloadUrl).toBe("https://cdn/x.mp4");
  });
});

describe("pullUploadedRecording — leading zero-length chunk does not drop a real recording", () => {
  it("skips a leading empty chunk, still lands the mp4", async () => {
    const b = new FakeBucket();
    // A stream that emits a 0-length chunk BEFORE the ftyp data.
    let phase = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(c) {
        if (phase === 0) { phase = 1; c.enqueue(new Uint8Array(0)); return; }
        if (phase === 1) { phase = 2; const u = new Uint8Array(1024); u.set([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70], 0); c.enqueue(u); return; }
        c.close();
      },
    });
    const res = await pullUploadedRecording(REC_UPLOADED, pullSink(b, { fetchRecording: async () => stream }));
    expect(res).not.toBeNull();
    expect(res!.container).toBe("mp4");
    expect(res!.bytes).toBe(1024);
    expect(b.created).toHaveLength(1);
  });
});

// ── reconcilePending — the cron that recovers a recording whose POST-ack webhook pull failed. ─────────────
class FakeKV {
  store = new Map<string, string>();
  async get(k: string) {
    return this.store.get(k) ?? null;
  }
  async put(k: string, v: string) {
    this.store.set(k, v);
  }
  async delete(k: string) {
    this.store.delete(k);
  }
  async list({ prefix }: { prefix: string; cursor?: string }) {
    const keys = [...this.store.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name }));
    return { keys, list_complete: true, cursor: undefined };
  }
}

describe("reconcilePending — cron recovery of failed pulls", () => {
  it("re-pulls a pending record, lands the object, and CLEARS the pending key on success", async () => {
    const kv = new FakeKV();
    kv.store.set(`${PENDING_PREFIX}rec-1`, JSON.stringify({ meetingId: MEETING, attempts: 1 }));
    const b = new FakeBucket();
    const logs: Array<{ msg: string; fields: Record<string, unknown> }> = [];
    await reconcilePending(kv as unknown as KVNamespace, pullSink(b), (msg, fields) => logs.push({ msg, fields }));
    expect(b.created).toHaveLength(1);
    expect(b.created[0].key).toBe(`${PULL_ORG}/realtime-recordings/${MEETING}/recording.mp4`);
    expect(kv.store.has(`${PENDING_PREFIX}rec-1`)).toBe(false); // cleared on success
    expect(logs.some((l) => l.msg === "rt-pull-reconciled")).toBe(true);
  });

  it("a still-failing pull bumps attempts, then gives up loudly (and clears) at MAX_PULL_ATTEMPTS", async () => {
    const kv = new FakeKV();
    kv.store.set(`${PENDING_PREFIX}rec-2`, JSON.stringify({ meetingId: MEETING, attempts: 0 }));
    const b = new FakeBucket();
    const failing = pullSink(b, { fetchRecording: async () => { throw new Error("still down"); } });
    const logs: Array<{ msg: string; fields: Record<string, unknown> }> = [];
    const log = (msg: string, fields: Record<string, unknown>) => logs.push({ msg, fields });
    // Run cron ticks until the record is gone (gave up). Should take MAX_PULL_ATTEMPTS ticks.
    let ticks = 0;
    while (kv.store.has(`${PENDING_PREFIX}rec-2`) && ticks < MAX_PULL_ATTEMPTS + 2) {
      await reconcilePending(kv as unknown as KVNamespace, failing, log);
      ticks++;
    }
    expect(ticks).toBe(MAX_PULL_ATTEMPTS);
    expect(kv.store.has(`${PENDING_PREFIX}rec-2`)).toBe(false);
    expect(b.created).toHaveLength(0); // never wrote a byte
    expect(logs.some((l) => l.msg === "rt-pull-reconcile-giveup")).toBe(true);
  });

  it("drops a corrupt pending record without throwing", async () => {
    const kv = new FakeKV();
    kv.store.set(`${PENDING_PREFIX}rec-3`, "not-json");
    const b = new FakeBucket();
    await reconcilePending(kv as unknown as KVNamespace, pullSink(b));
    expect(kv.store.has(`${PENDING_PREFIX}rec-3`)).toBe(false);
    expect(b.created).toHaveLength(0);
  });
});
