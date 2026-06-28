# WAVE Rooms — Guest Access & Room Security — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a customer's end-users (guests) join WAVE rooms securely via link/code without a WAVE key — capability tokens (WRT) + per-room-type admission + RoomDO safety ops.

**Architecture:** WSC mints a short-lived, room+role-scoped WAVE Room Token (WRT = a JWT signed HS256 with an HKDF-per-org key derived from one WAVE master secret). The gateway verifies WRTs (re-deriving the org key from the master), constrains them to their one room, stamps `x-wave-org`/`x-wave-role`, and forwards through the existing realtime path. The edge RoomDO enforces an `AdmissionPolicy` (knock/auto per room type) + a waiting room + universal safety ops (lock/eject/ban/capacity).

**Tech Stack:** Cloudflare Workers + Durable Objects (TypeScript), `jose` for JWS, WebCrypto `crypto.subtle` HKDF, vitest. Repos: `gateway`, `wave-realtime-edge`, `connect`.

**Spec:** `wave-realtime-edge/docs/superpowers/specs/2026-06-19-wave-rooms-guest-access-security-design.md` (APPROVED 2026-06-19).

---

## File structure

**`gateway`** (branch from `origin/main` — prod-critical; trust `gh api`, local main is stale)
- Create `src/wrt.ts` — pure WRT verify + HKDF org-key derivation (canonical algorithm; the SSOT).
- Create `test/wrt.spec.ts` — known-answer vectors + tamper/expiry/cross-org/revocation.
- Modify `src/worker.ts` — WRT credential branch in `handleRequest` (before x402 fallthrough); `POST /v1/realtime/room-keys` handler.
- Modify `src/realtime.ts` — stamp `x-wave-role` onto the realtime forward target.
- Modify `src/scopes.ts` — map `POST /v1/realtime/room-keys` → `realtime:write`.
- Modify `test/realtime.spec.ts` — `x-wave-role` stamping assertions.

**`wave-realtime-edge`** (branch from `main`)
- Modify `src/room.ts` — `AdmissionPolicy`, `RoomType`, waiting-room state, `admit/deny/eject/ban/lock/setCapacity/endRoom`, `joinRoom` gated by policy.
- Modify `src/signaling.ts` — `join` honors admission (knock → waiting, no SFU session yet); role from ctx.
- Modify `src/worker.ts` — read `x-wave-role`, pass `role` + room `type` in the DO ctx.
- Modify/extend `test/room.test.ts`, `test/signaling.test.ts`, `test/worker.sfu.test.ts`.

**`connect`** (branch → `staging`; `git -c core.hooksPath=/dev/null`)
- Create `src/services/realtime/wrt/WrtMintService.ts` — mint a WRT (HKDF org key via cached provisioning) — mirrors `wrt.ts` algorithm.
- Create `app/api/realtime/guest-token/route.ts` — authed guest-token endpoint (Supabase-authed host decides role/grants).
- Tests alongside. (Guest room PAGE/UI = design-agent lane, out of this plan.)

---

## Phase 1 — WRT crypto core (gateway, the SSOT)

### Task 1: HKDF per-org key derivation

**Files:** Create `gateway/src/wrt.ts`; Test `gateway/test/wrt.spec.ts`

- [ ] **Step 1: Failing test** — deterministic derivation + isolation

```ts
// test/wrt.spec.ts
import { describe, it, expect } from "vitest";
import { deriveOrgKey } from "../src/wrt";

const MASTER = "test-master-secret-0123456789abcdef0123456789abcdef";

describe("deriveOrgKey", () => {
  it("is deterministic for the same (master, org)", async () => {
    const a = await deriveOrgKey(MASTER, "org_alpha");
    const b = await deriveOrgKey(MASTER, "org_alpha");
    expect(Buffer.from(a).toString("hex")).toBe(Buffer.from(b).toString("hex"));
    expect(a.byteLength).toBe(32);
  });
  it("differs across orgs (per-tenant isolation)", async () => {
    const a = await deriveOrgKey(MASTER, "org_alpha");
    const b = await deriveOrgKey(MASTER, "org_beta");
    expect(Buffer.from(a).toString("hex")).not.toBe(Buffer.from(b).toString("hex"));
  });
});
```

