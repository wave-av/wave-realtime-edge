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
FROM node:26-bookworm-slim

# ffmpeg from the bookworm repo (has libvpx + libopus encoders the source leg needs). Clean the apt lists to
# keep the layer small. Installed as root before the USER drop below.
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg \
    && rm -rf /var/lib/apt/lists/*

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
