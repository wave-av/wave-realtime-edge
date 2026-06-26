# stream-bridge — #91 B2 whep-to-whip republisher. ONE image, TWO runtimes (mirrors rt-encoder):
#   • Path A — Cloudflare Containers (cloud, fronted by the Worker via getContainer().fetch('/start'|'/stop')).
#   • Path B — self-host (`docker run` on Studio / on-prem behind a CF-Tunnel for the gateway-reachable WHIP-out).
# Same image, same control contract; the runtime is chosen Worker-side (the [[containers]] binding), not here.
#
# NO ffmpeg: this is a PASSTHROUGH relay (no transcode, contract §9.4) — it pipes received RTP straight onto
# the WHIP-out sender. Node 22 + werift (Node WebRTC) is the whole runtime. Lightweight by design.
#
# INERT: this image is NOT built or attached by the inert B2 PR. The [[containers]] StreamBridgeContainer block
# in wrangler.toml stays COMMENTED; building (Path A) or running (Path B) is a Jake-named ◆ go-live crossing.
FROM node:22-bookworm-slim

WORKDIR /app

# Install deps first (layer cache). @wave-av/whip-publish lives on GitHub Packages (org-scoped/internal), so
# the .npmrc points the @wave-av scope there and reads ${GITHUB_TOKEN}. The token is a BUILD SECRET — mounted,
# never baked into a layer or committed:  docker build --secret id=github_token,env=GITHUB_TOKEN .
COPY package.json .npmrc ./
RUN --mount=type=secret,id=github_token \
    GITHUB_TOKEN="$(cat /run/secrets/github_token)" npm install --no-audit --no-fund --omit=dev

COPY server ./server

ENV PORT=8080
EXPOSE 8080

# Container-side healthcheck hits the control server's /health (text only; no media).
HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server/index.mjs"]
