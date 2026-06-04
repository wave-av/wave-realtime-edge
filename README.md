# wave-realtime-edge

**WAVE realtime edge** — an edge WebRTC SFU for browser-first, 2-way interactive media (rooms, calls, voice agents). It is Layer 1 (Edge) of the [WAVE Protocol Plane](https://github.com/wave-av/wave-foundation/blob/master/frameworks/protocol-plane/README.md) and the sibling to `wave-moq-edge` (1-to-many broadcast).

Runs on Cloudflare Workers.

## Status

**Early / scaffold.** The Worker currently serves only `/health`; all other routes return `501 REALTIME_NOT_IMPLEMENTED`. The substrate decision — a custom SFU on Workers + Durable Objects vs. consuming LiveKit (see the `realtime-media` framework) — is Wave-1 work and not yet made.

## Which edge to use

| Use case | Substrate |
|---|---|
| 1-1 or N-N call (rooms, voice agents) | **wave-realtime-edge** |
| 1-many livestream (podcast publish) | `wave-moq-edge` or MUX |
| Studio-grade broadcast (NDI/Dante/SRT) | [`wave-bridge-edge`](https://github.com/wave-av/wave-bridge-edge) |
| Browser tab watching pre-recorded | `wave-clip-engine` + MUX |

## Develop

Requires Node.js and a Cloudflare account.

```bash
npm install
npx wrangler dev      # local dev
npm run deploy        # wrangler deploy
```

Configuration lives in [`wrangler.toml`](wrangler.toml). Secrets handling is documented in [SECRETS.md](SECRETS.md).

## See also

- [Protocol Plane framework](https://github.com/wave-av/wave-foundation/blob/master/frameworks/protocol-plane/README.md)
- [Real-time media framework](https://github.com/wave-av/wave-foundation/tree/master/frameworks/realtime-media) — LiveKit/MUX substrate decision rules
- [threat-model.md](threat-model.md) · [SECURITY.md](SECURITY.md) · [CONTRIBUTING.md](CONTRIBUTING.md)

## Links
- [wave.online](https://wave.online) · [Docs](https://docs.wave.online) · [Developer portal](https://dev.wave.online)

Operated by WAVE Online, LLC.
