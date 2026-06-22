// RT-P2.5 — Adapter C (managed) in PULL mode. begin() starts an RTK recording (RTK → its own storage) and
// returns a correlation-only handle; the byte-pull into our R2 happens later in the recording webhook
// (covered in rtk-webhook.test.ts). Injected fakes only — no live network, no live media.
import { describe, it, expect } from "vitest";
import {
  ManagedEncoder,
  DefaultManagedRecordingApi,
  PullManagedHandle,
  pullRecordingConfigured,
  type ManagedRecordingApi,
} from "../../src/encoders/managed.js";
import type { EncoderEnv } from "../../src/encoders/encoder.js";
import { sniffWebm, extFor } from "../../src/recording-writer.js";

const ORG = "11111111-1111-1111-1111-111111111111";
const SESSION = { org: ORG, room: "r1", sessionId: "sess-1" };
const ACC = "0123456789abcdef0123456789abcdef"; // HEX32
const APP = "6dee33e5-cd89-41e8-a81c-9a8cd48bb9c3"; // uuidish
const REC = "97cb480d-5840-4528-ace3-919b5e386c68"; // uuidish recording id
const RECORDINGS_URL = `https://api.cloudflare.com/client/v4/accounts/${ACC}/realtime/kit/${APP}/recordings`;

/** Truthy stand-ins for the bindings the join-path gate checks (never used as real R2/KV here). */
const R2 = {} as unknown as R2Bucket;
const KV = {} as unknown as KVNamespace;

/** A fake fetch that scripts the recording REST surface; records each call for assertion. */
function rtkFetch(opts: { startOk?: boolean; downloadUrl?: string | null; getOk?: boolean } = {}) {
  const calls: Array<{ method: string; url: string; body?: unknown }> = [];
  const impl = (async (input: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(init.body as string) : undefined;
    calls.push({ method, url: input, body });
    const json = (o: unknown, ok = true, status = 200) =>
      new Response(JSON.stringify(o), { status, headers: { "Content-Type": "application/json" } });
    if (method === "POST" && input === RECORDINGS_URL) {
      return opts.startOk === false ? json({ success: false }, false, 400) : json({ success: true, data: { id: REC, status: "INVOKED" } });
    }
    if (method === "GET" && input === `${RECORDINGS_URL}/${REC}`) {
      if (opts.getOk === false) return json({ success: false }, false, 404);
      return json({ success: true, data: { id: REC, status: "UPLOADED", download_url: opts.downloadUrl ?? "https://cf/r.mp4" } });
    }
    return json({ success: false }, false, 404);
  }) as unknown as typeof fetch;
  return { impl, calls };
}

describe("pullRecordingConfigured — the /rtk/join arm gate", () => {
  const full = (over: Partial<EncoderEnv> = {}): EncoderEnv => ({
    RT_RECORD: "1",
    CF_ACCOUNT_ID: ACC,
    RTK_APP_ID: APP,
    CF_API_TOKEN: "tok",
    RT_RECORDINGS: R2,
    RT_MEETING_ORG: KV,
    ...over,
  });
  it("true only when armed AND RTK creds AND the SKIP sink AND the meeting→org KV are all present", () => {
    expect(pullRecordingConfigured(full())).toBe(true);
    expect(pullRecordingConfigured(full({ RT_RECORD: "0" }))).toBe(false);
    expect(pullRecordingConfigured(full({ CF_ACCOUNT_ID: undefined }))).toBe(false);
    expect(pullRecordingConfigured(full({ CF_ACCOUNT_ID: "not-hex" }))).toBe(false);
    expect(pullRecordingConfigured(full({ CF_API_TOKEN: undefined }))).toBe(false);
    expect(pullRecordingConfigured(full({ RT_RECORDINGS: undefined }))).toBe(false);
    expect(pullRecordingConfigured(full({ RT_MEETING_ORG: undefined }))).toBe(false);
  });
});

