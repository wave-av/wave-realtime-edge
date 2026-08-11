<div align="center">

# wave-realtime-edge

**Edge WebRTC SFU for browser-first, bidirectional interactive media — rooms, calls, and voice agents. Layer 1 of the WAVE Protocol Plane.**

![kind](https://img.shields.io/badge/kind-cloudflare--worker-555?style=flat-square) ![domain](https://img.shields.io/badge/domain-rt.wave.online-0a7?style=flat-square) ![lang](https://img.shields.io/badge/lang-TypeScript-3178c6?style=flat-square) ![visibility](https://img.shields.io/badge/visibility-public-brightgreen?style=flat-square)

[repo](https://github.com/wave-av/wave-realtime-edge) · [Docs](https://docs.wave.online) · [Status](https://wave.online/status)

</div>

> The status claims below trace to the shipped `wrangler.toml` feature flags and
> `src/route-dispatch.ts` route table at the pinned revision — flip a flag and the status
> here is wrong. When in doubt, the code is the receipt.

---

## Quick start

```bash
npm install
```

```bash
npx wrangler dev      # local dev (full route surface)
npm run typecheck
npm run test          # contract tests (vitest)
npm run deploy        # wrangler deploy
```

## Status

**Live.** The substrate decision is made and shipped: a **custom SFU on Cloudflare Realtime (Calls) + a per-room Durable Object** — `SfuClient` (`src/sfu.ts`) is the media plane, `RoomDO` (`src/room.ts`) is the control plane (`/v1/realtime/rooms/{room}/{intent}`). Not LiveKit.

| Surface | Path | Status |
| --- | --- | --- |
| Interactive rooms (join/publish/subscribe/renegotiate/leave) | `/v1/realtime/rooms/{room}/{intent}` | **Live** — RoomDO substrate |
| WHIP v1 ingest (publish WebRTC) | `/v1/whip/publish` · `/v1/whip/resource/{id}` | **Live** (armed 2026-06-24) |
| WHEP v1 egress (subscribe WebRTC) | `/v1/whep/subscribe` · `/v1/whep/resource/{id}` | **Live** (armed 2026-07-01) |
| CF Stream → SFU bridge | `/v1/stream/bridge/webhook` | **Live** (armed 2026-06-26) |
| Voice agents | `/v1/realtime/agents/*` | **Live** (`VOICE_AGENT_PROVIDER=wave`, armed 2026-06-25) |
| Recording (managed PULL) | `/rtk/recording-webhook` | **Live** (`RT_RECORD=1`) |
| Routed ingest router | `/v1/realtime/ingress/{protocol}/{intent}` | **Live** (armed 2026-07-15) |
| Routed egress router (wave-render/RunPod/Stream) | `EGRESS_ROUTER_ENABLED` | **Inert** — backends built, not armed |
| Room presence WebSocket | `/v1/realtime/rooms/{room}/presence` | **Inert** — `PRESENCE_ENABLED` off |
| Multi-region cascade | `RT_CASCADE` | **Inert** — single-region today |

An OpenAPI 3.1 spec (`docs/api/openapi.yaml`) and a 200+ file contract test suite run on every PR.

Like Stripe is for payments and Resend is for email — WAVE is for live streaming and video. This spoke is the interactive media layer: 2-way N-N calls and voice agents, the complement to wave-moq-edge (1-to-many broadcast).

## Which spoke to use

| Use case | Spoke |
| --- | --- |
| 1-1 or N-N call (rooms, voice agents) | wave-realtime-edge |
| 1-to-many livestream | wave-moq-edge |
| Studio-grade broadcast (NDI/Dante/SRT) | wave-bridge-edge |
| Browser playback of recorded content | the clip service |

## Architecture

```text
browser ──WebRTC──▶ wave-realtime-edge (this spoke)
                      │  edge SFU · Cloudflare Realtime (Calls) + per-room Durable Object
                      │  /api/* → api.wave.online (gateway-enforced)
                      ▼
                  the WAVE API gateway → auth · scope · meter
```

## See also

docs/api/openapi.yaml — OpenAPI 3.1 contract (passing contract tests)
docs/REALTIME.md — realtime API surface and substrate notes
threat-model.md, SECURITY.md, CONTRIBUTING.md

## Capabilities

| Capability | Status |
| --- | --- |
| Interactive rooms via RoomDO: join/publish/subscribe/renegotiate/leave at /v1/realtime/rooms/{room}/{intent} | ![live](https://img.shields.io/badge/live-brightgreen?style=flat-square) |
| Custom SFU on Cloudflare Realtime (Calls): SfuClient media plane | ![live](https://img.shields.io/badge/live-brightgreen?style=flat-square) |
| IETF WHEP v1 egress: POST /v1/whep/subscribe, PATCH/DELETE /v1/whep/resource/{id} | ![live](https://img.shields.io/badge/live-brightgreen?style=flat-square) |
| IETF WHIP v1 ingest: POST /v1/whip/publish, PATCH/DELETE /v1/whip/resource/{id} | ![live](https://img.shields.io/badge/live-brightgreen?style=flat-square) |
| CF Stream → SFU bridge webhook at /v1/stream/bridge/webhook | ![live](https://img.shields.io/badge/live-brightgreen?style=flat-square) |
| Voice agents at /v1/realtime/agents/* (VOICE_AGENT_PROVIDER=wave) | ![live](https://img.shields.io/badge/live-brightgreen?style=flat-square) |
| Managed PULL recording (RT_RECORD=1, RT_ENCODER=managed) | ![live](https://img.shields.io/badge/live-brightgreen?style=flat-square) |
| Unconditional liveness check, GET /health, no auth | ![live](https://img.shields.io/badge/live-brightgreen?style=flat-square) |
| Routed egress router (wave-render / RunPod NVENC / CF Stream passthrough), EGRESS_ROUTER_ENABLED=0 | ![inert](https://img.shields.io/badge/inert-lightgrey?style=flat-square) |
| WebSocket room presence/state-sync at /v1/realtime/rooms/{room}/presence, PRESENCE_ENABLED off | ![inert](https://img.shields.io/badge/inert-lightgrey?style=flat-square) |
| Multi-region cascade relays, RT_CASCADE off (single-region today) | ![inert](https://img.shields.io/badge/inert-lightgrey?style=flat-square) |

## API

| Method | Path | Does |
| --- | --- | --- |
| `GET` | `/health` | Liveness check, no auth |
| `GET` | `/` | Branded landing page |
| `POST` | `/rtk/join` | RealtimeKit meeting create + participant token mint |
| `POST` | `/rtk/turn` | TURN/ICE credential mint (WebRTC NAT traversal) |
| `POST` | `/rtk/recording-webhook` | Recording status update (managed PULL puller) |
| `POST` | `/v1/realtime/rooms/{room}/{intent}` | Room signaling: join/publish/subscribe/renegotiate/leave (RoomDO) |
| `POST` | `/v1/whip/publish` | WHIP ingest offer handshake -&gt; 201 + SDP answer |
| `PATCH` | `/v1/whip/resource/{id}` | WHIP trickle-ICE candidate update |
| `DELETE` | `/v1/whip/resource/{id}` | WHIP teardown, stops the ingest meter |
| `POST` | `/v1/whep/subscribe` | WHEP egress offer handshake -&gt; 201 + SDP answer |
| `PATCH` | `/v1/whep/resource/{id}` | WHEP trickle-ICE candidate update |
| `DELETE` | `/v1/whep/resource/{id}` | WHEP teardown, stops the egress meter |
| `POST` | `/v1/stream/bridge/webhook` | CF Stream → SFU bridge receiver (HMAC-verified) |
| `POST` | `/v1/realtime/agents/{intent}` | Voice agent bind/info (VOICE_AGENT_PROVIDER=wave) |
| `POST` | `/v1/realtime/ingress/{protocol}/{intent}` | Routed ingest create/delete (armed 2026-07-15) |
| `GET` | `/v1/realtime/rooms/{room}/presence` | WebSocket upgrade for room presence/state-sync (PRESENCE_ENABLED gated, inert) |

## Transports

| Transport | Direction | Status |
| --- | --- | --- |
| WHIP | in | ![live](https://img.shields.io/badge/live-brightgreen?style=flat-square) |
| WHEP | out | ![live](https://img.shields.io/badge/live-brightgreen?style=flat-square) |
| CF Realtime (Calls) SFU rooms | bidir | ![live](https://img.shields.io/badge/live-brightgreen?style=flat-square) |
| CF Stream → SFU bridge | in | ![live](https://img.shields.io/badge/live-brightgreen?style=flat-square) |
| presence-websocket | bidir | ![inert](https://img.shields.io/badge/inert-lightgrey?style=flat-square) |

## Topics

`edge` · `webrtc` · `sfu` · `x402-metered` · `protocol-plane-layer-1`

---

<div align="center">

**Built by [WAVE Online, LLC](https://wave.online)** · [wave.online](https://wave.online) · [Docs](https://docs.wave.online) · [LinkedIn](https://www.linkedin.com/company/wave-online)

</div>

