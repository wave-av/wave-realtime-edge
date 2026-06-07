# wave-realtime-edge

> **WAVE realtime edge — browser-first 2-way interactive media.** Edge WebRTC SFU for rooms, calls,
> and voice agents. Layer 1 of the WAVE Protocol Plane.

Like Stripe is for payments and Resend is for email — **WAVE is for live streaming and video.** This
spoke is the interactive media layer: 2-way N-N calls and voice agents, the complement to
`wave-moq-edge` (1-to-many broadcast).

## Status

**Early scaffold.** The Worker serves `/health`; all other routes return `501 REALTIME_NOT_IMPLEMENTED`.
The substrate decision — custom SFU on Workers + Durable Objects vs. LiveKit — is Wave-1 work and
not yet made.

An OpenAPI 3.1 spec (`docs/api/openapi.yaml`) and contract test suite exist and are passing (#10/#12);
the runtime implementation is the open work.

## Which spoke to use

| Use case | Spoke |
|---|---|
| 1-1 or N-N call (rooms, voice agents) | **wave-realtime-edge** |
| 1-to-many livestream | `wave-moq-edge` |
| Studio-grade broadcast (NDI/Dante/SRT) | `wave-bridge-edge` |
| Browser playback of recorded content | `wave-clip-engine` |

## Architecture

```
browser ──WebRTC──▶ wave-realtime-edge (this spoke)
                      │  edge SFU · CF Workers + DOs (substrate TBD)
                      │  /api/* → api.wave.online (gateway-enforced)
                      ▼
                  wave-gateway → auth · scope · meter
```

## Develop

```bash
npm install
npx wrangler dev      # local dev (health only until substrate lands)
npm run typecheck
npm run test          # contract tests (vitest)
npm run deploy        # wrangler deploy
```

## See also

- `docs/api/openapi.yaml` — OpenAPI 3.1 contract (passing contract tests)
- `docs/REALTIME.md` — substrate decision notes
- `threat-model.md` · `SECURITY.md` · `CONTRIBUTING.md`

---

[wave.online](https://wave.online) · [Docs](https://wave.online/docs)
