# rt-encoder — PORTABLE raw-SFU encode container (#72 / RT-R10)

ONE image, TWO runtimes. A stateless pure-transcode sidecar that turns the SFU's decoded frames into the
codecs the WebM muxer wants (JPEG→VP8, PCM→Opus). The same image runs on **Cloudflare Containers (Path A)**
and **self-host (Path B, `docker run` on the Studio or a customer on-prem box)**. The runtime is chosen on
the Worker side via `RECORDER_TARGET` (`cf` | `selfhost` | `none`), NOT by the image.

State: **INERT.** The inert PR (#72) does NOT build this image and does NOT add a live `[[containers]]`
binding — the block in `wrangler.toml` stays **commented**. Building + smoke-testing the image on the Studio
is buildable-now (not a crossing); attaching it (A) or running it live (B) is a Jake-named ◆.

## The `/encode` contract (same for A and B)

```
POST /encode
  headers: x-kind: video|audio   x-ts: <ms>   x-codec: jpeg|pcm   (source codec)
  body:    raw bytes — a full JPEG frame (video) OR 16-bit-LE PCM @48kHz stereo (audio)
  → 200 application/octet-stream: VP8 (in IVF) for jpeg, Opus (in Ogg) for pcm
GET /health → 200 "ok"
```

Pure transcode: the container holds no R2, no state, no creds. The Durable Object owns the one canonical
recording object (single-writer / A-DO invariant); the container only encodes bytes and hands them back.

## Build + smoke (buildable-now, NOT a crossing)

The Studio (tailscale `studio`) runs Docker; build from the laptop against its daemon:

```bash
# from the worktree root
DOCKER_HOST=ssh://studio docker build -t wave-rt-encoder:smoke containers/rt-encoder
# smoke: run the server, POST a synthetic JPEG, assert VP8/IVF ("DKIF") magic out
DOCKER_HOST=ssh://studio docker run -d --rm -p 8080:8080 --name rt-enc-smoke wave-rt-encoder:smoke
curl -s --data-binary @frame.jpg -H 'x-codec: jpeg' -H 'x-kind: video' -H 'x-ts: 0' \
  http://studio:8080/encode | head -c4 | xxd   # expect 44 4b 49 46  ("DKIF" = IVF header)
DOCKER_HOST=ssh://studio docker rm -f rt-enc-smoke
```

## Path A — Cloudflare Containers (◆)

1. Build + push the image (or let wrangler build from this Dockerfile at deploy).
2. UNCOMMENT the `[[containers]]` + `[[durable_objects.bindings]] RECORDER` blocks in `wrangler.toml`
   (and add `RecorderContainer` to a `[[migrations]]` `new_sqlite_classes`).
3. `wrangler deploy`. CF Containers are NOT internet-addressable — the SFU still dials the **Worker**
   (`wss://rt.wave.online/v1/realtime/recorder/…`); the Worker hands JPEG frames to the container for VP8
   via `getContainer(env.RECORDER, id).fetch('/encode')` (CfContainerTarget) and muxes the result.
4. Set `RECORDER_TARGET=cf` (the ◆ flip; default stays `none`).

## Path B — self-host (◆)

1. Build + run the image as a long-lived service on the Studio / NAS / customer box:
   `docker run -d -p 8080:8080 wave-rt-encoder:<tag>`.
2. Point the Worker at it: `RECORDER_SELFHOST_URL=https://<host>:8080` + `RECORDER_TARGET=selfhost`.
   Reach it over tailscale or a customer-private network. Cheaper for steady load; no CF Containers dep.
3. Optionally set `RECORDER_SINK=fanout` + `RECORDER_LOCAL_DIR=/recordings` so the on-prem install keeps a
   local copy AND the cloud R2 copy (LocalFsSink + R2Sink → FanoutSink).

## The 4 deferred ◆ crossings (none in this PR)

A: build+push image + uncomment `[[containers]]` + deploy. B: run the image as a live self-host service +
point `RECORDER_SELFHOST_URL` at it. C: live WS spike vs the billed CF-Calls app `wispy-feather-fa96`.
D: flip live `RT_ENCODER` `managed`→`container` + `RECORDER_TARGET` `none`→`cf`|`selfhost`.

Until then: `RT_ENCODER` stays `managed`, `RECORDER_TARGET` defaults `none`, `RECORDER_SINK` defaults `r2`,
and the `[[containers]]` block stays commented — prod is untouched.

## AV1_DEFAULT (#83/#75) — master-encode profile, INERT default-off

`AV1_DEFAULT` (container env var; absent/`"0"`/`"false"` = OFF) makes the DEFAULT master-encode profile
(no explicit `x-target-codec`) default to **AV1** for the eligible VIDEO frame source (jpeg), mirroring the
#83 `selectEncodeProfile` rules (wave-converted / non-remux / encoder-supported; sacred originals keep their
codec; AV1 always implies a transcode, never an `is_derivable` passthrough). The Worker's `/encode` raw
frames are wave-converted + non-remux + non-sacred by construction.

- OFF (default): byte-identical to today — jpeg→VP8, pcm→Opus.
- ON + host has an AV1 encoder: jpeg defaults to AV1.
- ON + host has NO AV1 encoder: VISIBLE H.264 fallback (`x-av1-fallback-reason` response header), never a
  silent substitution; if neither AV1 nor H.264 is encodable, the proven VP8 default is kept.
- Audio (pcm) is never AV1-defaulted (AV1 is a video codec). An explicit `x-target-codec` still wins.

Arming `AV1_DEFAULT="1"` on a live rt-encoder container is a Jake-named ◆ crossing.
