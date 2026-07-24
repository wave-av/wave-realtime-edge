<div align="center">

# wave-realtime-edge

**Edge WebRTC SFU for browser-first, bidirectional interactive media — rooms, calls, and voice agents. Layer 1 of the WAVE Protocol Plane.**

![kind](https://img.shields.io/badge/kind-cloudflare--worker-555?style=flat-square) ![domain](https://img.shields.io/badge/domain-rt.wave.online-0a7?style=flat-square) ![lang](https://img.shields.io/badge/lang-TypeScript-3178c6?style=flat-square) ![visibility](https://img.shields.io/badge/visibility-public-brightgreen?style=flat-square)

[repo](https://github.com/wave-av/wave-realtime-edge) · [Docs](https://docs.wave.online) · [Status](https://wave.online/status)

</div>

> This README is machine-generated from WAVE's grounded Single Source of Truth — every
> factual claim below traces to a resolver that `npm run verify` checks against the live
> repo and live endpoints. Nothing here is asserted without a receipt.

---

## Quick start

```bash
npm install
```

```bash
npx wrangler dev      # local dev (health only until substrate lands)
npm run typecheck
npm run test          # contract tests (vitest)
npm run deploy        # wrangler deploy
```

## Status

Early scaffold. The Worker serves /health; all other routes return 501 REALTIME_NOT_IMPLEMENTED. The substrate decision — custom SFU on Workers + Durable Objects vs. LiveKit — is Wave-1 work and not yet made.

An OpenAPI 3.1 spec (docs/api/openapi.yaml) and contract test suite exist and are passing (#10/#12); the runtime implementation is the open work.

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
                      │  edge SFU · CF Workers + DOs (substrate TBD)
                      │  /api/* → api.wave.online (gateway-enforced)
                      ▼
                  the WAVE API gateway → auth · scope · meter
```

## See also

docs/api/openapi.yaml — OpenAPI 3.1 contract (passing contract tests)
docs/REALTIME.md — substrate decision notes
threat-model.md, SECURITY.md, CONTRIBUTING.md

## Capabilities

| Capability | Status |
| --- | --- |
| Unconditional liveness check, GET /health, no auth | ![ga](https://img.shields.io/badge/ga-brightgreen?style=flat-square) |
| WebSocket room presence/state-sync at /v1/realtime/rooms/{room}/presence | ![scaffolded](https://img.shields.io/badge/scaffolded-orange?style=flat-square) |
| Custom SFU on a Cloudflare Durable Object (ROOM binding) for multi-party media | ![preview](https://img.shields.io/badge/preview-blue?style=flat-square) |
| IETF WHEP v1 egress: POST /v1/whep/subscribe, PATCH/DELETE /v1/whep/resource/{id} | ![preview](https://img.shields.io/badge/preview-blue?style=flat-square) |
| IETF WHIP v1 ingest: POST /v1/whip/publish, PATCH/DELETE /v1/whip/resource/{id} | ![preview](https://img.shields.io/badge/preview-blue?style=flat-square) |

## API

| Method | Path | Does |
| --- | --- | --- |
| `GET` | `/health` | Liveness check, no auth |
| `POST` | `/v1/whip/publish` | WHIP ingest offer handshake -&gt; 201 + SDP answer |
| `PATCH` | `/v1/whip/resource/{id}` | WHIP trickle-ICE candidate update |
| `DELETE` | `/v1/whip/resource/{id}` | WHIP teardown, stops the ingest meter |
| `POST` | `/v1/whep/subscribe` | WHEP egress offer handshake -&gt; 201 + SDP answer |
| `PATCH` | `/v1/whep/resource/{id}` | WHEP trickle-ICE candidate update |
| `DELETE` | `/v1/whep/resource/{id}` | WHEP teardown, stops the egress meter |
| `GET` | `/v1/realtime/rooms/{room}/presence` | WebSocket upgrade for room presence/state-sync (PRESENCE_ENABLED gated) |

## Transports

| Transport | Direction | Status |
| --- | --- | --- |
| WHIP | in | ![preview](https://img.shields.io/badge/preview-blue?style=flat-square) |
| WHEP | out | ![preview](https://img.shields.io/badge/preview-blue?style=flat-square) |
| presence-websocket | bidir | ![scaffolded](https://img.shields.io/badge/scaffolded-orange?style=flat-square) |

## The receipts

Every claim below is checked by `npm run verify` against the live repo or endpoint — a non-`pass` verdict fails the gate.

| Claim | How it's verified |
| --- | --- |
| Protocol requests carry a wave-token-v1 Bearer token, forwarded untouched to the gateway | resolved by grepping `docs/REALTIME.md` |
| Worker is routed on the custom domain rt.wave.online | resolved by grepping `wrangler.toml` |
| Publishes rtc.session.opened and rtc.session.closed as x402-metered events | resolved by grepping `capabilities.json` |
| Presence route is gated by PRESENCE_ENABLED, which is absent from wrangler.toml (default off) | resolved by grepping `src/dispatch-helpers.ts` |
| Repo is tagged protocol-plane-layer-1 in capabilities.json | resolved by grepping `capabilities.json` |
| WHEP_EGRESS_ENABLED is armed ("1") in the deployed wrangler.toml env | resolved by grepping `wrangler.toml` |
| WHIP_INGEST_ENABLED is armed ("1") in the deployed wrangler.toml env | resolved by grepping `wrangler.toml` |

## Topics

`edge` · `webrtc` · `sfu` · `x402-metered` · `protocol-plane-layer-1`

---

<div align="center">

**Built by [WAVE Online, LLC](https://wave.online)** · [wave.online](https://wave.online) · [Docs](https://docs.wave.online) · [LinkedIn](https://www.linkedin.com/company/wave-online)

</div>

