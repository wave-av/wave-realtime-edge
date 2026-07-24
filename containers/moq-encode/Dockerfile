# wave-moq-encode container — per-participant MoQ encode+publish (#314).
#
# Takes the Worker's ONE multiplexed WebSocket per meeting (demux.mjs decodes each frame per the frozen
# wire contract, PR #319), fans each participant's audio/video out to its own ffmpeg encode, and publishes
# each onto its own MoQ track via the proven moq-strand.mjs (vendored verbatim from containers/moq/).
#
# Debian bookworm's stock ffmpeg package already ships libopus (audio) + libvpx (VP8 video) encode support
# — no custom --enable-libopus/--enable-libvpx build needed here (unlike containers/srt/egress's
# --enable-libsrt build, which packages don't cover). Mirrors containers/moq/Dockerfile (pure-Node control
# plane + vendored strand) and containers/srt/egress/Dockerfile (apt-installed media tool, non-root runtime,
# EXPOSE 8080, ENTRYPOINT node server.mjs) for idioms.
FROM node:24-bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY server.mjs demux.mjs participant.mjs session.mjs ivf.mjs rtp.mjs moq-strand.mjs package.json package-lock.json ./
RUN npm ci --omit=dev

# Encode control plane (Worker reaches this via the CF Container binding, GET /publish/:meetingUuid
# upgraded to a WebSocket carrying the multiplexed frame stream). Outbound-only beyond that: each
# participant's moq-strand.mjs pub child dials OUT to the MoQ relay; nothing here accepts public UDP.
EXPOSE 8080/tcp
ENV PORT=8080

# Drop privileges: run as the built-in non-root `node` user (uid 1000). 8080 is non-privileged, and every
# child ffmpeg/moq-strand process this server spawns inherits this user — root is never needed.
USER node
ENTRYPOINT ["node", "server.mjs"]
