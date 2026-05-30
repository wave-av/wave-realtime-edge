# wave-realtime-edge

**Edge WebRTC SFU** — Layer-1 Edge of the [WAVE Protocol Plane](https://github.com/wave-av/wave-foundation/blob/master/frameworks/protocol-plane/README.md). Browser-first 2-way interactive media on CF Workers. Sibling to `wave-moq-edge` (1-many broadcast).

## Status

Scaffold. Substrate decision (build custom SFU on Workers + Durable Objects vs. consume LiveKit as documented in `frameworks/realtime-media`) is Wave-1 work.

## Decision matrix (which to use)

| Use case | Substrate |
|---|---|
| 1-1 or N-N call (rooms, voice agents) | **wave-realtime-edge** |
| 1-many livestream (podcast publish) | wave-moq-edge or MUX |
| Studio-grade broadcast (NDI/Dante/SRT) | wave-bridge-edge |
| Browser tab watching pre-recorded | wave-clip-engine + MUX |

## Linked

- [Protocol Plane framework](https://github.com/wave-av/wave-foundation/blob/master/frameworks/protocol-plane/README.md)
- [Real-time media framework](https://github.com/wave-av/wave-foundation/tree/master/frameworks/realtime-media) — LiveKit/MUX substrate decision rules
