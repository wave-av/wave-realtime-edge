# WHEP Live Egress Go-Live — End-to-End Proof Report

**Date:** 2026-07-16 · **Verdict:** ✅ **PROVEN LIVE** · **Billed:** $0 (dogfood-excluded)
**Epic:** `claude-workstation/governance/plans/whep-live-egress-golive/epic.md`
**Design spec:** [`docs/superpowers/specs/2026-07-15-whep-live-egress-golive-design.md`](../specs/2026-07-15-whep-live-egress-golive-design.md)
**Machine-readable ledger:** [`whep-live-egress-receipts.json`](./whep-live-egress-receipts.json)
**Spans:** wave-realtime-edge (keystone) · wave-desktop (client) · wave-gateway (auth/reverse-proxy)

> This is the assurance artifact for the CF-Stream-WHEP egress plane un-park. Every row is a
> **receipt**, not a hope — a command + its observed output. Governed by [[proven-live-or-not-done]]:
> a 201 is not proof; the media receipt is `bytesReceived > 0`.

---

## North-Star verdict — met

A WHEP subscribe against a live, org-registered CF Stream Live input, **through the production
gateway**, returns `201 + SDP answer`, the viewer's `getStats` shows `inbound-rtp.bytesReceived > 0`
(real VP9 media, not a bare handshake), and a `wave_whep_egress_minutes` meter event fires on
egress-session end — **dogfood-excluded** (no Stripe charge). Proven from the werift harness; the
desktop client path (Phase C) is shipped INERT pending merge.

**One-line chain:** `dogfood key → gateway auth → scope → entitlement-floor → forward → edge(rt.wave.online) → WHEP relay → CF Stream WebRTC playback → browser recvonly → bytesReceived>0 → teardown → meter tick → excluded`.

---

## Go-Live scorecard

| Phase | Task | What | Status | Key receipt |
|-------|------|------|--------|-------------|
| **A** ingest-arm | #160 | provision route + CF adapter + org-KV | ✅ PROVEN LIVE (INERT flag) | `POST /v1/whep/sources → 201 {uid, endpoints}` |
| **B** source-feeds | #161 | WHIP-to-Stream feed (real VP9 media) | ✅ PROVEN LIVE | CF `/webRTC/play → 201 + answer + 2 tracks` |
| **C** client-discovery | #162 | desktop picker + `?resource=` threading | 🟡 SHIPPED INERT | wave-desktop PR **#53** (◆ Jake-merge) |
| **D** live-proof | #163 | subscribe → media flows | ✅ PROVEN LIVE | `bytesReceived:4224 packets:38 kinds:[audio,video]` |
| **E** meter-receipt | #164 | egress minutes metered + excluded | ✅ PROVEN LIVE | `wave_whep_egress_minutes=60000ms → 1 min, $0 billed` |

---

## Phase-by-phase receipts (mapped to the epic Done-checks)