- [ ] **Step 2: Run** `npx vitest run test/wrt.spec.ts` → FAIL (no `deriveOrgKey`).

- [ ] **Step 3: Implement**

```ts
// src/wrt.ts — WAVE Room Token: HKDF per-org key + JWS verify. The SSOT algorithm.
// One WAVE master secret; per-org HMAC key = HKDF-SHA256(master, salt="wrt-v1", info=org).
// Verify re-derives from the SAME master + the token's org → one trust root, O(1), no key store.
const SALT = new TextEncoder().encode("wrt-v1");

/** Derive the 32-byte per-org signing key from the WAVE master secret. */
export async function deriveOrgKey(master: string, org: string): Promise<Uint8Array> {
  const ikm = await crypto.subtle.importKey("raw", new TextEncoder().encode(master), "HKDF", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "HKDF", hash: "SHA-256", salt: SALT, info: new TextEncoder().encode(`org:${org}`) },
    ikm,
    256,
  );
  return new Uint8Array(bits);
}
```

- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `git add src/wrt.ts test/wrt.spec.ts && git commit -m "feat(wrt): HKDF per-org key derivation"`

### Task 2: WRT verify (claims + signature + room binding)

**Files:** Modify `gateway/src/wrt.ts`, `gateway/test/wrt.spec.ts`. Add dep `jose`.

- [ ] **Step 1: Failing test**

```ts
import { SignJWT } from "jose";
import { deriveOrgKey, verifyWrt } from "../src/wrt";

async function mint(claims: Record<string, unknown>, org = "org_alpha", ttl = 3600) {
  const key = await deriveOrgKey(MASTER, org);
  return new SignJWT({ org, ...claims })
    .setProtectedHeader({ alg: "HS256", kid: "wrt-v1" })
    .setIssuedAt().setExpirationTime(`${ttl}s`).setJti("jti-1").sign(key);
}

describe("verifyWrt", () => {
  it("accepts a valid token and returns the principal + claims", async () => {
    const tok = await mint({ room: "r1", pid: "p1", role: "viewer", grants: { canPublish: false, canSubscribe: true } });
    const r = await verifyWrt(MASTER, tok, { room: "r1", isRevoked: () => false });
    expect(r.ok).toBe(true);
    if (r.ok) { expect(r.org).toBe("org_alpha"); expect(r.role).toBe("viewer"); expect(r.pid).toBe("p1"); }
  });
  it("rejects a token whose room != the path room", async () => {
    const tok = await mint({ room: "r1", pid: "p1", role: "viewer" });
    expect((await verifyWrt(MASTER, tok, { room: "OTHER", isRevoked: () => false })).ok).toBe(false);
  });
  it("rejects a tampered signature (cross-org forgery)", async () => {
    const tok = await mint({ room: "r1", pid: "p1", role: "viewer" }, "org_alpha");
    // verify under a DIFFERENT org's derived key path by claiming org_beta but signed with alpha's key
    const forged = tok.replace(/\.[^.]+$/, ".AAAA");
    expect((await verifyWrt(MASTER, forged, { room: "r1", isRevoked: () => false })).ok).toBe(false);
  });
  it("rejects an expired token", async () => {
    const tok = await mint({ room: "r1", pid: "p1", role: "viewer" }, "org_alpha", -10);
    expect((await verifyWrt(MASTER, tok, { room: "r1", isRevoked: () => false })).ok).toBe(false);
  });
  it("rejects a revoked jti", async () => {
    const tok = await mint({ room: "r1", pid: "p1", role: "viewer" });
    expect((await verifyWrt(MASTER, tok, { room: "r1", isRevoked: (jti) => jti === "jti-1" })).ok).toBe(false);
  });
});
```

- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement** (append to `src/wrt.ts`)

```ts
import { jwtVerify, decodeJwt } from "jose";

export type WrtRole = "host" | "speaker" | "viewer";
export interface WrtGrants { canPublish: boolean; canSubscribe: boolean }
export type WrtResult =
  | { ok: true; org: string; room: string; pid: string; role: WrtRole; grants?: WrtGrants; name?: string; jti?: string }
  | { ok: false; code: string };

const ROLE_CEIL: Record<WrtRole, WrtGrants> = {
  host: { canPublish: true, canSubscribe: true },
  speaker: { canPublish: true, canSubscribe: true },
  viewer: { canPublish: false, canSubscribe: true },
};

/** Verify a WRT: re-derive the org key from master + the token's org claim, verify HS256, bind to room. */
export async function verifyWrt(
  master: string,
  token: string,
  opts: { room: string; isRevoked: (jti: string) => boolean },
): Promise<WrtResult> {
  let org: string;
  try { org = String(decodeJwt(token).org ?? ""); } catch { return { ok: false, code: "WRT_MALFORMED" }; }
  if (!org) return { ok: false, code: "WRT_NO_ORG" };
  const key = await deriveOrgKey(master, org);
  let payload: Record<string, unknown>;
  try { ({ payload } = await jwtVerify(token, key, { algorithms: ["HS256"] })); }
  catch { return { ok: false, code: "WRT_INVALID" }; } // covers bad sig + exp
  if (String(payload.org) !== org) return { ok: false, code: "WRT_ORG_MISMATCH" };
  if (String(payload.room) !== opts.room) return { ok: false, code: "WRT_ROOM_MISMATCH" };
  const jti = typeof payload.jti === "string" ? payload.jti : "";
  if (jti && opts.isRevoked(jti)) return { ok: false, code: "WRT_REVOKED" };
  const role = (["host", "speaker", "viewer"].includes(String(payload.role)) ? payload.role : "viewer") as WrtRole;
  // Grants may only NARROW the role ceiling, never widen (escalation defense).
  const ceil = ROLE_CEIL[role];
  const g = payload.grants as WrtGrants | undefined;
  const grants: WrtGrants = g
    ? { canPublish: g.canPublish && ceil.canPublish, canSubscribe: g.canSubscribe && ceil.canSubscribe }
    : ceil;
  return { ok: true, org, room: opts.room, pid: String(payload.pid ?? ""), role, grants, name: payload.name as string | undefined, jti };
}
```

- [ ] **Step 4: Run** → PASS (all 6).
- [ ] **Step 5: Commit** `git add src/wrt.ts test/wrt.spec.ts package.json && git commit -m "feat(wrt): verify WRT (claims, HS256, room-binding, role ceiling, revocation)"`

---

## Phase 2 — Gateway: WRT credential branch

### Task 3: Accept a WRT as an alternative credential on room routes

**Files:** Modify `gateway/src/worker.ts` (the `auth`/`who` block ~lines 560-578), `gateway/test/realtime.spec.ts`

