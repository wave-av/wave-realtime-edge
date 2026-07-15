# WHEP Live Egress Go-Live (CF-Stream-WHEP un-park) — Design

**Date:** 2026-07-15
**Status:** Approved (design) — pending spec review → north-star-epic plan
**Primary repo:** `wave-realtime-edge` (edge worker). Spans `wave-desktop` (client) and `wave-gateway` (auth/reverse-proxy).
**North star:** A WHEP subscribe against a live source yields `inbound-rtp.bytesReceived > 0` **and** a `wave_whep_egress_min` meter tick — the RIGHT way: real ingest registration, real source-discovery, real client threading, proven live.

---

## 1. Problem & grounded state

WHEP egress (`/v1/whep/subscribe?resource=<liveInputUid>`) is the **Cloudflare Stream Live** playback plane — a *different media plane* from WHIP→SFU. It relays a viewer's `recvonly` WebRTC offer to CF Stream Live's WebRTC playback for a named live input, after a server-side tenant-isolation check.

**Already true on prod (receipts):**
- Egress armed: `WHEP_EGRESS_ENABLED="1"`, `USE_CLOUDFLARE_STREAM="1"` (`wrangler.toml:81,88`). `useCloudflareStream(env)` → `true`.
- `handleSubscribe` (`src/whep.ts:223`) validation order: `?resource=` uid regex `^[0-9a-fA-F]{32}$` (→400) → `application/sdp` (→415) → body `v=0` (→422) → **KV org-match** `resolveInputOrgMatch(RT_MEETING_ORG, uid, org)` reading `stream-input-org:<uid>` (→404 cross-org/unknown) → `useCloudflareStream` (→503) → `resolveStreamPlaybackUrl` substitutes `{uid}` into `WHEP_SRC_URL_TEMPLATE` (fallback: `CF_STREAM_CUSTOMER_CODE`).
- KV: `RT_MEETING_ORG` = namespace `4acd6ec7b04546ba8767f2353d5394e8` on fleet account `d674452f`.
- CF Stream Live plane is REAL + LIVE: `CLOUDFLARE_STREAM_API_TOKEN` (Doppler `wave/prd`) lists `stream/live_inputs` on account `…c23f0a` → 200, **1281 inputs** (WSC broadcast uses this path).
- Credential banked: `WHEP_SELF_SUBSCRIBE_KEY` (Doppler `wave/prd`) clears auth+scope (subscribe → 400 for missing resource, not 403). Supabase `api_keys` row `e548a6c3-…`, scopes `[whep:read, whep:write]`, principal `9bb295f6-…`.
- Ingest ARM PR #52 (client ICE hardening) prerequisite — merged/queued separately.

