# rt-recorder (#151 / #145-video D) — self-host raw-SFU track recorder. Node-only (werift needs node:dgram/dtls),
# so this NEVER runs in the Cloudflare Worker isolate — it is the self-host recorder (#72 Path B). It PULLs a
# published SFU track over WebRTC, muxes VP8/VP9/H264/Opus into WebM/Matroska via werift's MediaRecorder, and
# streams the finalized container to the Worker recording-ingest route (the RoomDO writes the canonical R2 object).
#
# ffmpeg is included for the AV1/H265 native-transcode fallback (#153: werift MediaRecorder hangs on AV1 / has no
# H265 depacketizer → those codecs route to a native record path, not werift). VP8/VP9/H264/Opus need no ffmpeg.
#
# INERT: this image is NOT built or attached by the inert PR. Running it (Path B) is a Jake-named go-live. The
# recorder holds NO WAVE_INTERNAL_SECRET — the orchestrator hands it a PRE-SIGNED ingest endpoint (?t=…).
FROM debian:bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
       ffmpeg ca-certificates curl gnupg \
  && curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
  && apt-get install -y --no-install-recommends nodejs \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
# Install the werift dep (declared in package.json). Copy the manifest first for layer caching.
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund
COPY server/ ./server/

# ONE track per process (12-factor): the RoomDO dispatches one recorder per published track with a fresh
# descriptor + pre-signed ingest endpoint in the environment. No long-lived server, no state, no creds at rest.
ENTRYPOINT ["node", "server/run.mjs"]
