# rt-encoder — PORTABLE raw-SFU encode container (#72 / RT-R10). ONE image, TWO runtimes:
#   • Path A — Cloudflare Containers (cloud, fronted by the Worker via getContainer()).
#   • Path B — self-host (`docker run` on the Studio / a customer on-prem box).
# Same image, same `POST /encode` contract; the runtime is chosen by env on the Worker side
# (RECORDER_TARGET=cf|selfhost), not by the image. The image is a STATELESS pure transcode sidecar:
# it holds no R2, no state, no creds — the DO owns the canonical object (single-writer / A-DO invariant).
#
# LIGHTWEIGHT BY DESIGN: we need only VP8 (video) + Opus (audio) for the DEFAULT path, which Debian's
# prebuilt ffmpeg ships (libvpx + libopus). So we apt-install ffmpeg rather than source-compiling it
# (~2min build vs ~40min). Bridge-edge's containers/ffmpeg source-build is for bleeding-edge AV1/AV2.
#
# CODEC-MATRIX NOTE (server/codecs.mjs registry — ADR adr-codec-matrix.md): the registry lists the FULL
# codec set, but capability.mjs probes what THIS ffmpeg actually has and selection honest-fails on the
# rest — so unlisted codecs simply report unavailable, they never silently substitute. Debian bookworm's
# `ffmpeg` package covers the SOFTWARE matrix the cloud (Path A, GPU-less) needs: libvpx, libvpx-vp9,
# libsvtav1/libaom-av1, libx264, libx265, libopus, native aac, libmp3lame, flac, libvorbis, pcm_*.
# NOT in the stock package (would need a source build with these configure flags) — left as a DESIGN note,
# NOT silently assumed present:
#   • libfdk_aac   → --enable-libfdk-aac --enable-nonfree   (non-free; native `aac` is the portable default)
#   • prores_ks    → present in recent ffmpeg; verify per base image (prores_videotoolbox is HW-only/Path B)
#   • HARDWARE encoders (h264_nvenc/hevc_nvenc/av1_nvenc, *_qsv, *_vaapi, *_amf) → require the host's GPU
#     runtime + a CUDA/VAAPI/QSV-enabled ffmpeg; these are Path B (self-host on real silicon), NOT this
#     cloud image. VideoToolbox (*_videotoolbox) is macOS-only and never present in a Linux container.
# When the on-prem app (#74) ships a hardware image, build ffmpeg with the matching --enable-* flags;
# until then the registry+probe correctly degrade to the software set available here.
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