### Phase A — ingest-arm ✅
- **Provision:** `POST api.wave.online/v1/whep/sources` (Bearer `WHEP_DOGFOOD_KEY`) → **201** `{uid, endpoints:[rtmp,srt]}`. Full chain: auth → scope → entitlement-floor → gateway-forward → edge → CF create-input.
- **KV:** forward `stream-input-org:<uid> = <org>` (bare string) + reverse `org-stream-inputs:<org>` index; **saga compensation** deletes the orphan CF input if the required forward-KV write fails.
- **Flag:** `INGRESS_ROUTER_ENABLED 0→1` (PR #192, deploy run `29450533498`). Blast radius verified scoped — only `maybeHandleWhepSources` reads it.
- **Root-cause fix:** `CfStreamLiveClientImpl` stored the unbound global `fetch` as an instance prop → Workers **"Illegal invocation"** → 502. Fix = `fetch.bind(globalThis)` (PR #196) + regression test on the default-fetch path. PRs: #188, #190, #192, #193, #196.

### Phase B — source-feeds ✅
- **Architectural finding (grounds the whole plane):** CF Stream WebRTC (WHEP) playback is served **only for WHIP-ingested inputs**. RTMPS/SRT ingest → HLS/DASH (WebRTC playback = 409 "broadcast not started"). ⇒ the WHEP egress proof **must feed via WHIP-to-Stream** (browser sendonly → input `webRTC.url`), not ffmpeg RTMPS.
- **Codec ceiling:** CF accepts **VP9(rec)/VP8/h264-Constrained-Baseline-L3.1** (720p cap); 1080p H.264 exceeds L3.1 → pipeline errors. Fix = `setCodecPreferences` VP9-first.
- **Receipt:** `harness/whip-to-stream-pub.mjs` (Chromium, real looping **VP9 Big Buck Bunny 1080p** via `--use-file-for-fake-video-capture`) → input connected; direct CF `/webRTC/play` → **201 + answer + 2 tracks negotiated**. Harnesses merged PR #197.

### Phase C — client-discovery 🟡 SHIPPED INERT
- Closed the last desktop gap: the receive path never selected a source → bare subscribe → gateway **400**. Wired org-scoped discovery + picker + `?resource=` threading.
- **wave-desktop PR #53** (`feat/whep-c-source-discovery`, +199/-12): `SessionSource{uid,room,createdAt}` schema + `sessionListSources` channel; `whep:read` `GET /v1/whep/sources` handler (404/501 edge-INERT → honest `[]`, other non-2xx surfaces — no silent mask); `buildSubscribeEndpoint(endpoint,uid)` (URL-encoded `?resource=`, tested pure helper); `Receivers.tsx` `<select>` picker.
- **Receipts:** `type-check` clean · `vitest` **139/139** (3 new) · `lint` 0 warnings. Pure INERT client code. **Merge is ◆ Jake's-hand** (wave-desktop `main` is PR-required).

### Phase D — live-proof ✅ (the money shot)
- **Receipt:** `api.wave.online/v1/whep/subscribe?resource=<uid>` (Bearer `WHEP_DOGFOOD_KEY`) → **201** → `RECEIPT-PROVEN bytesReceived:4224 packets:38 kinds:[audio,video]` — 2 tracks connected, real VP9 media.
- **Relay bug found + fixed:** `liveWhepDeps()` stored the **unbound** global `fetch` → `deps.fetch()` "Illegal invocation" → `REALTIME_UPSTREAM 503` on **every** live subscribe (whole egress plane was dead despite auth/scope/entitlement/CF all green). Fix = `fetch: fetch.bind(globalThis)` (PR #209, deploy run `29467027860`) + regression test driving the DEFAULT `liveWhepDeps` path with a `this`-strict fetch stub.
- **Isolation matrix that cracked it:** direct CF `/webRTC/play` → `bytesReceived>0` (CF+media+codec OK) while gateway→edge → 503 ⇒ bug isolated to WAVE edge code. HLS 500 was a **red herring** (WebRTC-ingested inputs serve via WHEP, not HLS).

### Phase E — meter-receipt ✅
- **Flow:** subscribe → **201** (Location `/v1/whep/resource/<rid>`) → held (real bytes 15228) → **DELETE → 204** → edge `emitWhepTeardownMeter` `POST /v1/internal/usage` → gateway ingest → counter store.
- **Meter read:** `GET /v1/usage` shows `wave_whep_egress_minutes = 60000ms` → **billable 1 minute** for dogfood org `18e9224a` (baseline 0).
- **Registration (verify-findings win):** origin/main `src/product-meters.ts:169` already registers `{event:"wave_whep_egress_minutes", priceEnv:"STRIPE_PRICE_WHEP_EGRESS_MIN"}` (price `price_1TpvB8…`, $0.003/min live). ⚠️ The local WSC gateway checkout was **1316 commits stale** — always verify gateway via `gh api …/origin-main`, never the local tree. An unregistered meter is **silently dropped** at ingest.
- **Dogfood exclusion (2-layer, proven):** gateway's deployed `wrangler.toml [vars]:522` `BILLING_EXCLUDE_ORGS="18e9224a-…"` → meter-sync `parseBillingExcludeOrgs` → `has(org)` → `continue` **before any Stripe call** (layer 1); `!customerId` → `continue` (layer 2). Gateway reads its **own toml, not Doppler**. Same path proven for WHIP #109 on this exact org. **$0 billed.**

---

## ◆ Crossings status

| Crossing | State |
|----------|-------|
| Dogfood WHEP key mint | ✅ DONE — Supabase `api_keys` `be5af222-…`, `18e9224a`, scopes `[whep:read,whep:write,usage:read]` → Doppler `WHEP_DOGFOOD_KEY`. **No Stripe write.** |
| `WAVE_INTERNAL_SECRET` sync (#155) | Not needed — dogfood-key path made direct-edge unnecessary (orphan untouched). |
| Real external Stripe subscription | Not needed for proof — dogfood floor is cleaner; still valid for a future real-customer entitlement proof. |

---

## Residual follow-ups (tracked, non-blocking)

- **wave-desktop PR #53 merge** — ◆ Jake's-hand.
- **`route-dispatch.ts` decompose** — 799 lines, 1 from the 800 file-size ceiling.
- **Re-home epic commit `cbec1ca`** off `epic/metronome-m-phases` at PR time.
- **Daily meter-sync cron flush** of today's WHEP row — will skip via `BILLING_EXCLUDE_ORGS` (deterministic, auto).

---

## Reusable proof rig

- **Publish:** `harness/whip-to-stream-pub.mjs` — `FAKE_VIDEO_Y4M` + `FAKE_AUDIO_WAV` (VP9), `HOLD_MS ≥ 240000` (must outlast the subscribe — a 240s hold expired mid-run once → 503).
- **Subscribe (media):** `harness/whep-subscribe-proof.mjs` — `BEARER=$WHEP_DOGFOOD_KEY RESOURCE=<uid>` → `bytesReceived` receipt.
- **Subscribe (meter):** `.whep-meter-proof.mjs` — subscribe + hold + DELETE (must live **inside** the edge repo; `NODE_PATH` doesn't resolve ESM imports).
- **Assets:** BBB 1080p mp4 → Y4M 30fps (`ffmpeg -r 30 -pix_fmt yuv420p -f yuv4mpegpipe`) + tone WAV.
- **Cleanup:** 5 test CF inputs + KV mappings all `DELETE 200`.

---

_Related: [[proven-live-or-not-done]] · [[confirm-before-irreversible-op]] · [[verify-findings-before-acting]] · go-live memory `team/whep-live-egress-golive-epic-2026-07-15.md`._
