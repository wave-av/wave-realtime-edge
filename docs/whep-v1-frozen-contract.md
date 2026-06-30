# WHEP v1 — Frozen Wire Contract (#53)  — v1.1

The **egress** sibling of `whip-v1-frozen-contract.md` (the WHIP ingest surface). WHEP =
**WebRTC-HTTP Egress Protocol** (`draft-murillo-whep-03`): a subscriber receives a published WebRTC
stream over plain HTTP signaling. This freezes the wire BEFORE implementation so the builder conforms.
Method: persist the wire → builder conforms → zero drift. Mirrors the WHIP contract section-for-section.

## 0. v1 scope (locked) — RESOLVED via Cloudflare Stream webRTCPlayback (one-shot)
- **Source = Cloudflare Stream WebRTC playback.** The CF Realtime SFU does NOT expose a one-shot WHEP pull
  (its `pullTracks` is SFU-offer/client-answer, the INVERSE of single-shot WHEP). The correct one-shot WHEP
  path is **Cloudflare Stream's WebRTC playback endpoint** (`.webRTCPlayback.url` on a Stream live input),
  which IS a standard WHEP server. Control through the gateway (forwarded request, `x-wave-internal` seal);
  **media off the Worker** — ICE/DTLS/SRTP terminate at Cloudflare Stream's WebRTC edge, never on a Worker.
  The rt-edge `/v1/whep/*` handler is signaling-only glue: it RELAYS the subscriber's SDP offer to the Stream
  playback URL verbatim and returns Stream's answer verbatim.
- **Playback URL is deterministic + secret-free:** `https://customer-{CODE}.cloudflarestream.com/{uid}/webRTC/play`
  (confirmed live via the Stream `live_inputs` API field `.result.webRTCPlayback.url`). The edge substitutes
  the live-input uid into `WHEP_SRC_URL_TEMPLATE` (a `wrangler` SECRET with a `{uid}` placeholder; customer
  code baked in), or builds it from `CF_STREAM_CUSTOMER_CODE`. No token is in the playback URL.
- **`?resource=` is the CF Stream live-input uid** (32-hex). Org is resolved SERVER-SIDE from the
  `stream-input-org:{uid}` KV record (the SAME uid→org map `src/stream-bridge.ts` uses) and MUST equal the
  request org — the tenant-isolation join point. The uid is a lookup key, never an org claim (§9.6).
- **Per-product metering standard:** dedicated scope `whep:read` + dedicated SKU `wave_whep_egress_minutes`
  + own `STRIPE_PRICE_WHEP_EGRESS_MIN`.
- **NOT in v1:** track/quality selection (Stream plays the live program), multi-bundle. **Backend gate:**
  `USE_CLOUDFLARE_STREAM` (off → subscribe fails closed 503).

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
- `POST {gateway}/v1/whep/subscribe?resource={liveInputUid}` → (forwarded, `x-wave-internal`) → edge:
  validate `x-wave-internal` (the edge's EXISTING `timingSafeEqual` gateway-trust check — NOT a JWT) →
  resolve the live-input's org from `stream-input-org:{uid}` in `RT_MEETING_ORG` (must equal the request org —
  tenant isolation, §9.6) → resolve the Stream WHEP playback URL (`WHEP_SRC_URL_TEMPLATE` `{uid}` substitution,
  or built from `CF_STREAM_CUSTOMER_CODE`) → **RELAY** the client's `application/sdp` offer to the Stream
  playback URL verbatim (one-shot) → return Stream's **201 Created** body (SDP **ANSWER**) verbatim,
  `Location: /v1/whep/resource/{resourceId}`, `Content-Type: application/sdp`. **One-shot — NO
  `x-wave-whep-renegotiation` header** (Stream's WHEP playback returns the final answer). (The gateway rewrites
  Location on the way back.)
- `PATCH {gateway}/v1/whep/resource/{id}` — `application/trickle-ice-sdpfrag` → proxy the frag to the upstream
  Stream WHEP resource (best-effort) → **204** (trickle ACK).
