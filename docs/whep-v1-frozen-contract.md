# WHEP v1 — Frozen Wire Contract (#53)  — v1.0

The **egress** sibling of `whip-v1-frozen-contract.md` (the WHIP ingest surface). WHEP =
**WebRTC-HTTP Egress Protocol** (`draft-murillo-whep-03`): a subscriber receives a published WebRTC
stream over plain HTTP signaling. This freezes the wire BEFORE implementation so the builder conforms.
Method: persist the wire → builder conforms → zero drift. Mirrors the WHIP contract section-for-section.

## 0. v1 scope (locked)
- **SFU-only egress.** Control through the gateway (forwarded request, `x-wave-internal` seal); **media
  off the Worker** — ICE/DTLS/SRTP terminate at **CF Realtime SFU** (`rtc.live.cloudflare.com`), never on
  a Worker. The rt-edge `/v1/whep/*` handler is signaling-only glue: it relays SDP to/from the SFU verbatim.
- **Pairs with WHIP.** A WHEP subscribe pulls a track that a WHIP publish (or any SFU session in the same
  org) put on the SFU. The publisher's SFU session is resolved from the WHIP resource record
  (`whip:{resourceId}` in `RT_MEETING_ORG`) the WHIP publish persisted — this is the WHIP→WHEP join point.
- **Per-product metering standard:** dedicated scope `whep:read` + dedicated SKU `wave_whep_egress_minutes`
  + own `STRIPE_PRICE_WHEP_EGRESS_MIN`.
- **NOT in v1:** track-discovery registry (the subscriber NAMES the track — see §10 gap 2), multi-track
  bundles, SVC layer selection, server-driven renegotiation completion (see §10 gap 1).

## 1. Lockstep enums — BYTE-IDENTICAL to `c1g1-frozen-contract.md` §4 / WHIP §1
- **CODECS** = `[h264, hevc, av1, vp8, vp9, aac, opus, pcm, flac]`
- **TRANSPORTS** = `[moq, srt, rist, whip, whep, ll-hls, ws-adapter]` (`whep` present)
- **REGIONS** = `[us-east, us-west, eu-west, eu-central, ap-south, ap-northeast, sa-east, unknown]`

## 2. Gateway = PROXY for `/v1/whep/*` (NOT a minter) — mirror WHIP §2
- **Scope:** `whep` in the gateway scope group; `rw()` derives `whep:read` + `whep:write`. The subscriber
  key needs `whep:read`. **Org/keyId server-side from the key — NEVER body/header.**
- **Routing:** `/v1/whep/*` flows through the generic **auth → scope(`whep:read`) → meter → forward** chain.
  The forward maps `/v1/whep/*` to the rt-edge origin (the same `WHIP_EDGE`/realtime-edge spoke origin) and
  **injects `x-wave-internal`** — the edge trusts ONLY gateway-forwarded requests. Fail-closed 402 (no
  entitlement) / 403 (scope) / 503 (edge origin unset).
- **No client-side JWT.** Client talks ONLY to `https://gateway.wave.online/v1/whep/subscribe` with its
  `wk_…` key. The gateway **REWRITES the edge's `Location` header** to a gateway-absolute path so the
  WHEP-resource `PATCH`(trickle)/`DELETE`(teardown) stay on the control plane (auth + meter).

