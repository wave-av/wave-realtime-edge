# stream-bridge — #91 B2 whep-to-whip republisher container

Pulls a Cloudflare Stream `live_input`'s **WHEP** egress and republishes it through the **existing WAVE
gateway WHIP path** (`/v1/whip/publish`) into the CF Realtime SFU — so a live CF Stream input becomes a
normal SFU track and the recorder (#68) + any-to-any matrix (#86) attach unchanged. **Passthrough only —
no transcode** (frozen-contract §9.4).

Frozen wire contract: `~/.claude/plans/wave-any-to-any-matrix/cf-stream-bridge-frozen-contract-DRAFT.md` (§5).

## Why a container (not a Worker)

A WHEP→WHIP relay is a WebRTC **client** — it needs UDP / DTLS-SRTP / an RTP pipeline. A Worker can't host
that (the same wall as the honest-501). Media terminates in this container + the SFU, **never on a Worker**
(§9.2). The runtime is [werift](https://github.com/shinyoshiaki/werift-webrtc) (Node WebRTC).

## Control contract (text/JSON only — media never crosses this HTTP seam)

| Method | Path      | Body            | Effect |
|--------|-----------|-----------------|--------|
| GET    | `/health` | —               | `200 {ok:true}` |
| POST   | `/start`  | `{room, uid}`   | open WHEP-in (`uid` → live_input), republish into the SFU room |
| POST   | `/stop`   | —               | WHIP DELETE → SFU close → stop meter, then WHEP close |

The B1 edge control plane (`src/stream-bridge.ts`) dispatches these via
`getContainer(env.STREAM_BRIDGE, "${org}:${uid}").fetch('/start'|'/stop')`.

## Env

| Var | Meaning |
|-----|---------|
| `PORT` | control server port (default 8080; matches `StreamBridgeContainer.defaultPort`) |
| `WHEP_SRC_URL_TEMPLATE` | live_input WHEP URL with `{uid}` placeholder (or `WHEP_SRC_URL` fixed) |
| `WHIP_DST_URL` | gateway WHIP endpoint — `https://gateway.wave.online/v1/whip/publish` |
| `WHIP_KEY` | the bridge `wk_` key (gateway derives org/keyId server-side from it — §9.1) |
| `WHEP_AUTH` | optional Bearer for a signed/token-gated WHEP source (contract Q-2) |

## Shared core

The WHIP-out leg is [`@wave-av/whip-publish`](../../../.ess-clones/wave-foundation/packages/whip-publish)
v0.2.0 used verbatim: `pull()` (WHEP-in) → `adaptTrack` (werift relay-track, RTP-piped) → `publish({ tracks })`
(relay source mode, #758). The pure orchestration lives in `server/relay.mjs` (unit-tested, no werift/network);
`server/index.mjs` wires the werift `pcFactory` + RTP forwarding.

## Status

**INERT.** The `[[containers]] StreamBridgeContainer` binding in `wrangler.toml` is COMMENTED. The orchestration
is unit-proven (`test/relay.test.mjs`); the live WHEP→WHIP **RTP forwarding** is proven at ◆ go-live (§7.6:
real RTMPS push → an SFU track id — a bare WHIP 201 is not proof). Go-live is a Jake-named crossing: image
build + bridge `wk_` key mint + CF Stream webhook secret + `STREAM_BRIDGE_ENABLED=1`.

## Test

```
npx vitest run --config containers/stream-bridge/vitest.config.mjs
```
