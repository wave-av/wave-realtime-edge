# RT-R8 rt-encoder — JPEG→VP8 video encode container (◆ INFRA SLICE, scaffold only — NOT built/attached).
#
# This image is the DEFERRED ◆ video slice of the raw-SFU recorder. Audio-first recording is hosted entirely
# in the Worker isolate (no container) — see src/encoders/container.ts. Only the JPEG→VP8 video encode needs
# libvpx, which the Workers isolate cannot host, so it lives here. The image is NOT built or attached by the
# inert PR: there is no `[[containers]]` binding in wrangler.toml (that attach is a Jake-named ◆ crossing).
#
# Pin a libvpx + ffmpeg base. ffmpeg 7.x ships libvpx (vp8) — the encode path is `jpeg → rawvideo → libvpx vp8`.
# Pinned by digest at build-◆ time; the tag here documents the intended floor. Studio Docker is live for the
# build (server=29.2.1, tailscale `studio`) when the ◆ is taken.
FROM jrottenberg/ffmpeg:7.1-ubuntu2404

# libvpx-dev is already present in the ffmpeg base; declared here so a thinner base still pulls it.
RUN apt-get update \
  && apt-get install -y --no-install-recommends libvpx-dev ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# The encoder server (Node or a small Go/Rust binary) is added at the ◆ build. It will:
#   • accept decoded JPEG frames (from the SFU WS media-transport, outputCodec:"jpeg"),
#   • encode each to a VP8 keyframe via libvpx,
#   • hand the VP8 bytes back to the Worker/DO muxer (RawSfuTap.videoEncoder seam in container-adapter.ts).
# DO NOT add an ENTRYPOINT yet — the runtime (Path A CF Containers vs Path B self-host) is undecided (README).
# COPY server/ ./server
# CMD ["node", "server/index.js"]