## 3. WHEP handshake at the edge — behind `WHEP_EGRESS_ENABLED`
- `POST {gateway}/v1/whep/subscribe?resource={whipResourceId}&track={trackName}` → (forwarded,
  `x-wave-internal`) → edge:
  validate `x-wave-internal` (the edge's EXISTING `timingSafeEqual` gateway-trust check — NOT a JWT) →
  resolve the publisher SFU session from `whip:{resourceId}` in `RT_MEETING_ORG` (must be the SAME org —
  tenant isolation, §9.6) → `SfuClient.newSession(clientOffer)` (transport + answer) +
  `SfuClient.pullTracks(subscriberSession, [{remote, sessionId, trackName}])` (attach the published track) →
  **201 Created**, `Location: /v1/whep/resource/{resourceId}`, `Content-Type: application/sdp`, body = SDP
  **ANSWER**. Response header `x-wave-whep-renegotiation: 0|1` signals whether the SFU requires a follow-up
  renegotiation (§10 gap 1). (The gateway rewrites Location on the way back.)
- `PATCH {gateway}/v1/whep/resource/{id}` — `application/trickle-ice-sdpfrag` → **204** (trickle ACK).
- `DELETE {gateway}/v1/whep/resource/{id}` → **204** (teardown → stop meter; SFU session GCs on idle).
- Errors (typed JSON; 201 body is SDP): **401** missing/invalid `x-wave-internal` · **400** missing/malformed
  org OR missing `track` · **404** unknown/cross-org source resource OR bad/gone WHEP resource · **415** wrong
  content-type · **422** unparseable SDP offer · **503** SFU unavailable.
- **INERT:** behind `WHEP_EGRESS_ENABLED` (`[vars]`). Off/absent → a `/v1/whep/*` request falls through to the
  honest 501 catch-all (`worker.ts`), UNCHANGED. This module is never entered.

## 4. Metering — `wave_whep_egress_minutes`
- Duration metering of the subscribe session: edge emits on teardown
  `{ meter:"wave_whep_egress_minutes", meter_value:<ceil minutes>, event_id:<resourceId> }` to the gateway
  `/v1/internal/usage` (same ingest the WHIP teardown + realtime tap use). **Fail-open** on the post;
  idempotent on resourceId. SKU → `STRIPE_PRICE_WHEP_EGRESS_MIN` (◆ binding; orphan meter blocks GA).

## 5. Builders
- **rt-edge** (#53, wave-realtime-edge, branch `feat/53-whep-v1`): `src/whep.ts` `/v1/whep/*` handler; trust
  `x-wave-internal` via the existing chokepoint; `newSession`/`pullTracks` → answer+Location; PATCH/DELETE;
  meter on teardown; contract tests. **INERT** behind `WHEP_EGRESS_ENABLED` until the deploy ◆.
- **gateway** (follow-up): add `whep` to the scope group + the `/v1/whep/*` forward mapping + Location rewrite
  + `usage.ts` `wave_whep_egress_minutes`/`STRIPE_PRICE_WHEP_EGRESS_MIN`.

## 6. Deploy ordering (◆ GO-LIVE — orchestrator's crossing, NOT this builder)
1. merge this PR (rt-edge WHEP handler, inert until flag flips on a deployed env).
2. `npx wrangler deploy` rt-edge with `WHEP_EGRESS_ENABLED` armed → prove a `/v1/whep/subscribe` probe is
   **401** (gateway-trust), NOT 501 (surface live + sealed).
3. ◆ gateway forward mapping + `whep:read` scope + `STRIPE_PRICE_WHEP_EGRESS_MIN`.
4. ◆ prove a real WHIP-publish → WHEP-subscribe → **first frame** lands (receipt = 201 + SFU answer SDP with
   the pulled m-line + decoded first frame at the subscriber + usage row).

## 7. ◆ crossings needing Jake (NAME, don't auto-fire)
- `WHEP_EGRESS_ENABLED=1` on a live env (NEW LIVE EGRESS path activation) — named-floor.
- gateway `whep:read` scope grant on a customer key.
- `STRIPE_PRICE_WHEP_EGRESS_MIN` binding (orphan meter blocks GA).

## 8. Frozen invariants (DO NOT DRIFT)
1. Org/keyId ALWAYS server-side from the key; NEVER body/header.
2. Media NEVER terminates on a Worker; CF Realtime SFU terminates ICE/DTLS/SRTP. The edge relays SDP verbatim.
3. Client talks ONLY to `gateway.wave.online`; gateway↔edge trust is the server-side `x-wave-internal` secret;
   PATCH/DELETE stay on the control plane via the rewritten Location.
4. Enums byte-identical to `c1g1-frozen-contract.md` §4.
5. A WHEP subscriber may ONLY pull from a source SFU session owned by the SAME org (tenant isolation,
   fail-closed: a cross-org or unknown source resource is an indistinguishable 404).

## 9. Auth & isolation
- `x-wave-internal` gateway-trust (existing `timingSafeEqual`); `x-wave-org` is the server-stamped org.
- §9.6 tenant isolation: the source `whip:{resourceId}` record's org MUST equal the request org, else 404
  (no existence leak across tenants).

## 10. Known SFU-API gaps (HONEST — first-frame is NOT proven by this PR)
1. **Negotiation direction.** CF Realtime SFU pull is **SFU-offer / client-answer** (`pullTracks` returns
   `requiresImmediateRenegotiation` + an SFU offer the client answers via `renegotiate`; see
   `signaling.ts:199-222`). This is the INVERSE of single-shot WHEP (client-offer → server-answer). So
   `newSession(clientOffer)` returns the transport answer, but the PULLED track's media is attached by a
   SECOND negotiation the single WHEP answer cannot carry. v1 surfaces this with the
   `x-wave-whep-renegotiation: 1` response header; completing media flow (server-offer renegotiation over
   the WHEP resource) is a deferred follow-up. **Until then, single-shot first-frame is BLOCKED by the CF
   pull model — the surface is wired, sealed, metered, and inert-correct, but first-frame must be proven
   after the renegotiation seam lands (or a CF one-shot-pull primitive ships).**
2. **Track discovery.** The WHIP v1 resource record persists only `{sessionId, org, startedAt, meter}` —
   NOT the published trackNames. CF pull needs an explicit `(sessionId, trackName)`. So in v1 the WHEP
   subscriber MUST name the track (`?track=`); there is no track-discovery registry on the SFU-only WHIP
   path. A follow-up can persist published trackNames at WHIP publish to enable discovery.
