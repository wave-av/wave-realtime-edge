# voice-agent real-media harness (#81)

End-to-end harness that drives the **live** voice-agent runtime against the real CF Realtime SFU + `rt.wave.online`. It publishes real audio as a participant, binds the agent, subscribes to the agent track, and proves the agent's media is correct.

> **ISOLATION:** `werift` (Node WebRTC) + `opusscript` are **Node-only** and must NEVER enter the Cloudflare Worker bundle. This harness is a standalone Node package for exactly that reason.

## Setup

```
cd harness && npm install
```

Creds come from Doppler (`wave/prd`), referenced via env, never logged:
`CF_CALLS_APP_ID`, `CF_CALLS_APP_SECRET`, `WAVE_REALTIME_INTERNAL_SECRET` (bind seal), and for Leg 3's STT gold layer `WAVE_GATEWAY_URL` + `WAVE_GATEWAY_API_KEY` (a real **customer** key — never the internal service token; no customer-key bypass).

## Legs

| Leg | File | Proves |
|-----|------|--------|
| 3 | `leg3.mjs` | Content-integrity: the agent's published Opus decodes to non-silent **stereo** speech (the #30 mono→stereo upmix), envelope dynamics + dual-mono L/R correlation, and (GOLD) an STT word-proof of the reply. |
| 4 | `leg4-bargein.mjs` | **Barge-in**: the agent stops talking when the user speaks over it, and the end-to-end stop latency (target `<300ms`). Bed → utterance → (agent replies) → fresh loud barge → measure RTP-stop. |

```
doppler run --project wave --config prd -- node harness/leg3.mjs
doppler run --project wave --config prd -- node harness/leg4-bargein.mjs   # BARGE_TARGET_MS=300 default
```

## Libs / fixtures

- `lib-publisher.mjs` — ffmpeg→Opus/RTP→werift sendonly track into a new SFU session. `bargeSwap()` re-arms a fresh source on the same track (Leg 4).
- `lib-subscriber.mjs` — recvonly pull of the agent track; counts RTP, captures Opus payloads.
- `fixtures/phrase.aiff` — source utterance. `phrase.wav` / `phrase-endpointed.wav` (phrase + low-level noise tail so the VAD endpoints) / `silence-bed.wav` (faint noise < VAD threshold, keeps frames flowing). The decoded agent capture (`leg3-agent-capture.wav`) is generated at runtime and gitignored.