describe("DefaultManagedRecordingApi (PULL) — RTK recording REST", () => {
  const env: EncoderEnv = { CF_ACCOUNT_ID: ACC, RTK_APP_ID: APP, CF_API_TOKEN: "tok", RT_RECORD: "1" };

  it("start POSTs meeting_id (NO storage_config — RTK uses its own storage) and returns data.id", async () => {
    const { impl, calls } = rtkFetch({});
    const api = new DefaultManagedRecordingApi(env, impl);
    const r = await api.start("meeting-xyz");
    expect(r.recordingId).toBe(REC);
    expect(calls[0]).toMatchObject({ method: "POST", url: RECORDINGS_URL, body: { meeting_id: "meeting-xyz" } });
    expect((calls[0].body as Record<string, unknown>).storage_config).toBeUndefined(); // never hand RTK an R2 dest
  });

  it("getDownloadUrl GETs the recording and returns download_url", async () => {
    const { impl, calls } = rtkFetch({ downloadUrl: "https://cf/final.mp4" });
    const api = new DefaultManagedRecordingApi(env, impl);
    expect(await api.getDownloadUrl(REC)).toBe("https://cf/final.mp4");
    expect(calls[0]).toMatchObject({ method: "GET", url: `${RECORDINGS_URL}/${REC}` });
  });

  it("getDownloadUrl → null on a non-success GET (best-effort, never throws)", async () => {
    const { impl } = rtkFetch({ getOk: false });
    const api = new DefaultManagedRecordingApi(env, impl);
    expect(await api.getDownloadUrl(REC)).toBeNull();
  });

  it("getDownloadUrl → null for a non-uuidish recording id (no network call)", async () => {
    const { impl, calls } = rtkFetch({});
    const api = new DefaultManagedRecordingApi(env, impl);
    expect(await api.getDownloadUrl("../etc/passwd")).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it("start fails CLOSED (throws) when creds are unconfigured — caller's begin() catches → records nothing", async () => {
    const api = new DefaultManagedRecordingApi({ RT_RECORD: "1" }); // no acc/app/token
    await expect(api.start("m")).rejects.toThrow(/not configured/);
  });

  it("fetchRecording passes redirect:'error' (SSRF: a 30x must not be followed past the host guard)", async () => {
    let seenInit: RequestInit | undefined;
    const impl = (async (_url: string, init?: RequestInit) => {
      seenInit = init;
      return new Response(new Uint8Array([1, 2, 3]), { status: 200 });
    }) as unknown as typeof fetch;
    const api = new DefaultManagedRecordingApi(env, impl);
    const body = await api.fetchRecording("https://cdn.example.com/r.mp4");
    expect(body).not.toBeNull();
    expect(seenInit?.redirect).toBe("error");
  });
});

describe("ManagedEncoder (C, PULL) — begin starts RTK + returns a correlation handle", () => {
  const fakeApi = (over: Partial<ManagedRecordingApi> = {}): ManagedRecordingApi => ({
    async start() {
      return { recordingId: "rec-1" };
    },
    async getDownloadUrl() {
      return null;
    },
    async fetchRecording() {
      return null;
    },
    ...over,
  });

  it("begin → null when disarmed (RT_RECORD !== '1')", async () => {
    const enc = new ManagedEncoder({ RT_RECORD: "0" }, fakeApi());
    expect(await enc.begin(SESSION)).toBeNull();
  });

  it("begin → PullManagedHandle carrying recordingId + org-rooted keyPrefix; finalize/abort/toMeta are no-ops", async () => {
    const enc = new ManagedEncoder({ RT_RECORD: "1" }, fakeApi());
    const h = (await enc.begin(SESSION)) as PullManagedHandle;
    expect(h).toBeInstanceOf(PullManagedHandle);
    expect(h.recordingId).toBe("rec-1");
    expect(h.keyPrefix).toBe(`${ORG}/realtime-recordings/sess-1/`);
    expect(await h.finalize()).toBeNull(); // the webhook owns the pull — nothing in-worker to finalize
    expect(h.toMeta()).toBeNull();
    await expect(h.abort()).resolves.toBeUndefined();
  });

  it("begin → null (fail-open) when RTK start throws — a start failure never throws the session down", async () => {
    const enc = new ManagedEncoder({ RT_RECORD: "1" }, fakeApi({ start: async () => { throw new Error("rtk down"); } }));
    expect(await enc.begin(SESSION)).toBeNull();
  });
});

describe("sniffWebm — container detection used by the pull writer", () => {
  it("detects an ISO-BMFF/MP4 ftyp box → mp4 (RTK composite recordings are mp4)", () => {
    const mp4 = new Uint8Array([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d]);
    expect(sniffWebm(mp4)).toBe("mp4");
    expect(extFor("mp4")).toBe("mp4");
  });
  it("still detects webm EBML magic, and falls back to raw/.bin otherwise", () => {
    expect(sniffWebm(new Uint8Array([0x1a, 0x45, 0xdf, 0xa3]))).toBe("webm");
    expect(sniffWebm(new Uint8Array([0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07]))).toBe("raw");
    expect(extFor("raw")).toBe("bin");
  });
});
