# rt-encoder — PORTABLE raw-SFU encode container (#72 / RT-R10). ONE image, TWO runtimes:
#   • Path A — Cloudflare Containers (cloud, fronted by the Worker via getContainer()).
#   • Path B — self-host (`docker run` on the Studio / a customer on-prem box).
# Same image, same `POST /encode` contract; the runtime is chosen by env on the Worker side
# (RECORDER_TARGET=cf|selfhost), not by the image. The image is a STATELESS pure transcode sidecar:
# it holds no R2, no state, no creds — the DO owns the canonical object (single-writer / A-DO invariant).
#
# LIGHTWEIGHT BY DESIGN: we need only VP8 (video) + Opus (audio), which Debian's prebuilt ffmpeg ships
# (libvpx + libopus). So we apt-install ffmpeg rather than source-compiling it (~2min build vs ~40min).
# Bridge-edge's containers/ffmpeg source-build is for bleeding-edge AV1/AV2 — the recorder does NOT need that.
#
# INERT: this image is NOT built or attached by the inert PR (#72). The [[containers]] block in
# wrangler.toml stays COMMENTED; attaching it (Path A) or running it (Path B) is a Jake-named ◆ crossing.
FROM debian:bookworm-slim

# Prebuilt ffmpeg brings libvpx (VP8) + libopus (Opus); node 22 runs the tiny HTTP transcode service.
# ca-certificates + curl are for the image's own healthcheck and TLS roots.
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
       ffmpeg ca-certificates curl gnupg \
  && curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
  && apt-get install -y --no-install-recommends nodejs \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY server/ ./server/

# defaultPort 8080 — matches RecorderContainer.defaultPort (worker.ts) and SelfHostTarget's URL.
ENV PORT=8080
EXPOSE 8080/tcp

# Pure transcode service: POST /encode (raw JPEG|PCM in → VP8|Opus out), GET /health. No state, no R2.
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD curl -fsS http://127.0.0.1:8080/health || exit 1

ENTRYPOINT ["node", "server/index.mjs"]
