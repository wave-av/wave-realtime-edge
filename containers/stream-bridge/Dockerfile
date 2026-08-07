# stream-bridge — #91 B2 whep-to-whip republisher. ONE image, TWO runtimes (mirrors rt-encoder):
#   • Path A — Cloudflare Containers (cloud, fronted by the Worker via getContainer().fetch('/start'|'/stop')).
#   • Path B — self-host (`docker run` on Studio / on-prem behind a CF-Tunnel for the gateway-reachable WHIP-out).
# Same image, same control contract; the runtime is chosen Worker-side (the [[containers]] binding), not here.
#
# ffmpeg: the source leg is LL-HLS, not WHEP (#211 — CF `/webRTC/play` serves only WHIP-ingested inputs, 409 for
# RTMP/SRT). ffmpeg decodes the HLS ladder → VP8/Opus → localhost RTP, which werift ingests and republishes on the
# WHIP-out leg VERBATIM (no second transcode, §9.4). ffmpeg is this image's only system dep beyond Node+werift.
#
# INERT: this image is NOT built or attached by the inert PR. The [[containers]] StreamBridgeContainer block in
# wrangler.toml stays COMMENTED; building (Path A) or running (Path B) is a Jake-named ◆ go-live crossing.
#
# --- FFmpeg build: FFMPEG9-LEI E7-P3 — proposal, source-pin per E2-P1-POLICY §1 channel 1 (source-tag@canonical) ---
#
# WHY 9.0 instead of the bookworm apt package this image used to install: the FFmpeg9-LEI stall verdict
# (wave-conformance receipts/ffmpeg9-stall-2026-08-05-VERDICT.md, H3) confirmed FFmpeg 9.0's `-readrate` rework
# (pace on the SLOWEST live stream, not the first-to-finish) eliminates the sparse-subtitle stall this leg's own
# `-re` flag (server/hls-source.mjs:69) is exposed to: 4 stall events/run on 8.1.1-class vs 0/run on 9.0, N=3x2,
# reproduced twice. R23 (governance/plans/ffmpeg9-lei/RECEIPTS.md) names THIS file (hls-source.mjs:73 `-c:v libvpx`,
# :81 `-c:a libopus`) the ONE live `-readrate` beneficiary mapped in the E7 streaming-wins sweep — every other 9.0
# streaming win in that sweep was parked, unmapped to a site this repo runs. The bookworm apt package this Dockerfile
# used to install floats on whatever the base image resolves (channel-watch: bookworm apt ships FFmpeg 5.1.9 —
# THREE majors behind), which is also out of E2-P1-POLICY's four allowed pin channels (apt is only channel-3-
# compliant if the resolved version is recorded in the same commit as the install line — this image never did that).
#
# WHY bookworm, NOT trixie (unlike the proven wave-bridge-edge feat/ffmpeg9-canary recipe this build mirrors):
# that recipe's builder is `debian:trixie-slim` because it also builds AV2/AVM + Vulkan video, and FFmpeg 9.0's
# Vulkan video path needs Vulkan headers >=1.3.277 + build-time SPIR-V compilation that bookworm's package set
# doesn't carry. THIS site needs NEITHER: stream-bridge decodes an HLS ladder (H.264/HEVC/AAC — all via ffmpeg's
# OWN native decoders, no external lib) and re-encodes to VP8 (libvpx) + Opus (libopus) only — no AV1/AV2, no
# Vulkan. Passing `--disable-vulkan` (the default — 9.0 does not force Vulkan on unless asked) means this build
# never crosses the trixie forcing function at all: bookworm + nasm + no-vulkan builds 9.0 cleanly, and the
# runtime stage stays `node:22-bookworm-slim` (as it already was) with NO glibc-drift risk between builder and
# runtime stages, because both are bookworm. Minimal blast radius, per the task's stated preference.
FROM debian:bookworm-slim AS ffmpeg-builder

RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential nasm pkg-config \
    git ca-certificates \
    libvpx-dev libopus-dev \
    libssl-dev zlib1g-dev \
    && rm -rf /var/lib/apt/lists/*

# Canonical remote per E2-P1-POLICY §1 channel 1 (git.ffmpeg.org, not the github.com/FFmpeg mirror), fixed tag
# (not a branch) n9.0 — the exact release this epic adopts ("Lei", 2026-08-04).
#
# Integrity: a tag is a MUTABLE ref (upstream can re-point it), so the clone is verified against the commit SHA
# the tag resolved to when this pin was adopted (recorded 2026-08-05 via
# `git ls-remote https://git.ffmpeg.org/ffmpeg.git 'n9.0^{}'`). If the tag ever moves, the build fails hard
# instead of silently shipping a different tree.
#
# Deliberately ENV (builder-stage-local, discarded with the stage), NOT ARG: an ARG could be silently
# overridden per-build (`--build-arg FFMPEG_COMMIT=...`), turning the guard into a no-op. Bumping the pin
# is a reviewed Dockerfile edit, never a build flag.
ENV FFMPEG_VERSION=n9.0 \
    FFMPEG_COMMIT=d32b387f2b0a484599d4587d651891f0c63c4238
RUN git clone --depth=1 --branch=${FFMPEG_VERSION} https://git.ffmpeg.org/ffmpeg.git /build/ffmpeg \
    && cd /build/ffmpeg \
    && actual="$(git rev-parse 'HEAD^{commit}')" \
    && if [ "${actual}" != "${FFMPEG_COMMIT}" ]; then \
         echo "FATAL: tag ${FFMPEG_VERSION} resolved to ${actual}, expected ${FFMPEG_COMMIT} — upstream tag moved?" >&2; \
         exit 1; \
       fi

# Configure kept to the codec lineup this site's ffmpeg invocation actually uses (server/hls-source.mjs):
#   --enable-libvpx   — encoder for VP8 output          (hls-source.mjs:73 `-c:v libvpx`)
#   --enable-libopus  — encoder for Opus output          (hls-source.mjs:81 `-c:a libopus`)
#   --enable-openssl  — TLS for the https LL-HLS manifest fetch (`-i <llhls manifest>`, hls-source.mjs comment ~L13)
# H.264/HEVC/AAC DECODE (the HLS ladder's input codecs) need no --enable-lib* flags at all: ffmpeg ships its own
# native decoders for all three built directly into libavcodec — only the ENCODER wrappers for H.264/HEVC
# (libx264/libx265, GPL) would need extra flags, and this leg never encodes to either, so they're deliberately
# left out (smaller image, no GPL license surface). No AV1/AV2/Vulkan/VVC — none of those appear in this leg's
# argv, so none of those flags are enabled (mirrors the "keep the configure minimal" instruction: every flag
# here is traceable to a hls-source.mjs invocation, not a "might as well" addition).
RUN cd /build/ffmpeg \
    && ./configure \
        --prefix=/usr/local \
        --disable-doc \
        --disable-vulkan \
        --enable-libvpx \
        --enable-libopus \
        --enable-openssl \
        --extra-cflags="-I/usr/local/include" \
        --extra-ldflags="-L/usr/local/lib" \
    && make -j$(nproc) && make install

FROM node:26-bookworm-slim

# Runtime shared libs matching the builder's --enable-lib* set + TLS/CA — no ffmpeg-dev/build toolchain here.
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    libvpx7 libopus0 \
    libssl3 \
    && rm -rf /var/lib/apt/lists/*

# Only the binaries cross the stage seam: the configure above has no --enable-shared (FFmpeg's default is
# static-only), so libav* are linked INTO ffmpeg/ffprobe and the builder's /usr/local/lib holds only .a
# archives + headers + pkgconfig — hundreds of MB of dead weight at runtime. The binaries' shared deps
# (libvpx/libopus/libssl) come from the apt install above.
COPY --from=ffmpeg-builder /usr/local/bin/ffmpeg /usr/local/bin/ffprobe /usr/local/bin/

WORKDIR /app

# Install deps first (layer cache). @wave-av/whip-publish lives on GitHub Packages (org-scoped/internal), so
# the .npmrc points the @wave-av scope there and reads ${GITHUB_TOKEN}. The token is a BUILD SECRET — mounted,
# never baked into a layer or committed:  docker build --secret id=github_token,env=GITHUB_TOKEN .
COPY package.json .npmrc ./
RUN --mount=type=secret,id=github_token \
    GITHUB_TOKEN="$(cat /run/secrets/github_token)" npm install --no-audit --no-fund --omit=dev

COPY server ./server

# Drop privileges: run as the non-root `node` user (uid 1000, built into the node image). /app + node_modules
# were installed as root and are world-readable; the runtime only READS them. An attacker who controls the
# process never has root in the container.
USER node

ENV PORT=8080
EXPOSE 8080

# Container-side healthcheck hits the control server's /health (text only; no media).
HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server/index.mjs"]