- `DELETE {gateway}/v1/whep/resource/{id}` → proxy DELETE to the Stream WHEP resource (best-effort) → **204**
  (teardown → stop meter).
- Errors (typed JSON; 201 body is SDP): **401** missing/invalid `x-wave-internal` · **400** missing/malformed
  org OR missing/invalid `resource` · **404** unknown/cross-org source live-input OR bad/gone WHEP resource ·
  **415** wrong content-type · **422** unparseable SDP offer · **503** Stream disabled/unavailable.
- **INERT:** behind `WHEP_EGRESS_ENABLED` (`[vars]`). Off/absent → a `/v1/whep/*` request falls through to the
  honest 501 catch-all (`worker.ts`), UNCHANGED. This module is never entered.

## 4. Metering — `wave_whep_egress_minutes`
- Duration metering of the subscribe session: edge emits on teardown
  `{ meter:"wave_whep_egress_minutes", meter_value:<ceil minutes>, event_id:<resourceId> }` to the gateway
  `/v1/internal/usage` (same ingest the WHIP teardown + realtime tap use). **Fail-open** on the post;
  idempotent on resourceId. SKU → `STRIPE_PRICE_WHEP_EGRESS_MIN` (◆ binding; orphan meter blocks GA).

## 5. Builders
- **rt-edge** (#53, wave-realtime-edge, branch `feat/53-whep-v1`): `src/whep.ts` `/v1/whep/*` handler; trust
  `x-wave-internal` via the existing chokepoint; resolve org via `stream-input-org:{uid}` → relay the offer to
  the Stream WHEP playback URL → return Stream's answer+Location; PATCH/DELETE proxy to the Stream resource;
  meter on teardown; contract tests. **INERT** behind `WHEP_EGRESS_ENABLED` (+ `USE_CLOUDFLARE_STREAM`) until ◆.
- **gateway** (follow-up): add `whep` to the scope group + the `/v1/whep/*` forward mapping + Location rewrite
  + `usage.ts` `wave_whep_egress_minutes`/`STRIPE_PRICE_WHEP_EGRESS_MIN`.

## 6. Deploy ordering (◆ GO-LIVE — orchestrator's crossing, NOT this builder)
1. merge this PR (rt-edge WHEP handler, inert until flag flips on a deployed env).
2. `npx wrangler deploy` rt-edge with `WHEP_EGRESS_ENABLED` armed → prove a `/v1/whep/subscribe` probe is
   **401** (gateway-trust), NOT 501 (surface live + sealed).
3. ◆ gateway forward mapping + `whep:read` scope + `STRIPE_PRICE_WHEP_EGRESS_MIN`.
4. ◆ prove first frame: publish into a CF Stream live input (WHIP/RTMP/SRT) → WHEP-subscribe via
   `webRTCPlayback` → **first frame** lands (receipt = 201 + Stream answer SDP with the playback m-line +
   decoded first frame at the subscriber + usage row).

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

## 10. Negotiation model — RESOLVED via Cloudflare Stream webRTCPlayback (one-shot first-frame)
1. **One-shot WHEP (RESOLVED).** The prior SFU `pullTracks` path was SFU-offer / client-answer (the INVERSE
   of single-shot WHEP), which blocked single-shot first-frame. The repoint to **Cloudflare Stream WebRTC
   playback** (`.webRTCPlayback.url`) is a standard one-shot WHEP server: the edge relays the client's offer
   and Stream returns the FINAL SDP answer in the 201 body — first frame flows over that single exchange.
   There is NO `x-wave-whep-renegotiation` header and no deferred renegotiation seam. First-frame is provable
   end-to-end (see §6 step 4 receipt).
2. **Track/quality selection.** Cloudflare Stream WebRTC playback plays the live input's program; there is no
   per-track naming on the playback URL. `?resource=` is the live-input uid; no `?track=` is required. SVC /
   quality selection is a Stream-side concern, out of scope for v1.
