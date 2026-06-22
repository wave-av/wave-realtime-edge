# rt-encoder — JPEG→VP8 video encode container (◆ INFRA SLICE — scaffold only)

State: **◆ deferred infra slice.** This directory is a scaffold. The inert PR does NOT build this image, does
NOT add a `[[containers]]` binding to `wrangler.toml`, and does NOT enable video recording. It exists so the
seam is visible and reviewable.

## Why a container at all

The raw-SFU recorder is **audio-first and needs NO container**: PCM audio is tapped over the CF Realtime WS
media-transport, muxed (WebM/Matroska, `A_PCM`) and written to R2 entirely inside the Worker isolate
(`src/encoders/container.ts` → `RawSfuTap`). Only the **JPEG→VP8 video** encode needs `libvpx`, which the
Workers isolate cannot host — so it lives in this container, behind the injectable `VideoEncoder` seam in
`src/encoders/container-adapter.ts`. With no video encoder injected, video frames are dropped and the
audio-only path is unchanged.

## Build pre-reqs (the ◆ crossing, not done here)

1. **Docker daemon** — Studio has one live (`server=29.2.1`, tailscale `studio`). The daemon sub-gate is clear.
2. **A `[[containers]]` binding** in `wrangler.toml` — ABSENT by design; adding it is the ◆ attach.
3. **A built + pushed image** for the chosen runtime.

## Runtime decision — TBD (Jake-named ◆)

- **Path A — CF Containers.** Attach this image via `[[containers]]` and a Container Durable Object. Note: CF
  Containers are NOT internet-addressable, so the SFU still dials `wss://rt.wave.online/v1/realtime/recorder/…`
  terminating at the **Worker** (hibernatable WS); the Worker hands JPEG frames to the container for VP8 encode
  and muxes the result. The container is a pure transcode sidecar; the DO owns the R2 multipart (A-DO ownership).
- **Path B — self-host on Studio / NAS.** Run the encoder as a long-lived service on Studio (or the NAS) and
  reach it over tailscale. Cheaper for steady load, no CF Containers dependency.

## The 3 deferred ◆ crossings (none in this PR)

1. **Live WS spike** vs the billed CF-Calls app `wispy-feather-fa96` — confirm the media-transport endpoint
   shape + frame schema + auth against live media.
2. **`[[containers]]` attach + image build/push** (this directory) — Path A or Path B.
3. **Flip live `RT_ENCODER` `managed` → `container`** on the deployed worker — a deploy ◆.

Until all three: `RT_ENCODER` stays `managed` in `wrangler.toml` and this whole path is dormant.