**The gaps (what this epic closes):**
1. **Ingest registration ARM slice (keystone):** `CfStreamLiveIngestBackend` (`src/ingress-cf-stream-live.ts`) is built + unit-tested behind an *injected* `CfStreamLiveClient` seam, but the **concrete adapter (real CF create-input + KV write) does not exist**, and nothing instantiates the backend. `INGRESS_ROUTER_ENABLED` default OFF.
2. **Empty secret:** Doppler `CF_STREAM_API_TOKEN` is len 0 (the adapter's env field); the working value is `CLOUDFLARE_STREAM_API_TOKEN`.
3. **No source feed** into any CF Stream Live input registered to the WAVE org.
4. **Client can't name a source:** `WhepSubscribeTarget = {endpoint, key}` (`whep-client.ts:24`); `mintSubscribeToken` returns a bare `/v1/whep/subscribe` (`ipc.ts:419`) with no `?resource=`. Always 400.
5. **No source-discovery**: viewers have no way to learn which uid is live for their org.

**Account topology (deliberate):** the edge worker runs on fleet account `d674452f` (KV + secrets bound there); CF Stream Live inputs live on `…c23f0a`. The adapter runs *in the worker* and calls the CF API for `c23f0a` with the bound token secret, and writes KV via its own `RT_MEETING_ORG` binding — a cross-account API call with an account-scoped token (normal), no external KV token needed.

---

## 2. Architecture

```
PUBLISHER                         EDGE WORKER (d674452f)                 CF STREAM LIVE (c23f0a)
  │  POST /v1/whep/sources ─────▶ provision route (authed, org-resolved)
  │                                 └─ CfStreamLiveClientImpl.createLiveInput()
  │                                      ├─ POST accounts/c23f0a/stream/live_inputs ──▶ {uid, RTMPS/SRT push URLs}
  │                                      └─ RT_MEETING_ORG.put("stream-input-org:"+uid, org)   (atomic w/ create)
  │  ◀── {uid, push: {rtmps, srt}} ─────┘
  │
  ├─(A) ffmpeg RTMPS loop ───────────────────────────────────────────────▶ input goes "live"
  ├─(B) desktop capture → RTMPS ─────────────────────────────────────────▶ input goes "live"
  └─(C) browser WHIP-to-Stream ──────────────────────────────────────────▶ input goes "live"

VIEWER
  │  GET  /v1/whep/sources           (org-scoped) ─▶ [{uid, name, live}]        (Receivers.tsx picker)
  │  POST /v1/whep/subscribe?resource=<uid>  (Bearer whep:write) ─▶ handleSubscribe
  │        └─ KV org-match ✓ → relay recvonly offer ──▶ CF Stream Live WebRTC playback ──▶ media
  │  getStats → inbound-rtp.bytesReceived > 0
  │  DELETE <resource> → egress session end → wave_whep_egress_min meter tick
```

**Units & interfaces (isolation):**
- `CfStreamLiveClientImpl implements CfStreamLiveClient` — the ONLY new I/O. One method `createLiveInput(req) → CfStreamLiveResult`. Owns: CF API create-input, endpoint parsing, `stream-input-org:<uid>` KV write. Depends on: `{ apiToken, accountId, customerCode, kv: RT_MEETING_ORG }`. Testable against a fake CF `fetch` + fake KV; live-verified on c23f0a. Also add a companion **`listLiveInputsForOrg`** (reverse index) — see §4.
- **Provision route** `POST /v1/whep/sources` — authed (gateway-trust header **or** minted `whep:write` key), resolves caller org, instantiates the backend + client, returns `{uid, push endpoints}`. Gated `INGRESS_ROUTER_ENABLED`.
- **Sources route** `GET /v1/whep/sources` — org-scoped list of that org's live inputs `[{uid, name, live}]`. Backed by a reverse KV index (`org-stream-inputs:<org>` set) written alongside the forward `stream-input-org:<uid>` mapping.
- **Client threading** — `WhepSubscribeTarget` gains `resource: string`; `mintSubscribeToken(uid)` builds `endpoint = base + /v1/whep/subscribe?resource=<uid>`; `startWhep` posts to `target.endpoint` unchanged (uid already in the query). Receivers.tsx: fetch `/v1/whep/sources` → picker → mint(uid) → startWhep.

---

## 3. Phases (→ north-star-epic)

- **P1 — Ingest ARM slice (keystone).** `CfStreamLiveClientImpl` (create-input + endpoint parse + forward & reverse KV writes). Provision route `POST /v1/whep/sources` (authed, org-resolved). Bind the worker secret `CF_STREAM_API_TOKEN` (the adapter's declared env field) from the Doppler `CLOUDFLARE_STREAM_API_TOKEN` value via `gh workflow run` deploy (never raw wrangler; token never printed) — this keeps the adapter reading its own declared field and leaves Doppler as SoR. Unit tests (fake client + fake KV). **Inert** until `INGRESS_ROUTER_ENABLED` armed (◆ Jake-named).
- **P2 — Feed the source (all three, each proven).**
  - **P2a — ffmpeg RTMPS loop** (self-drivable now): `testsrc`+tone → provisioned input → poll `live_inputs/<uid>` state = "connected"/"live". First live receipt.
  - **P2b — Real desktop capture → RTMPS**: wave-desktop screen/cam → RTMPS push to the provisioned input.
  - **P2c — Browser WHIP-to-Stream**: publish via CF Stream Live's native WHIP ingest (reuses #77 browser capture).
- **P3 — Client source-selection + discovery.** `GET /v1/whep/sources` (org-scoped, reverse index). Thread `resource` through `WhepSubscribeTarget` + `mintSubscribeToken` + Receivers.tsx picker. Tests.
- **P4 — LIVE PROOF.** werift `recvonly` subscribe (harness) w/ `WHEP_SELF_SUBSCRIBE_KEY` + `?resource=<uid>` → 201 + answer → `getStats` **inbound-rtp bytesReceived>0** → DELETE teardown. Repeat via the desktop client (P2b) for the product-real receipt.
- **P5 — Meter/billing receipt.** Confirm `wave_whep_egress_min` (`STRIPE_PRICE_WHEP_EGRESS_MIN`) fires on egress-session end and is correctly dogfood-excluded (mirrors #109/#142 — prove the event fires AND is excluded).

**Arm crossings (◆ Jake-named):** (1) `INGRESS_ROUTER_ENABLED` on prod edge; (2) any prod deploy via `gh workflow run` dispatch (no raw wrangler). All code ships INERT / prod byte-identical until the flip.

---

## 4. Data model — KV keys (reuse RT_MEETING_ORG ns)

| Key | Value | Written by | Read by |
|---|---|---|---|
| `stream-input-org:<uid>` | `<org>` (string) | adapter create-input (forward) | `handleSubscribe` org-match; `stream-bridge` receiver |
| `org-stream-inputs:<org>` | JSON `[{uid, name, createdAt}]` (reverse index) | adapter create-input | `GET /v1/whep/sources` |

Both written in the same `createLiveInput` call. TTL matches CF input lifecycle (or long TTL + reconcile against live CF list; a source deleted on CF must be pruned from the reverse index — a reconcile sweep, mirroring `reconcilePending`).

---

## 5. Error handling & tenant isolation

- Create-input non-2xx / KV failure → `CfStreamLiveResult {ok:false, status, reason}` (never a silent orphan; existing discriminated type).
- Org resolved SERVER-SIDE only — never from the webhook wire or client body (existing invariant in whep.ts §3/§9.6). `GET /v1/whep/sources` returns ONLY the caller's org inputs.
- Subscribe cross-org uid → 404 (existing). Missing/invalid uid → 400. Unconfigured → 503.
- Provision refuses empty org (existing `unroutable` path) — no orphan CF input.
- Client: `resolveResourceUrl` same-origin constraint unchanged (never leak Bearer cross-origin).

## 6. Testing

- **Unit:** adapter against fake CF `fetch` (2xx create, 4xx/5xx error, malformed body) + fake KV (assert forward + reverse writes); provision route authz (gateway-trust, minted key, missing org); `GET /v1/whep/sources` org-scoping; client `mintSubscribeToken(uid)` query construction; whep-client `resource` threading (existing 136 tests stay green).
- **Live:** P4 werift proof (bytesReceived>0); P5 meter tick + dogfood-exclusion; each P2 feed reaches "live" state.

## 7. Out of scope / follow-ups

- Recording of the WHEP-egress source (separate from realtime recorder #91).
- TURN for symmetric-NAT viewers (whep-client already injectable; public STUN default).
- Multi-region CF Stream Live input placement (region registry #114 exists; egress placement is a later optimization).

## 8. Success criteria (DONE = proven live)

1. `POST /v1/whep/sources` (authed) creates a CF Stream Live input on c23f0a + writes both KV keys — verified by API read + KV read.
2. Each of the 3 feeds drives the input to "live".
3. `GET /v1/whep/sources` returns the org's live uids; Receivers.tsx renders the picker.
4. WHEP subscribe with `?resource=<uid>` → 201 + answer → **inbound-rtp bytesReceived>0** (harness AND desktop client).
5. `wave_whep_egress_min` meter event fires and is dogfood-excluded — receipt captured.
