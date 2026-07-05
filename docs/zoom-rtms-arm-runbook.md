# Zoom RTMS → WAVE bridge — ◆ arm runbook (#88 M2)

The full RTMS bridge is built and merged to `main`, **INERT**:

| Layer | Module | Merged |
|---|---|---|
| Auth (HMAC signatures, webhook verify, url_validation) | `src/rtms-auth.ts` | #145 |
| Protocol (handshakes, keepalive, frame parse) | `src/rtms-protocol.ts` | #145 |
| Audio transcode (16k mono ↔ 48k stereo) | `src/rtms-audio.ts` | #145 |
| Webhook control plane (`POST /zoom/rtms`) | `src/zoom-rtms-bridge.ts` | #147 |
| Outbound media DO + SFU publish | `src/rtms-bridge-core.ts`, `src/zoom-rtms-bridge-do.ts` | #148 |

Nothing below runs until **all** of: `WAVE_ZOOM_RTMS` truthy · the secrets provisioned · a `RT_MEETING_ORG`
meeting→room mapping present. Any one missing → fail-closed (401 / logged no-dial / 501). Arming is a ◆
prod crossing — this runbook is the exact sequence; **do the steps in order** (secrets *before* the flag flip).

## Step 1 — Provision secrets (Jake; values never pass through the agent)

Set as Worker secrets (values from Doppler `wave/prd`, except the webhook token — see below):

| Secret | Source | Status |
|---|---|---|
| `ZOOM_RTMS_WEBHOOK_SECRET_TOKEN` | Zoom Marketplace → the WAVE app → **Feature → Event Subscription → Secret Token** | **NOT in Doppler yet** — copy from the Zoom app config |
| `ZOOM_APPS_CLIENT_ID` | Doppler `wave/prd` (General-app Client ID) | already provisioned |
| `ZOOM_APPS_CLIENT_SECRET` | Doppler `wave/prd` | already provisioned |
| `CF_CALLS_APP_ID` / `CF_CALLS_APP_SECRET` | Doppler `wave/prd` (CF Realtime SFU app) | already provisioned |
| `WAVE_INTERNAL_SECRET` | Doppler `wave/prd` (ingest capability-token key) | already provisioned |

Set each via the governed secret path (e.g. `doppler run -- wrangler secret put <NAME>` against the prod
worker) so the value is piped from Doppler, never printed. The only genuinely-new one is
`ZOOM_RTMS_WEBHOOK_SECRET_TOKEN`; consider adding it to Doppler `wave/prd` at the same time.

## Step 2 — Point the Zoom app's Event Subscription at the endpoint (Jake)

In the WAVE Zoom app → Event Subscription:
- Endpoint URL: `https://rt.wave.online/zoom/rtms`
- Subscribe to: `endpoint.url_validation`, `meeting.rtms_started`, `meeting.rtms_stopped`
- Ensure the RTMS scopes are granted (already present: `rtms_app_status`, realtime-media-streams).

Zoom sends `endpoint.url_validation` on save → the endpoint answers with
`encryptedToken = HMAC-SHA256(secretToken, plainToken)` → validation passes. (This only works once Step 1's
`ZOOM_RTMS_WEBHOOK_SECRET_TOKEN` is set **and** the flag from Step 3 is on and deployed.)

## Step 3 — Flip the flag + deploy (◆)

`wrangler.toml` `[vars]` currently has `WAVE_ZOOM_RTMS = "0"`. Flip to `"1"` (one-line PR), merge, then deploy
via the **governed deploy path** (not a raw `wrangler deploy`). The `ZOOM_RTMS_BRIDGE` DO binding + migration
`v5` deploy with it (already in `main`).

> Order matters: with the flag on but Step 1 incomplete, the endpoint is armed-but-fail-closed (webhooks 401,
> the DO refuses to dial). Harmless but noisy — do Step 1 first.

## Step 4 — Seed the meeting → room mapping (co-piloted)

The DO resolves `RT_MEETING_ORG[meeting_uuid] = {org, sessionId, trackName?}` to know **which wave room** the
tapped audio publishes into. `meeting_uuid` is per-occurrence, so this is co-piloted for the first proof:

1. Jake starts the Zoom meeting (with RTMS on). The webhook fires `meeting.rtms_started`; even unmapped, the DO
   logs `{"msg":"zoom-rtms-no-room-mapping","meetingUuid":"<uuid>"}` — grab that uuid from the Worker logs.
2. Seed KV: `RT_MEETING_ORG.put("<uuid>", JSON.stringify({ org: "<org>", sessionId: "<live SFU session in the target wave room>" }))`.
3. The next `rtms_started` for that meeting (or a rejoin) bridges. `trackName` defaults to `zoom-<uuid>`.

> Product follow-up (not required to prove): a standing Zoom↔room mapping (e.g. keyed by the host's PMI or a
> pre-registered scheduled-meeting id) removes the per-occurrence seed. That's a design decision, not a blocker
> — the resolver seam is already the injection point.

## Step 5 — Live proof (Jake starts a real meeting)

With Steps 1–4 done, on a live Zoom meeting the logs should show, in order:
`zoom-rtms-signaling-open` → `zoom-rtms-media-open` → `agent-ingest-adapter-created` (the SFU publish). The
receipt is **tapped meeting audio playing in the mapped wave room** (and metered by the perception pipeline).

This confirms the two live-spike unknowns the unit tests can't: that Zoom's real servers accept our handshake,
and that the CF SFU pulls our `/zoom/rtms/ingest` endpoint.

## Disarm

Flip `WAVE_ZOOM_RTMS` back to `"0"` and redeploy → the endpoint returns to the 501 catch-all; the DO is never
entered. Secrets can stay provisioned (unused when the flag is off).
