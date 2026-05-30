# Contributing to wave-realtime-edge

Layer-1 Edge of the [WAVE Protocol Plane](https://github.com/wave-av/wave-foundation/blob/master/frameworks/protocol-plane/README.md) — WebRTC SFU for browser-first 2-way interactive media.

## Before you start

This repo is the sibling of `wave-moq-edge`. Decision matrix:
- **2-way interactive (calls, rooms, voice agents)** → here (WebRTC SFU)
- **1-many broadcast (livestream, podcast publish)** → MUX or wave-moq-edge
- **Studio-grade broadcast protocols (NDI/Dante/SRT)** → wave-bridge-edge

See `frameworks/realtime-media` in wave-foundation for the substrate decision rule.

## Foundation gate

Standard wave-av gate runs on every PR: secret-scan + file-size + skill-validate. Required for master merge.
