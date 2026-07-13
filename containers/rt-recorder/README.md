# rt-recorder — self-host raw-SFU track recorder (#151 / #145-video D)

Pulls a **published CF Realtime SFU track over WebRTC** (werift, recvonly) and records it to a WebM/Matroska
container, then streams that container into the recording **sink** (the DO's canonical R2 object, a local file,
or both). This is the **video leg** the CF WS jpeg-adapter could not deliver (that path is CF-blocked and ~1fps
— see #147/#148/#149). This path is **PROVEN full-motion + decode-clean** (#152).

## Why a separate module (not the rt-encoder container)

`rt-encoder` is a **stateless per-frame transcode sidecar** (`POST /encode`: one frame in, one frame out; no
state, no creds, no R2). This recorder is the **opposite shape**: a *stateful, long-lived* WebRTC subscription
that owns a live PeerConnection + MediaRecorder and produces a whole container. werift needs a **Node runtime**
(`node:dgram`/`node:dtls`), so it can **never** run in the Cloudflare Worker isolate — it is the self-host
recorder (#72 Path B). Keeping it separate preserves rt-encoder's stateless invariant.

## Architecture

```
browser/WHIP publisher ──RTP──▶ CF Realtime SFU ──RTP──▶ werift recvonly PC (this module)
                                                              │
                                        RRP + PLI-on-join ────┘
                                                              ▼
                                             werift MediaRecorder (jitter+depack+mux)
                                                              ▼
                                                   /tmp/<session>.webm  (whole container)
                                                              ▼
                                        streamFileToSink → RecordingSink.write(part)*  → finalize()
                                                              ▼
                                        R2 canonical object  ${org}/realtime-recordings/${sessionId}/…
                                        (single-writer / SKIP invariant owned by the sink)
```

The Worker (RoomDO) **orchestrates** — it hands this process the SFU descriptor (`appId`, `appSecret`,
`publisherSessionId`, `trackName`, negotiated `codec`) via the #135 negotiation seam. The recorder produces the
bytes; the **sink** (same contract as `src/encoders/recording-sink.ts`) owns the canonical write.

## Files

| file | role | tested |
|---|---|---|
| `server/codec-select.mjs` | PURE codec routing (`routeCodec`, `codecFromPayloadType`) | ✅ unit |
| `server/sfu-rest.mjs` | PURE SFU REST client (3-call subscribe handshake; fake-fetch injectable) | ✅ unit |
| `server/sfu-track-recorder.mjs` | werift subscribe + PLI + MediaRecorder → WebM (Node-only) | harness-proven (#152) |
| `server/record-to-sink.mjs` | driver: record → stream file → sink; `streamFileToSink` | ✅ unit |

`npx vitest run --config containers/rt-recorder/vitest.config.mjs`

## Codec matrix (#153)

| codec | path | note |
|---|---|---|
| VP8 / VP9 / H264 | **werift MediaRecorder** | PROVEN 30fps, lossPct:0, decode-clean (#152) |
| Opus (audio) | **werift MediaRecorder** | proven live (#145 audio leg) |
| **AV1** | **native-transcode** | werift 0.23.0 MediaRecorder **HANGS** on browser AV1 RTP → native ffmpeg/GPU (#83/#88) |
| **H265/HEVC** | **native-transcode** | not in werift depacketizer table (no browser H265 WebRTC) → native-record or normalize |

`routeCodec()` returns `native-transcode` for AV1/H265 and `subscribeAndRecord` **returns early without touching
werift** — an honest degrade, never a hang or a silent wrong-codec mux.

## Two fixes that mattered (banked)

1. **PLI keyframe request** — on a mid-GOP join there is no keyframe → inter-frames undecodable. Capture the
   SSRC from the first RTP and pump `receiver.sendRtcpPLI(ssrc)` until a frame lands.
2. **Use werift's MediaRecorder** (not a hand-rolled depacketizer) — its jitter buffer handles reorder.
   `onTrack` fires twice (codec-less placeholder, then the real negotiated track); add the **codec-bearing** one.

## Running it

One track per process (12-factor). Two sink modes, chosen by env:

```bash
# Hosted (production): stream to the Worker recording-ingest route → RoomDO writes the canonical R2 object.
# INGEST_ENDPOINT is PRE-SIGNED (?t=<recorder-token>) by the orchestrator; this process holds no secret.
ORG=acme SESSION_ID=<sfuSession> APP_ID=<hex> APP_SECRET=<secret> \
  PUBLISHER_SESSION=<pubSession> TRACK=<trackName> CODEC=VP8 RUN_MS=15000 \
  INGEST_ENDPOINT="https://rt.wave.online/v1/realtime/recording-ingest/acme/<room>/<sfuSession>/<track>?t=<tok>" \
  node server/run.mjs

# Local (dev/on-prem): write a self-contained WebM to RECORDER_LOCAL_DIR.
ORG=acme SESSION_ID=s APP_ID=… APP_SECRET=… PUBLISHER_SESSION=… TRACK=… RECORDER_LOCAL_DIR=/tmp node server/run.mjs
```

## Go-live gate (remaining)

Server code is COMPLETE + tested + pushed; the ingest route is ARMED on canary (`RECORDER_INGEST_ENABLED=1`,
reusing the canary's existing `WAVE_INTERNAL_SECRET` — **no new secret needed**; #141 is a separate RTMS gap).
Remaining:
1. Deploy the canary worker (`gh workflow run deploy.yml -f environment=canary`) so the armed route is live.
2. Build the werift image (`docker build`) on a self-host node (the Studio) and `npm install` werift.
3. **First receipt (manual):** a live WHIP publish → run `server/run.mjs` with a RoomDO-minted pre-signed
   `INGEST_ENDPOINT` → ffprobe the landed R2 object. Closes **#145-video + #91**.
4. **Productionize (follow-up):** RoomDO auto-dispatch — on WHIP publish, mint the token + dispatch one
   recorder process per track with the descriptor (today `run.mjs` takes it from env / a manual run).
