// W1 O3 (wre#289) — /v1/egress/destinations CRUD. Proves: POST rejects an SSRF-bad url (400, nothing persisted),
// POST encrypts+redacts a valid destination (201, streamKey NEVER in the response, ciphertext in KV), GET list
// is org-scoped (no cross-org leak), GET/{id} 404s absent + 403s foreign org, DELETE mirrors #310 (idempotent
// 200 absent, 403 foreign, cleans both KV keys), a misconfigured encryption key 503s (not silent plaintext),
// and `resolveDestinationForArm` decrypts correctly for the (future) O1/O2 arm consumer.
import { describe, it, expect } from "vitest";
import {
  DEST_ORG_INDEX_PREFIX,
  DEST_RECORD_PREFIX,
  handleEgressDestinations,
  maybeHandleEgressDestinations,
  resolveDestinationForArm,
  type EgressDestinationsEnv,
} from "../src/egress-destinations.js";
import type { StreamInputKv } from "../src/cf-stream-live-client.js";
import { gatewayGate } from "../src/dispatch-helpers.js";

const SAFE_ORG = /^[a-z0-9_-]+$/i;

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

function env(over: Partial<EgressDestinationsEnv> = {}): EgressDestinationsEnv {
  return {
    EGRESS_DEST_MGMT_ENABLED: "1",
    DEST_KEY_ENCRYPTION_KEY: base64Key(),
    RT_MEETING_ORG: fakeKv(),
    ...over,
  };
}

const resolveOk = async (h: string) => (h === "example.com" ? ["93.184.216.34"] : []);

const post = (body: unknown) =>
  new Request("https://edge/v1/egress/destinations", { method: "POST", body: JSON.stringify(body) });
const get = (path = "/v1/egress/destinations") => new Request(`https://edge${path}`, { method: "GET" });
const del = (path: string) => new Request(`https://edge${path}`, { method: "DELETE" });

describe("handleEgressDestinations — create", () => {
  it("rejects an SSRF-bad url (400) and persists NOTHING", async () => {
    const kv = fakeKv();
    const res = await handleEgressDestinations(
      post({ kind: "rtmp", url: "rtmp://127.0.0.1:1935/live", streamKey: "sk" }),
      env({ RT_MEETING_ORG: kv }),
      "acme",
    );
    expect(res?.status).toBe(400);
    expect(kv.store.size).toBe(0);
  });

  it("creates a destination: 201, streamKey redacted in the response, ciphertext-only in KV", async () => {
    const kv = fakeKv();
    const res = await handleEgressDestinations(
      post({ kind: "rtmp", url: "rtmp://example.com:1935/live/x", streamKey: "sk_live_abc123" }),
      env({ RT_MEETING_ORG: kv }),
      "acme",
      { resolveHost: resolveOk },
    );
    expect(res?.status).toBe(201);
    const j = (await res!.json()) as { destination: { id: string; streamKey?: string } };
    expect(j.destination.streamKey).toBe("[redacted]");

    const stored = [...kv.store.entries()].find(([k]) => k.startsWith(DEST_RECORD_PREFIX));
    expect(stored).toBeTruthy();
    const raw = JSON.parse(stored![1]);
    expect(raw.streamKeyEnc.ciphertext).toBeTruthy();
    expect(JSON.stringify(raw)).not.toContain("sk_live_abc123");
  });

  it("503s when DEST_KEY_ENCRYPTION_KEY is unconfigured — never stores plaintext", async () => {
    const kv = fakeKv();
    const res = await handleEgressDestinations(
      post({ kind: "rtmp", url: "rtmp://example.com:1935/live/x", streamKey: "sk" }),
      env({ RT_MEETING_ORG: kv, DEST_KEY_ENCRYPTION_KEY: undefined }),
      "acme",
      { resolveHost: resolveOk },
    );
    expect(res?.status).toBe(503);
    expect(kv.store.size).toBe(0);
  });

  it("rejects a bad kind (400)", async () => {
    const res = await handleEgressDestinations(post({ kind: "http", url: "http://x" }), env(), "acme");
    expect(res?.status).toBe(400);
  });
});

