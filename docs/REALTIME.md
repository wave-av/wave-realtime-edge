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
| `POST` | `/rtk/join` | Bearer (gateway-sealed) | **Live** | RealtimeKit meeting create + participant token mint |
| `POST` | `/rtk/turn` | Bearer (gateway-sealed) | **Live** | TURN/ICE credential mint (NAT traversal) |
| `POST` | `/rtk/recording-webhook` | RSA signature (`rtk-signature`) | **Live** (`RT_RECORD=1`, `RT_ENCODER=managed`) | Recording status update (managed PULL puller); public by design — self-authenticates via `rtk-signature` (RSA-SHA256 over the raw body), not `gatewayGate` |
| `POST` | `/v1/realtime/rooms/{room}/{intent}` | Bearer (gateway-sealed) | **Live** | Room signaling: join/publish/subscribe/renegotiate/leave (RoomDO) |
| `POST` | `/v1/whip/publish` | Bearer (gateway-sealed) | **Live** | Publish a WebRTC track (WHIP ingest) |
| `PATCH` / `DELETE` | `/v1/whip/resource/{id}` | Bearer (gateway-sealed) | **Live** | WHIP trickle-ICE update / teardown |
| `POST` | `/v1/whep/subscribe` | Bearer (gateway-sealed) | **Live** | Subscribe to a WebRTC track (WHEP egress) |
| `PATCH` / `DELETE` | `/v1/whep/resource/{id}` | Bearer (gateway-sealed) | **Live** | WHEP trickle-ICE update / teardown |
| `POST` | `/v1/stream/bridge/webhook` | HMAC | **Live** | CF Stream → SFU bridge receiver |
| `POST` | `/v1/realtime/agents/{intent}` | Bearer (gateway-sealed) | **Live** | Voice agent bind/info (`VOICE_AGENT_PROVIDER=wave`) |
| `POST` | `/v1/realtime/ingress/{protocol}/{intent}` | Bearer (gateway-sealed) | **Live** (`whip` only) | Routed ingest create/delete — `whip` is live; `rtmp`/`srt`/`url` return an honest 501 (need an out-of-Worker VM listener) |
| `GET`  | `/v1/realtime/rooms/{room}/presence` | Bearer (gateway-sealed) | **Inert** | Room presence WebSocket (`PRESENCE_ENABLED` off) |

> Route-to-flag provenance: statuses here trace to `wrangler.toml` gates (`WHIP_INGEST_ENABLED`,
> `WHEP_EGRESS_ENABLED`, `STREAM_BRIDGE_ENABLED`, `VOICE_AGENT_PROVIDER`, `PRESENCE_ENABLED`,
> `RT_RECORD` + `RT_ENCODER` for recording) and the dispatch table in `src/route-dispatch.ts`. The `/v1/realtime/ingress/*` route is not flag-gated
> (`whip` live, `rtmp`/`srt`/`url` honest 501); `INGRESS_ROUTER_ENABLED` (armed 2026-07-15) arms only
> `/v1/whep/sources` (`src/whep-sources.ts`), not this route. The 501 catch-all is the honest
> fall-through for any un-gated route.

---

## Authentication

Pass a `wave-token-v1` Bearer token on every protocol request:

```
Authorization: Bearer <wave-token-v1>
```

Tokens are issued by the WAVE gateway. The edge worker forwards this header and
never reads or validates it.

**Gateway seal (`x-wave-internal`).** The Bearer token is validated upstream, not
by this worker. Every route marked *Bearer (gateway-sealed)* above is enforced by
`gatewayGate` (`src/dispatch-helpers.ts`): when the `WAVE_INTERNAL_SECRET` wrangler
secret is set (every deployed env), the request must also carry the matching
`x-wave-internal` header — stamped by the gateway after auth, entitlement, and
charging — or the worker returns 401. Callers therefore reach these routes via
`api.wave.online`, never by hitting `rt.wave.online` directly; org context arrives
on the gateway-stamped `x-wave-org` header. In local/test envs where the secret is
unset, the gate is a no-op and no header is required. The two self-authenticating
webhooks (`/rtk/recording-webhook` via `rtk-signature`, `/v1/stream/bridge/webhook`
via HMAC) are deliberately outside this gate.

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
# resource = the CF Stream live-input uid of the source to play
# (the `uid` returned by POST /v1/whep/sources)
curl -X POST "https://rt.wave.online/v1/whep/subscribe?resource=<liveInputUid>" \
  -H "Authorization: Bearer <wave-token-v1>" \
  -H "Content-Type: application/sdp" \
  --data-binary @offer.sdp
```

Omitting `?resource={liveInputUid}` is rejected with `400 WHEP_BAD_REQUEST`.

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
