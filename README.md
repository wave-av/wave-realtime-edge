<img src="./favicon.svg" width="56" align="left" alt="Realtime mark" />

# wave Realtime

### → [realtime.wave.online](https://realtime.wave.online)

The live **control & event plane** for WAVE — presence, pub/sub broadcast, and a streaming-event bus over one WebSocket, on Cloudflare Durable Objects, federated through [api.wave.online](https://api.wave.online).

![accent](https://img.shields.io/badge/accent-ff715d-ff715d?style=flat-square&label=%20) `oklch(0.72 0.18 30)` · `#ff715d`

---

## What it is (and isn't)

WAVE already moves **media** over its transports — MoQ, NDI, Dante, SRT, OMT, Bridge. Realtime moves the **session around that media**: who's connected, the messages between them, and the live events WAVE products emit. It is **not** a media transport and **not** a WebRTC SFU. It's the connective tissue — the bus the streaming-AI products push into so a UI or an agent subscribes **once** and gets live intelligence with zero polling.

## Primitives

| | call | effect |
|---|---|---|
| **Presence** | subscribe to a channel | you appear to others; `presence` lists members; auto-leave on disconnect |
| **Broadcast** | `publish {event,data}` | every subscriber receives it — chat, reactions, cues, control |
| **Events** | producers `POST …/publish` | WAVE products push deltas: `transcription.partial`, `caption.cue`, `sentiment.tick`, `clip.created`, `stream.*` |

## API (v0)

```
WS    GET  /v1/connect?channel=<id>[&as=<member>]   subscribe (welcome → presence + history + live frames)
REST  POST /v1/channels/:id/publish   {event,data}  publish one event
REST  GET  /v1/channels/:id/presence                who is connected
REST  GET  /v1/channels/:id/history?limit=N         last-N events (≤50)
GET   /health · GET /                                liveness · front-door
```

All `/v1` calls require `Authorization: Bearer <WAVE API key>`; scope, entitlement, and metering are enforced at the gateway.

```bash
wscat -c "wss://realtime.wave.online/v1/connect?channel=stream:abc" -H "Authorization: Bearer $WAVE_API_KEY"
curl -X POST https://realtime.wave.online/v1/channels/stream:abc/publish \
     -H "Authorization: Bearer $WAVE_API_KEY" -d '{"event":"caption.cue","data":{"text":"…and we are live"}}'
```

## Architecture

One **Durable Object per channel** (`Channel`, `src/channel.ts`) = the authoritative room: hibernatable subscriber sockets (WebSocket Hibernation API → idle rooms cost nothing), the live presence set, and a SQLite-backed last-N history ring. Single-threaded per channel id, so no locks. The worker (`src/worker.ts`) authenticates, validates the channel id, and routes to the channel's DO.

## Status

**Early.** v0 (presence · pub/sub · history) is implemented on Durable Objects. Rolling out: gateway entitlement federation, per-connection x402 metering, producer wiring from the AI spokes, and a typed client in the SDK. See `docs/REALTIME.md` and the issues.

_A thin WAVE spoke: it serves this front-door + the realtime API at the edge and federates auth / scope / metering through the gateway._