describe("handleEgressDestinations — list/get", () => {
  async function seedOne(org: string, kv: ReturnType<typeof fakeKv>, e: EgressDestinationsEnv) {
    const res = await handleEgressDestinations(
      post({ kind: "rtmp", url: "rtmp://example.com:1935/live/x", streamKey: "sk" }),
      e,
      org,
      { resolveHost: resolveOk },
    );
    const j = (await res!.json()) as { destination: { id: string } };
    return j.destination.id;
  }

  it("GET list is org-scoped (no cross-org leak)", async () => {
    const kv = fakeKv();
    const e = env({ RT_MEETING_ORG: kv });
    await seedOne("acme", kv, e);
    await seedOne("other", kv, e);
    const res = await handleEgressDestinations(get(), e, "acme");
    const j = (await res!.json()) as { destinations: { org: string }[] };
    expect(j.destinations).toHaveLength(1);
    expect(j.destinations[0]!.org).toBe("acme");
  });

  it("GET /{id} 404s when absent", async () => {
    const res = await handleEgressDestinations(get(`/v1/egress/destinations/${"a".repeat(8)}`), env(), "acme");
    expect(res?.status).toBe(404);
  });

  it("GET /{id} 403s on a foreign-org id", async () => {
    const kv = fakeKv();
    const e = env({ RT_MEETING_ORG: kv });
    const id = await seedOne("acme", kv, e);
    const res = await handleEgressDestinations(get(`/v1/egress/destinations/${id}`), e, "other-org");
    expect(res?.status).toBe(403);
  });
});

describe("handleEgressDestinations — delete (mirrors #310)", () => {
  it("idempotent 200 when the id is already absent", async () => {
    const res = await handleEgressDestinations(del(`/v1/egress/destinations/${"b".repeat(8)}`), env(), "acme");
    expect(res?.status).toBe(200);
    const j = (await res!.json()) as { ok: boolean };
    expect(j.ok).toBe(true);
  });

  it("403s on a foreign-org delete, then succeeds + cleans both KV keys for the owner", async () => {
    const kv = fakeKv();
    const e = env({ RT_MEETING_ORG: kv });
    const res = await handleEgressDestinations(
      post({ kind: "rtmp", url: "rtmp://example.com:1935/live/x" }),
      e,
      "acme",
      { resolveHost: resolveOk },
    );
    const { destination } = (await res!.json()) as { destination: { id: string } };

    const forbidden = await handleEgressDestinations(
      del(`/v1/egress/destinations/${destination.id}`),
      e,
      "other-org",
    );
    expect(forbidden?.status).toBe(403);

    const ok = await handleEgressDestinations(del(`/v1/egress/destinations/${destination.id}`), e, "acme");
    expect(ok?.status).toBe(200);
    expect(kv.store.has(`${DEST_RECORD_PREFIX}acme:${destination.id}`)).toBe(false);
    const idx = JSON.parse(kv.store.get(`${DEST_ORG_INDEX_PREFIX}acme`) ?? "[]");
    expect(idx).not.toContain(destination.id);
  });
});

describe("resolveDestinationForArm", () => {
  it("decrypts streamKey/passphrase for the arm path; returns null for absent/foreign-org", async () => {
    const kv = fakeKv();
    const e = env({ RT_MEETING_ORG: kv });
    const res = await handleEgressDestinations(
      post({ kind: "srt", url: "srt://example.com:9710?streamid=x", passphrase: "p4ss" }),
      e,
      "acme",
      { resolveHost: resolveOk },
    );
    const { destination } = (await res!.json()) as { destination: { id: string } };

    const resolved = await resolveDestinationForArm(e, "acme", destination.id);
    expect(resolved?.passphrase).toBe("p4ss");
    expect(await resolveDestinationForArm(e, "other-org", destination.id)).toBeNull();
    expect(await resolveDestinationForArm(e, "acme", "nope-nope")).toBeNull();
  });
});

describe("maybeHandleEgressDestinations — gating", () => {
  it("falls through (null) when EGRESS_DEST_MGMT_ENABLED is off", async () => {
    const res = await maybeHandleEgressDestinations(get(), env({ EGRESS_DEST_MGMT_ENABLED: "0" }), gatewayGate, SAFE_ORG);
    expect(res).toBeNull();
  });

  it("falls through (null) for an unrelated path", async () => {
    const res = await maybeHandleEgressDestinations(
      new Request("https://edge/v1/whep/sources"),
      env(),
      gatewayGate,
      SAFE_ORG,
    );
    expect(res).toBeNull();
  });
});
