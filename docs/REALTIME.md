# WAVE Realtime API

Edge WebRTC SFU for browser-first, bidirectional media — rooms, voice agents, calls.

**Status: live.** The substrate decision is made and shipped: **Cloudflare Realtime (Calls) SFU +
per-room Durable Object** (`SfuClient` in `src/sfu.ts` = media plane; `RoomDO` in `src/room.ts` =
control plane). Rooms, WHIP ingest, WHEP egress, the CF Stream bridge, and voice agents are armed
live; the surfaces listed as *inert* below are built but gated off in `wrangler.toml`.

---

## Architecture

```
client ──Authorization: Bearer <wave-token-v1>──▶  rt.wave.online  (this worker)
                                                        │ forwards auth untouched
                                                        ▼
                                          the WAVE API gateway  ──authorize·meter·x402──▶  origin
```

The edge worker is deliberately thin:  it does not validate tokens or make access
decisions. All auth, entitlement, and x402 metering enforcement happen at the
gateway upstream.

---

## Base URL

```
https://rt.wave.online
```

---

## Endpoints

| Method | Path | Auth | Status | Purpose |
|--------|------|------|--------|---------|
| `GET`  | `/health` | None | **Live** | Liveness check |
| `GET`  | `/` | None | **Live** | Branded landing page |
| `POST` | `/rtk/join` | Bearer | **Live** | RealtimeKit meeting create + participant token mint |
| `POST` | `/rtk/turn` | Bearer | **Live** | TURN/ICE credential mint (NAT traversal) |
| `POST` | `/rtk/recording-webhook` | Bearer | **Live** | Recording status update (managed PULL puller) |
| `POST` | `/v1/realtime/rooms/{room}/{intent}` | Bearer | **Live** | Room signaling: join/publish/subscribe/renegotiate/leave (RoomDO) |
| `POST` | `/v1/whip/publish` | Bearer | **Live** | Publish a WebRTC track (WHIP ingest) |
| `PATCH` / `DELETE` | `/v1/whip/resource/{id}` | Bearer | **Live** | WHIP trickle-ICE update / teardown |
| `POST` | `/v1/whep/subscribe` | Bearer | **Live** | Subscribe to a WebRTC track (WHEP egress) |
| `PATCH` / `DELETE` | `/v1/whep/resource/{id}` | Bearer | **Live** | WHEP trickle-ICE update / teardown |
| `POST` | `/v1/stream/bridge/webhook` | HMAC | **Live** | CF Stream → SFU bridge receiver |
| `POST` | `/v1/realtime/agents/{intent}` | Bearer | **Live** | Voice agent bind/info (`VOICE_AGENT_PROVIDER=wave`) |
| `POST` | `/v1/realtime/ingress/{protocol}/{intent}` | Bearer | **Live** | Routed ingest create/delete (armed 2026-07-15) |
| `GET`  | `/v1/realtime/rooms/{room}/presence` | Bearer | **Inert** | Room presence WebSocket (`PRESENCE_ENABLED` off) |

> Route-to-flag provenance: statuses here trace to `wrangler.toml` gates (`WHIP_INGEST_ENABLED`,
> `WHEP_EGRESS_ENABLED`, `STREAM_BRIDGE_ENABLED`, `VOICE_AGENT_PROVIDER`, `INGRESS_ROUTER_ENABLED`,
> `PRESENCE_ENABLED`) and the dispatch table in `src/route-dispatch.ts`. The 501 catch-all is the
> honest fall-through for any un-gated route.

---

## Authentication

Pass a `wave-token-v1` Bearer token on every protocol request:

```
Authorization: Bearer <wave-token-v1>
```

Tokens are issued by the WAVE gateway. The edge worker forwards this header and
never reads or validates it.

---

## x402 Payment (planned)

Protocol endpoints are `x402-metered`. If the gateway determines the caller has
not pre-authorized the per-connection charge it returns:

```
HTTP 402 Payment Required
WWW-Authenticate: Payment realm="wave", amount="1000", asset="0x...",
                  network="8453", payTo="0x...", nonce="<nonce>"
```

**Retry flow:**

1. Receive `402` — read `WWW-Authenticate: Payment` parameters.
2. Settle the on-chain charge using the `payTo` address, `amount`, and `nonce`.
3. Retry the original request with:
   ```
   Authorization: Payment <base64-settlement-proof>
   ```
4. The gateway verifies the proof and allows the connection.

---

## Health check

```bash
curl https://rt.wave.online/health
```

```json
{
  "ok": true,
  "service": "wave-realtime-edge",
  "layer": "edge",
  "protocol": "webrtc-sfu",
  "version": "dev"
}
```

---

## WHIP — Publish a stream (live)

```bash
# SDP offer from your WebRTC client
curl -X POST https://rt.wave.online/v1/whip/publish \
  -H "Authorization: Bearer <wave-token-v1>" \
  -H "Content-Type: application/sdp" \
  --data-binary @offer.sdp
```

On success (`201 Created`) the response body is an SDP answer. ICE candidates are
signalled via `Link` header (trickle ICE). The `Location` header holds the session
resource URL for teardown (`DELETE /v1/whip/resource/{id}`).

---

## WHEP — Subscribe to a stream (live)

```bash
curl -X POST https://rt.wave.online/v1/whep/subscribe \
  -H "Authorization: Bearer <wave-token-v1>" \
  -H "Content-Type: application/sdp" \
  --data-binary @offer.sdp
```

On success (`201 Created`) the response body is an SDP answer. The `Location` header
holds the session resource URL for teardown (`DELETE /v1/whep/resource/{id}`).

---

## OpenAPI spec

Machine-readable spec: [`docs/api/openapi.yaml`](api/openapi.yaml)
(OpenAPI 3.1.0)

---

## See also

- [Protocol Plane framework](https://github.com/wave-av/wave-foundation/blob/master/frameworks/protocol-plane/README.md)
- [Realtime-media framework](https://github.com/wave-av/wave-foundation/tree/master/frameworks/realtime-media) — substrate decision rules (LiveKit vs. custom DO SFU)
- [threat-model.md](../threat-model.md) — trust boundary and security posture
- [WAVE Developer Portal](https://dev.wave.online)
