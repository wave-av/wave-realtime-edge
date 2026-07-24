# wave-moq-encode

Per-participant MoQ encode+publish container (#314). One meeting's Worker→container WebSocket carries
EVERY participant's demuxed audio/video, multiplexed frame-by-frame; this container demuxes that stream and
re-encodes+publishes each participant onto its own MoQ track (`a-<uid>` / `v-<uid>`) via the proven
`moq-strand.mjs` (vendored verbatim from `containers/moq/`).

## Routes

| Method | Path                        | Purpose                                                              |
|--------|-----------------------------|-----------------------------------------------------------------------|
| GET    | `/health`                   | `{ok:true, service:'wave-moq-encode'}`                                |
| POST   | `/start`                    | `{org, meetingUuid}`, both validated against `^[A-Za-z0-9_.-]{1,128}$`; idempotent JSON echo |
| POST   | `/stop`                     | tears down every participant this instance is tracking                |
| GET    | `/publish/:meetingUuid`     | WS upgrade; the socket carries the multiplexed frame stream           |

**Auth**: if `WAVE_INTERNAL_SECRET` is set, every request (including the WS upgrade) must carry
`x-wave-internal` string-equal to it, or the request is rejected 401 — fail-closed. The secret is never
logged. This mirrors the gateway-trust seal `moq-forward-target.ts` already attaches on the Worker side.

## Wire frame layout (frozen by merged PR #319)

The Worker's `encodeMoqFrame` (`wave-realtime-edge/src/encoders/moq-forward-target.ts`) sends ONE complete
WS binary message per frame (WS message boundary = frame boundary; no outer length wrapper at this layer):

```
[kindByte:u8 (0=audio,1=video)][uidLen:u8][uid UTF-8, <=255 bytes][ts:u32BE][payloadLen:u32BE][payload]
```

`demux.mjs`'s `decodeMoqFrame` is the byte-exact inverse of that encoder — see `demux.test.mjs`, which
builds fixtures using the SAME byte-write sequence as the real encoder and asserts `decode(encode(x)) ===
x`. `decodeMoqFrame` never throws: any malformed/truncated/over-length buffer decodes to `null` and is
dropped by `session.mjs` before it can reach a spawn.

## The audio-via-RTP / video-via-IVF asymmetry, and why

Both pipelines pipe raw media INTO ffmpeg over stdin the same way (`pipe:0`), but they pull the ENCODED
output out of ffmpeg differently:

- **Audio** (`-c:a libopus ... -f rtp rtp://127.0.0.1:<port>`): ffmpeg's RTP muxer needs a real transport
  to write packetized RTP to — `pipe:1` can't carry ffmpeg's own RTP packetization boundaries cleanly. So
  audio is muxed as RTP over a **loopback UDP socket** (`rtp.mjs`'s `listenRtp`), where each UDP datagram is
  exactly one RTP packet; stripping the fixed 12-byte RTP header recovers the raw Opus packet.
- **Video** (`-c:v libvpx ... -f ivf pipe:1`): the IVF container format is a plain byte stream with
  self-describing per-frame length prefixes, so it round-trips cleanly over a stdout pipe. `ivf.mjs`
  streams that pipe, skips the one-time 32-byte file header, then yields each `[size:u32LE][pts:u64LE]`
  framed VP8 payload — including frames split across multiple `data` events.

Every recovered Opus/VP8 unit is then framed `[u32BE len][body]` onto the corresponding `moq-strand.mjs pub
<ns> <track>` child's stdin — that four-byte length prefix is `moq-strand.mjs`'s OWN stdin contract (its
`makeFramer`/`runPublisher`), not something this container invents.

## Security posture

- `SAFE_UID` (`demux.mjs`) gates every uid BEFORE it can name a spawned process or MoQ track — an unsafe
  uid is dropped in `session.mjs`, never reaches `participant.mjs`.
- `decodeMoqFrame` returns `null` rather than throwing on any malformed input (validate-untrusted-input,
  fail-closed on the parse — a single bad frame can't crash the session).
- `x-wave-internal` is required (fail-closed) whenever `WAVE_INTERNAL_SECRET` is provisioned, on both the
  HTTP routes and the WS upgrade.

## Documented gap

The per-frame wire layout (PR #319, frozen) carries no `org` field — only `uid`/`kind`/`ts`/`payload`.
`/start` accepts `org` for the control plane, but the data-path frames themselves have no way to attribute
a frame to an org today, so every meeting namespaces under `WAVE_ORG` (env, default `'default'`) regardless
of which org's `/start` called it. Tightening this (adding an org field to the wire frame, or binding one
container instance to exactly one org) is deferred.

## Scope of this slice

Offline slices only (a/b/c/f): pure decode/parse/session unit tests with no real ffmpeg, moq-strand, or
relay involved. Live relay proof (slices d/e/g — a real ffmpeg encode through a real moq-strand publish
against the live relay) is a separate, later, named crossing.
