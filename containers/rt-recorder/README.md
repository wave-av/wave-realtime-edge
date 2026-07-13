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

## Go-live gate (remaining, mostly infra)

INERT until a self-host runtime actually runs this process:
1. `npm install` the werift dep in the deployed image/host.
2. Provide a Node `RecordingSink` (R2 uploader or a writer that POSTs to the Worker recorder route) — the DO
   owns the canonical object; **do not** create a competing R2 writer.
3. Feed the SFU descriptor from the RoomDO (#135 seam) at track publish.
4. `WAVE_INTERNAL_SECRET` provisioned (#141) if the recorder route is the sink transport.
5. Live canary receipt → closes **#145-video + #91**.
