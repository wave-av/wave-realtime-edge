# WAVE Realtime API

Edge WebRTC SFU for browser-first, bidirectional media — rooms, voice agents, calls.

**Status: scaffold / alpha.** Only `/health` is implemented. All protocol routes
return `501 REALTIME_NOT_IMPLEMENTED` pending the substrate decision (custom SFU on
Durable Objects vs. LiveKit). This document describes the intended API surface.

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
| `POST` | `/whip/{streamKey}` | Bearer | Planned | Publish a WebRTC track (WHIP ingest) |
| `POST` | `/whep/{slug}` | Bearer | Planned | Subscribe to a WebRTC track (WHEP egress) |

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

## WHIP — Publish a stream (planned)

```bash
# SDP offer from your WebRTC client
curl -X POST https://rt.wave.online/whip/<stream-key> \
  -H "Authorization: Bearer <wave-token-v1>" \
  -H "Content-Type: application/sdp" \
  --data-binary @offer.sdp
```

On success (`201 Created`) the response body is an SDP answer. ICE candidates are
signalled via `Link` header (trickle ICE). The `Location` header holds the session
resource URL for teardown.

---

## WHEP — Subscribe to a stream (planned)

```bash
curl -X POST https://rt.wave.online/whep/<slug> \
  -H "Authorization: Bearer <wave-token-v1>" \
  -H "Content-Type: application/sdp" \
  --data-binary @offer.sdp
```

On success (`201 Created`) the response body is an SDP answer.

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
