# WAVE Rooms — Guest Access & Room Security (P5.2-auth) — Design Spec

**Date:** 2026-06-19
**Status:** DESIGN — awaiting Jake review before writing-plans
**Epic:** #30 LiveKit rip (better-not-1:1). Foundational sub-project of the WAVE-native room plane.
**Repos touched:** `wave-gateway` (token mint + verify), `wave-realtime-edge` (SignalContext + admission + safety ops in RoomDO), `wave-surfer-connect` (WSC mints, hosts the guest room page).

---

## 1. Context & goal

Slice-1 server plane is **already live**: the WAVE-native RoomDO SFU (`wave-realtime-edge`) and its gateway fronting (`api.wave.online/v1/realtime/rooms/:room/:intent`) are built, merged, deployed, and proven (401-gated). Today only an authenticated **WAVE-key holder** (a platform customer's server) can reach a room.

The product need: a customer's **end-users (guests/clients)** must be able to join a room **securely** via a link / room code — **without a WAVE key** — across meetings, webinars, and events. Security is paramount (the Zoom-bombing threat). This spec defines the guest authentication, admission, and in-room safety model that everything else (breakouts, capabilities) builds on.

The substrate is already shaped for this. `signaling.ts` states: *"AUTH IS DELIBERATELY OUT (P5.2-auth) — every method receives an already-validated `{org, room, participantId}` (SignalContext)."* `RoomDO` already enforces `Role` (host/speaker/viewer) + `Permissions` (canPublish/canSubscribe) per participant and per-org isolation (`${org}:${room}`). This spec fills the deliberately-empty auth seam.

## 2. Decisions (locked this session)

1. **Who mints — WSC/customer.** The customer's authenticated WSC backend decides who may join and with what role; WAVE keys never reach a guest.
2. **Token issuance & verification — gateway-issued, gateway-verified, HKDF per-org signing.** One WAVE trust root, O(1) verification, zero per-tenant key management, central revocation. (Rationale in §6.) A future enterprise BYO-JWKS path is an opt-in add-on, **not built now** (YAGNI).
3. **Admission — per-room-type policy with secure defaults.** Admission is a small policy object on the room; defaults are locked-down per type; a universal set of safety ops exists for every type.

## 3. Token model — the WAVE Room Token (WRT)

A WRT is a compact, signed, short-lived **capability** asserting exactly what a participant may do in exactly one room.

### Claims
```
{
  "v":   1,                       // version
  "org": "<orgId>",              // tenant — MUST match the room's bound org
  "room":"<roomId>",            // single room only
  "pid": "<participantId>",     // stable per-guest id (customer-assigned)
  "role":"host"|"speaker"|"viewer",
  "grants": { "canPublish": bool, "canSubscribe": bool },  // defaults derived from role; token may NARROW, never widen beyond role ceiling
  "name":"<display>",           // optional, for the roster
  "adm": "admit"|"knock",       // admission hint (room policy is authoritative; see §5)
  "iat": <unix>,
  "exp": <unix>,                 // SHORT — default 1h, max 12h
  "jti": "<uuid>"               // for revocation
}
```

### Signing — HKDF-derived per-org key (the scale path)
- WAVE holds **one master secret** `WRT_MASTER` (gateway secret, Doppler `wave/prd`).
- Per-org signing key = `HKDF-SHA256(WRT_MASTER, salt="wrt-v1", info=orgId)` → 32 bytes → HMAC-SHA256 key (JWS `HS256`).
- WSC mints **locally** (no per-guest network hop): it is provisioned its own org's derived key once (delivered via an authenticated gateway endpoint — see §3.1), then signs WRTs itself.
- The gateway verifies by **re-deriving** the same key from the `x-wave-org` it already stamps from the authenticated principal — so verification needs no key store, just `WRT_MASTER` + orgId. **One secret to protect, not N.**

> Why HKDF over "gateway signs each token on request": it removes a network round-trip per guest-join while keeping a single WAVE-owned trust root. The customer still cannot mint for *another* org (their derived key only validates under their own `x-wave-org`, which the gateway stamps from *their* authenticated identity — a cross-org token fails signature verification).

### 3.1 Key provisioning endpoint (gateway)
`POST /v1/realtime/room-keys` — authed with the customer's WAVE key (`realtime:write`). Returns the org's current derived WRT signing key + `kid` + rotation metadata. WSC caches it (rotated on a schedule; `kid` in the JWS header selects the active key, enabling overlap during rotation).

### Verification (gateway, on every guest call)
On `POST /v1/realtime/rooms/:room/:intent` when the caller presents a **WRT** (vs a WAVE key):
1. Parse JWS; read `kid` → select the derivation epoch.
2. Re-derive org key from `WRT_MASTER` + the token's `org`; verify `HS256` signature. **Fail-closed.**
3. Assert `exp`/`iat` valid, `org` == token org, `room` == path room, `jti` not in revocation set.
4. Map to **SignalContext** `{ org, room, participantId: pid }` + carry `role`/`grants` to the edge as stamped headers (`x-wave-role`, plus the existing `x-wave-org`). The edge's existing `gatewayGate` + `x-wave-internal` seal are unchanged.
5. Meter as today (the leave-time tap already emits participant-minutes).

### Revocation
- Short TTLs are the primary control. For immediate kill (eject/ban), the gateway keeps a small **revocation set** (KV/DO) of `jti` (and an `org:room` "lock" / "kill-all" marker). Checked in verification step 3. Eject writes the `jti`; ban writes a `pid` deny entry.

## 4. SignalContext mapping (edge — minimal change)

`SignalContext` stays `{ org, room, participantId }` (no edge change to the type). The edge additionally reads `x-wave-role` (gateway-stamped, trusted) to set the participant's `Role` on `join` instead of defaulting to `speaker`. `grants` narrow the role's default permissions. Everything downstream (publish grant enforcement, per-org isolation) already exists.

## 5. Admission — policy object + per-room-type defaults

A room carries an `AdmissionPolicy` in RoomDO state (set at room creation by the customer, defaulted by room type):
```
type RoomType = "meeting" | "webinar" | "event" | "breakout";
interface AdmissionPolicy {
  mode: "knock" | "auto";        // knock → waiting room + host admit; auto → join on valid token
  locked: boolean;               // hard stop: no new joins regardless of token
  capacity: number | null;       // max concurrent participants
  defaultRole: Role;             // role assigned when token omits/!host
  allowAnonymous: boolean;       // false → require a customer-verified pid
}
```
**Secure defaults by type:**
| Type | mode | defaultRole | notes |
|------|------|-------------|-------|
| meeting | knock | speaker | host admits from waiting room; lockable mid-call |
| webinar | auto | viewer | view-only; presenters explicitly granted; raise-hand → promote |
| event | auto | viewer | + capacity cap; optional registration gate (customer) |
| breakout | auto (inherit) | inherit | no separate door; host-assigned from parent (deferred sub-project) |

Customer may relax/override per room. `knock` participants land in a **waiting-room** state in the RoomDO (recorded, not yet given an SFU session) until a host `admit`s them.

## 6. Why this trust model at scale (the reasoning Jake asked for)

| | Gateway-issued + HKDF (CHOSEN) | Per-org BYO-JWKS (deferred) |
|---|---|---|
| Trust roots WAVE holds | **1** (`WRT_MASTER`) | **N** customer keys |
| Verify cost / join | O(1), in-memory re-derive | O(N) key resolution + JWKS fetch/cache |
| Customer onboarding | uses existing WAVE key | generate keypair + JWKS endpoint |
| Revocation | central (`jti` set) | per-org, decentralized |
| Blast radius of a leak | 1 high-value WAVE secret (WAVE-controlled) | N tenant keys, each a tenant compromise |

The customer's signing authority is **reused from the WAVE-key auth** on the key-provisioning call — no *new* trust root. BYO-JWKS becomes a paid enterprise opt-in only when someone needs it.

## 7. Guest join flow (end to end)

```
guest clicks link  →  WSC room page (customer authenticates/gates the guest as it sees fit)
   →  WSC mints a WRT locally (org-derived key, role/grants/ttl per its policy)
   →  guest's browser calls api.wave.online/v1/realtime/rooms/:room/join  (Authorization: Bearer <WRT>)
   →  gateway verifies WRT (re-derive org key), checks revocation/lock, stamps x-wave-org + x-wave-role,
      seals x-wave-internal, forwards to edge
   →  edge RoomDO: if policy.mode=knock → waiting room (await host admit); else → mint SFU session, join,
      return SDP answer
   →  guest publishes/subscribes per grants; SFU media flows; leave meters participant-minutes
```

## 8. Threat model → defense mapping (anti-Zoom-bombing)

| Threat | Defense |
|--------|---------|
| Uninvited join | WRT required; no token = no join (edge already 401s) |
| Leaked/shared link | short `exp`; `viewer` grant can't disrupt; revoke `jti`; lock room |
| Cross-tenant access | org-bound token + per-org HKDF key + DO `${org}:${room}` isolation (already enforced) |
| Privilege escalation | role ceiling; token may only narrow grants; edge enforces publish grant |
| Disruptive participant | host eject + **ban** (`pid` deny), mute-others, lock |
| Flood / capacity abuse | `capacity` cap; gateway rate-limit (existing) |
| Replay after removal | `jti` revocation set; SFU session closed on eject |

## 9. Universal safety ops (RoomDO, every room type)
`lock(room)`, `setCapacity(n)`, `admit(pid)` / `deny(pid)` (knock), `eject(pid)` (remove + close session + revoke jti), `ban(pid)` (eject + persistent deny), `muteOthers` (host), `endRoom` (evict all). All are RoomDO state transitions → the DO is the single authority; no race.

## 10. Scope — what this spec includes vs defers

**In scope (this sub-project):** WRT format + HKDF signing/verify, key-provisioning endpoint, gateway verification path for guest tokens, `x-wave-role` stamping, RoomDO `AdmissionPolicy` + waiting-room + universal safety ops, revocation set.

**Deferred to follow-on specs (named so they're captured):**
- **Breakouts / rooms-in-rooms** — child RoomDO `${org}:${room}:${breakout}`, parent pointer, move-participant op, broadcast-to-all, pull-back. (Builds directly on this.)
- **Room capabilities** — recording-tap→R2 (slice 2), captions/transcription (slice 4), translation, AI co-host, data-channel polls/reactions/raise-hand, composited layouts, persistent "spaces". (Each its own spec.)
- **BYO-JWKS enterprise minting** — per-tenant self-signing opt-in.
- **WSC client SDK swap** (livekit-client → WAVE SDP client) — design-agent lane, tracked under #40.

## 11. Testing posture
- Gateway: WRT verify unit tests (valid / expired / wrong-org / tampered / revoked / role-escalation-attempt) — fail-closed each. HKDF re-derivation determinism. Key-provisioning auth (no WAVE key → 401).
- Edge: RoomDO admission state machine (knock→waiting→admit, lock, capacity, eject closes session, ban persists) over injected storage; `x-wave-role` → Role mapping; per-org isolation preserved.
- E2E (proves the whole server plane): WSC mints WRT → authed join → CF Realtime `newSession` → SDP answer round-trip. This is also #40's proof.
- No live network in unit tests (existing injected-fetch + injected-storage harness).

## 12. Honored laws
`correctness-by-design` (one trust root, fail-closed, secure defaults — the right design, not the easy one), `proven-live-or-not-done` (E2E round-trip receipt required), `metering-governed` (reuses the live leave-time meter tap; no new money path), `secrets-from-doppler` (`WRT_MASTER` in Doppler, never in git). Deploy + secret-write = Jake-named crossings.
