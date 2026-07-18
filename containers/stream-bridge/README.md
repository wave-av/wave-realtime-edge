# stream-bridge — #91 B2 / #35 source-to-whip republisher container

Pulls a Cloudflare Stream `live_input`'s **LL-HLS** playback and republishes it through the **existing WAVE
gateway WHIP path** (`/v1/whip/publish`) into the CF Realtime SFU — so a live CF Stream input becomes a
normal SFU track and the recorder (#68) + any-to-any matrix (#86) attach unchanged.

Frozen wire contract: `~/.claude/plans/wave-any-to-any-matrix/cf-stream-bridge-frozen-contract-DRAFT.md` (§5).

## Why LL-HLS, not WHEP (#211, root cause proven 2026-07-18)

CF Stream Live's `/webRTC/play` (WHEP egress, beta) serves **only WebRTC-ingested (WHIP) inputs** — it returns
HTTP 409 `Live broadcast not started yet` forever for an RTMP/SRT-ingested input, even when the broadcast is
fully `live-inprogress` and HLS/LL-HLS serve 200. Since customers push RTMP/SRT, the old WHEP-pull source leg
could never come up. The feed **is** live and playable — just via LL-HLS. So the source is pulled over LL-HLS:
`ffmpeg -i <manifest>` decodes the HLS ladder and re-encodes to VP8/Opus (the CF WebRTC accept set is
`{VP9,VP8,H264-CBP-L3.1}`+Opus; VP8/Opus is the safe intersection werift carries), muxes to localhost RTP, and
werift ingests + republishes it VERBATIM on the WHIP-out leg (no second transcode, §9.4).

Provisioning requirement (also proven): the live_input needs `recording.mode:"automatic"` for ANY live
playback (`off` → `videos=0`, HLS 204, WHEP 409). The create-input adapter sets it (`src/ingress-cf-stream-live.ts`).

## Why a container (not a Worker)

The republish leg is a WebRTC **client** — it needs UDP / DTLS-SRTP / an RTP pipeline (+ ffmpeg for the LL-HLS
decode). A Worker can't host that (the same wall as the honest-501). Media terminates in this container + the
SFU, **never on a Worker** (§9.2). The runtime is [werift](https://github.com/shinyoshiaki/werift-webrtc)
(Node WebRTC) + ffmpeg.

## Control contract (text/JSON only — media never crosses this HTTP seam)

| Method | Path      | Body            | Effect |
|--------|-----------|-----------------|--------|
| GET    | `/health` | —               | `200 {ok:true}` |
| POST   | `/start`  | `{room, uid}`   | open the LL-HLS source (`uid` → live_input), republish into the SFU room |
| POST   | `/stop`   | —               | WHIP DELETE → SFU close → stop meter, then source (ffmpeg) close |

The B1 edge control plane (`src/stream-bridge.ts`) dispatches these via
`getContainer(env.STREAM_BRIDGE, "${org}:${uid}").fetch('/start'|'/stop')`.

## Env

| Var | Meaning |
|-----|---------|
| `PORT` | control server port (default 8080; matches `StreamBridgeContainer.defaultPort`) |
| `LLHLS_SRC_URL_TEMPLATE` | live_input LL-HLS manifest URL with `{uid}` placeholder (or `LLHLS_SRC_URL` fixed) |
| `WHIP_DST_URL` | gateway WHIP endpoint — `https://gateway.wave.online/v1/whip/publish` |
| `WHIP_KEY` | the bridge `wk_` key (gateway derives org/keyId server-side from it — §9.1) |
| `SOURCE_AUTH` | optional Bearer for a signed/token-gated source manifest (contract Q-2) |

## Shared core

The pure orchestration lives in `server/relay.mjs` (unit-tested, no werift/network): open source → collect
tracks → publish verbatim → teardown, fail-loud. It is source-agnostic — dependency-injected on a `pull` leg.

- **Source leg** `server/hls-source.mjs` (`hlsPull`): spawns ffmpeg (LL-HLS → VP8/Opus → localhost RTP), binds a
  `dgram` socket per track, and feeds each datagram (parsed to a werift `RtpPacket`) onto a synthetic werift
  `MediaStreamTrack`. Werift-free by design — the track factory + RTP parser are injected (index.mjs supplies
  the real werift-backed ones), so it unit-tests with no werift install.
- **WHIP-out leg** [`@wave-av/whip-publish`](../../../.ess-clones/wave-foundation/packages/whip-publish) v0.2.0
  `publish({ source: { tracks } })` — relay source mode (#758), `pc.addTrack()` verbatim.

`server/index.mjs` owns the sole `werift` import: it wires the `pcFactory` + binds the werift primitives into
the source leg.

## Status

**ARMED (#48 go-live, Jake-named 2026-06-27); source leg corrected to LL-HLS (#35/#211, this change).** The
`[[containers]] StreamBridgeContainer` binding in `wrangler.toml` is live; `STREAM_BRIDGE_ENABLED="1"`; the
bridge `wk_` key (`WHIP_KEY`) + CF Stream webhook secret are provisioned. The live LL-HLS→WHIP **RTP
forwarding** receipt (§7.6: real RTMPS push → LL-HLS → an SFU track id — a bare WHIP 201 is not proof) is the
remaining proof, and the image must be **rebuilt WITH ffmpeg** (below) before it can run.

## Rebuilding the image

The `image` in `wrangler.toml` is a **pre-pushed CF-managed-registry ref**, NOT the local Dockerfile path —
`wrangler deploy`/`wrangler containers build` cannot pass the BuildKit secret this image needs for the
org-internal `@wave-av/whip-publish` (GitHub Packages), and this repo is PUBLIC so the private dep must never
be vendored in-tree. The Dockerfile now `apt-get install`s ffmpeg. Build ONCE locally and push; deploy just
references the ref (no build, no token in CI):

```sh
# from repo root, with Docker running + a gh token that has read:packages on the wave-av org
TAG="wave-stream-bridge:v5-$(git rev-parse --short HEAD)"
# NOTE: containers/stream-bridge/.npmrc pins min-release-age=7 (supply-chain guard). If the pinned
# @wave-av/whip-publish version is <7d old, relax that line in the WORKING COPY for this build only
# (restore with `git checkout` before committing — the committed guard must stay intact).
GITHUB_TOKEN="$(gh auth token)" docker buildx build \
  --secret id=github_token,env=GITHUB_TOKEN --platform linux/amd64 \
  -t "$TAG" --load containers/stream-bridge
doppler run --project wave --config prd -- wrangler containers push "$TAG"   # → prints registry.cloudflare.com/<acct>/...
# then update [[containers]] image in wrangler.toml to the printed ref and deploy.
```

## Test

```
npx vitest run --config containers/stream-bridge/vitest.config.mjs
```