Integration: after `validateKey` fails and BEFORE the x402 fallthrough, if the route is an SFU room route AND a bearer is present, try `verifyWrt`. On success, synthesize a room-constrained principal so the existing scope/meter/forward path runs unchanged (usage meters against the token's org — the customer pays for their guests).

- [ ] **Step 1: Failing test** — a valid WRT reaches the forward (no WAVE key)

```ts
// in test/realtime.spec.ts — using the worker's fetch harness
it("a valid WRT authorizes a room intent and stamps x-wave-org/x-wave-role", async () => {
  const tok = await mintTestWrt({ org: "org_alpha", room: "r1", pid: "p1", role: "speaker" }); // helper mirrors wrt.ts
  const res = await SELF.fetch("https://api.wave.online/v1/realtime/rooms/r1/join", {
    method: "POST", headers: { authorization: `Bearer ${tok}`, "content-type": "application/json" }, body: "{}",
  });
  expect(res.status).not.toBe(401);
  // the captured forward (mocked REALTIME_ORIGIN) saw x-wave-org=org_alpha + x-wave-role=speaker
});
it("a WRT for room r1 is rejected on room r2 (room binding)", async () => {
  const tok = await mintTestWrt({ org: "org_alpha", room: "r1", pid: "p1", role: "speaker" });
  const res = await SELF.fetch("https://api.wave.online/v1/realtime/rooms/r2/join", {
    method: "POST", headers: { authorization: `Bearer ${tok}` }, body: "{}",
  });
  expect(res.status).toBe(401);
});
```

- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement** — in `handleRequest`, inside the `else` after `if (auth.ok)`:

```ts
} else {
  // ── WRT (guest capability token) on an SFU room route ──────────────────────────────
  const roomEdge = sfuRoomEdgePath(req.method, path); // null unless a valid room route
  const bearer = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  if (roomEdge && bearer && env.WRT_MASTER) {
    const room = path.split("/")[4];
    const wrt = await verifyWrt(env.WRT_MASTER, bearer, { room, isRevoked: (jti) => isWrtRevoked(env, wrt0Org(bearer), room, jti) });
    if (wrt.ok) {
      who = {
        organizationId: wrt.org,
        scopes: ["realtime:write"],
        rateLimitTier: "guest",
        keyPrefix: "wrt",
      } as GatewayPrincipal;
      // carry role/grants for the realtime forward (stamped in realtime.ts via attribution below)
      (req as Request & { __wrtRole?: string }).__wrtRole = wrt.role;
    } else {
      return json({ error: { code: "AUTH_REQUIRED", message: "authentication required" } }, 401);
    }
  }
  if (!who) {
    // ... existing x402 / paymentChallenge / AUTH_REQUIRED block unchanged ...
  }
}
```

> Note for implementer: `isWrtRevoked` is the Phase-4 stub (returns false until Task 6 lands). `wrt0Org` decodes the org claim for the revocation key; reuse `decodeJwt`. Thread `wrt.role` into the `attribution` map as `x-wave-role` (Task 4). Add `WRT_MASTER?: string` to the `Env` interface.

- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit**

### Task 4: Stamp `x-wave-role` on the realtime forward

**Files:** Modify `gateway/src/worker.ts` (attribution map ~line 630), `gateway/src/realtime.ts`, `test/realtime.spec.ts`

- [ ] **Step 1: Failing test** — assert the forwarded headers include `x-wave-role` equal to the token role.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement** — when the principal is a WRT, add to `attribution`:

```ts
const wrtRole = (req as Request & { __wrtRole?: string }).__wrtRole;
if (wrtRole) attribution["x-wave-role"] = wrtRole;
```

Ensure `forward()` passes `attribution` through for realtime targets (it already does — the realtime target uses the same header path). `sealInternalHeader` is unchanged.

- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit**

---

## Phase 3 — Gateway: key-provisioning endpoint

### Task 5: `POST /v1/realtime/room-keys`

**Files:** Modify `gateway/src/worker.ts`, `gateway/src/scopes.ts`, `test/realtime.spec.ts`

Authed with a WAVE key (`realtime:write`). Returns the caller-org's current derived signing key (base64url) + `kid` so WSC can mint locally.

- [ ] **Step 1: Failing test** — authed WAVE key → 200 `{ kid, key, alg:"HS256" }`; no key → 401; wrong scope → 403.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement** — after the scope check passes, before forward, handle the native route:

```ts
if (req.method === "POST" && path === "/v1/realtime/room-keys") {
  if (!env.WRT_MASTER) return json({ error: { code: "REALTIME_NOT_CONFIGURED", message: "WRT not configured" } }, 503);
  const key = await deriveOrgKey(env.WRT_MASTER, who.organizationId);
  const b64 = btoa(String.fromCharCode(...key)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return json({ kid: "wrt-v1", alg: "HS256", key: b64 }); // org-scoped; only mints for who.organizationId
}
```

And in `scopes.ts` add the native group entry mapping `POST /v1/realtime/room-keys` → `realtime:write` (GATEWAY_NATIVE_GROUPS — served at the gateway, not forwarded).

- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit**

---

## Phase 4 — Gateway: revocation set

### Task 6: `isWrtRevoked` + eject/ban writes (KV-backed)

**Files:** Modify `gateway/src/wrt.ts` (or new `src/wrt-revocation.ts`), `test/wrt.spec.ts`, `wrangler` KV binding `WRT_REVOCATION`.

- [ ] **Step 1: Failing test** — a `jti` written to the revocation KV → `isWrtRevoked` true; an `org:room` "lock" marker → all jti for that room revoked.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement** `isWrtRevoked(env, org, room, jti)` reading `WRT_REVOCATION` KV keys `rev:jti:<jti>` and `rev:room:<org>:<room>` (room kill-switch). Add `revokeJti`/`lockRoom` writers (called by the edge eject/ban via an internal gateway hook — wire in the edge phase). Replace the Task-3 stub.
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit**

---

## Phase 5 — Edge: admission policy + waiting room + safety ops

### Task 7: `AdmissionPolicy` + room type + secure defaults

**Files:** Modify `wave-realtime-edge/src/room.ts`, `test/room.test.ts`

- [ ] **Step 1: Failing test** — `ensureRoom` with `type:"meeting"` defaults `mode:"knock"`; `webinar` → `auto` + `defaultRole:"viewer"`; a `knock` join lands in waiting (no participant yet), `admit` promotes it; `lock` blocks new joins; `capacity` enforced; `eject` removes + returns the session to close; `ban` persists a deny.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement** in `RoomCore`/`RoomState`:

```ts
export type RoomType = "meeting" | "webinar" | "event" | "breakout";
export interface AdmissionPolicy { mode: "knock" | "auto"; locked: boolean; capacity: number | null; defaultRole: Role; allowAnonymous: boolean; }
const POLICY_DEFAULTS: Record<RoomType, AdmissionPolicy> = {
  meeting:  { mode: "knock", locked: false, capacity: null, defaultRole: "speaker", allowAnonymous: false },
  webinar:  { mode: "auto",  locked: false, capacity: null, defaultRole: "viewer",  allowAnonymous: true  },
  event:    { mode: "auto",  locked: false, capacity: 10000, defaultRole: "viewer", allowAnonymous: true  },
  breakout: { mode: "auto",  locked: false, capacity: null, defaultRole: "viewer",  allowAnonymous: false },
};
// RoomState gains: policy: AdmissionPolicy | null; waiting: Record<string, {participantId; role; requestedAt}>; banned: string[].
// ensureRoom(config & {type}) sets policy = POLICY_DEFAULTS[type] (override-able). joinRoom checks: banned→403,
// locked→423 ROOM_LOCKED, capacity→429 ROOM_FULL, mode==="knock"→push to waiting + return {waiting:true} (NO sfu),
// mode==="auto"→join normally. admit(pid)/deny(pid)/lock()/setCapacity(n)/eject(pid)/ban(pid)/endRoom() added.
```

- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit**

### Task 8: Signaling honors admission + role from ctx

**Files:** Modify `wave-realtime-edge/src/signaling.ts`, `test/signaling.test.ts`

- [ ] **Step 1: Failing test** — `join` on a `knock` room returns `{ waiting: true }` and does NOT call `sfu.newSession`; on `auto` it mints the session as today; the participant `Role` comes from `ctx.role` (not the hardcoded default).
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement** — `SignalContext` gains optional `role?: Role` + `type?: RoomType`. `join` calls `ensureRoom({...,type})`, then a policy pre-check: if it returns waiting → return `{ waiting: true, participantId }` before `sfu.newSession`. Otherwise unchanged, passing `role: ctx.role`.
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit**

### Task 9: Worker reads `x-wave-role` + room type into ctx

**Files:** Modify `wave-realtime-edge/src/worker.ts`, `test/worker.sfu.test.ts`

- [ ] **Step 1: Failing test** — a request with `x-wave-role: viewer` results in a viewer participant; absent → policy default. Room `type` carried (from a `x-wave-room-type` header or the join body).
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement** — in the room-route block, read `const role = request.headers.get("x-wave-role")`; include `role` + `type` in the `ctx` forwarded to the DO (`{ ...payload, ctx: { org, room, participantId, role, type } }`).
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit**

---

## Phase 6 — WSC: mint + guest-token endpoint (server-side)

### Task 10: `WrtMintService`

**Files:** Create `connect/src/services/realtime/wrt/WrtMintService.ts` + test. Branch → `staging`, `git -c core.hooksPath=/dev/null`.

- [ ] **Step 1: Failing test** — mints a WRT that `verifyWrt` (same algorithm) accepts; role/grants/ttl honored; org from the caller's WSC org.
- [ ] **Step 2: Implement** — fetch the org key once from `${WAVE_GATEWAY_URL}/v1/realtime/room-keys` (Bearer `WAVE_GATEWAY_SECRET`), cache it; sign a `jose` HS256 JWT with the spec's claims. `ServiceResult<T>`, `traceExternalAPI('gateway','room-keys.fetch')`, circuit breaker. No mock data.
- [ ] **Step 3: Run** → PASS.
- [ ] **Step 4: Commit**

### Task 11: `POST /api/realtime/guest-token`

**Files:** Create `connect/app/api/realtime/guest-token/route.ts` + test.

- [ ] **Step 1: Failing test** — Supabase-authed host can mint a guest token for a room they own (org check via `organization_members`); unauth → 401; role capped by the host's grant.
- [ ] **Step 2: Implement** — mirror `app/api/livekit/token/route.ts` structure (auth, org-access check, `withRateLimit`, `traceExternalAPI`), call `WrtMintService`. Return `{ token, room, expiresAt, wsUrl: realtime gateway base }`.
- [ ] **Step 3: Run** → PASS.
- [ ] **Step 4: Commit + open PR → `staging`.**

> Guest room PAGE/UI (the link-landing experience, waiting-room UX, join button) = **design-agent lane**, out of this plan. This phase delivers the secure server-side token issuance the UI calls.

---

## Phase 7 — E2E proof (also #40's server-plane proof)

### Task 12: Live authenticated round-trip

- [ ] After Jake-named deploys (gateway + edge) and secret-writes (`WRT_MASTER`, edge `CF_CALLS_APP_ID/SECRET`): mint a WRT via WSC → `POST api.wave.online/v1/realtime/rooms/<room>/join` with the WRT → expect a `200` with a `sessionId` + SDP answer (or `{ waiting: true }` on a knock room, then host `admit` → join). Capture the receipt (`proven-live-or-not-done`).
- [ ] Negative receipts: no token → 401; wrong-room token → 401; expired → 401; ejected jti → 401.

---

## Self-review notes
- **Spec coverage:** WRT format/HKDF (T1-2), gateway verify+role+room-binding (T3-4), key endpoint (T5), revocation (T6), admission+safety ops (T7), signaling+role (T8-9), WSC mint+endpoint (T10-11), E2E (T12). All §3-§9 covered. Breakouts/capabilities correctly out of scope.
- **Type consistency:** `WrtRole`/`Role` are the same triple (host/speaker/viewer); `verifyWrt` returns `grants` narrowed to the role ceiling; `AdmissionPolicy.defaultRole` is a `Role`.
- **Crossings:** every deploy, the `WRT_MASTER` secret-write, the `WRT_REVOCATION` KV create, and the WSC→staging merge are **Jake-named**. Build/test/PR are Air-safe.
- **Security libs:** uses `jose` (battle-tested JWS) + WebCrypto HKDF — no hand-rolled crypto (honors secure-by-default guidance).
