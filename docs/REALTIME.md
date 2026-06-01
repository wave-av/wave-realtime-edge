# WAVE Realtime — design & roadmap

WAVE Realtime is the **live control & event plane**: the WebSocket + event bus that carries session
state and events around WAVE media, distinct from the media transports (MoQ/NDI/Dante/SRT/OMT) and from
any WebRTC SFU. It is the bus the streaming-AI products (transcribe, sentiment, captions) push deltas
into, so consumers — human UIs and autonomous agents — subscribe once and receive live intelligence
with no polling.

## Why WAVE (not Supabase Realtime / LiveKit / CF Calls)
- Supabase Realtime is a *data* plane (Postgres changes). LiveKit / CF Calls are *media* SFUs.
- WAVE Realtime is purpose-built for **AV sessions**: its event vocabulary is WAVE's (`transcription.partial`,
  `caption.cue`, `sentiment.tick`, `clip.created`, `stream.*`), it federates through the same gateway and
  one API key as every WAVE product, and it is **agent-native** — pay-per-connection over x402/MPP.

## Substrate
Cloudflare **Durable Objects** (one per channel) + the WebSocket **Hibernation API** + SQLite-backed
storage for the history ring. In-stack with the rest of WAVE (all-Cloudflare). No new vendor.

## Channel namespacing
`stream:<id>` · `room:<id>` · `session:<id>` · `agent:<id>` — `[a-z0-9][a-z0-9:_-]{0,127}`.

## Roadmap
- **v0 (done):** presence, pub/sub, REST publish, last-N history, hibernation, branded front-door.
- **v1 — gateway federation:** validate Bearer scope/entitlement against api.wave.online (introspection),
  403 when not entitled; never authorize locally.
- **v1 — metering:** connection-minutes + message counts → usage events → x402 per-connection billing for
  agents (the "pay to subscribe to live media intelligence" story).
- **v1 — producer wiring:** transcribe/sentiment/captions/clips POST their deltas into `stream:<id>`; the
  gateway emits `stream.*` lifecycle.
- **v1 — typed client:** `@wave-av/sdk` `wave.realtime.connect(channel)` with typed events + reconnect.
- **v2 — durability/scale:** larger history with TTL, channel ACLs/roles, signed presence, regional DOs,
  signaling helpers for MoQ/WebRTC negotiation.

## Threat model notes
- The plane is never open: every `/v1` call requires a Bearer; entitlement federates to the gateway.
- No secret is stored in the worker. Channel ids are regex-bounded. History is bounded (≤50) to cap memory.
