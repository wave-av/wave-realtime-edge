// realtime.wave.online — WAVE Realtime front-door (claims-clean: describes the API + design; no
// uptime/latency/scale/SLA/customer claims; "early" is stated honestly).
import { shell } from "@wave-av/spoke-chassis";
import { TOKENS_CSS } from "./tokens.css";

export const LANDING_INNER = `<h1>wave <span class="acc">Realtime</span></h1>
<p class="sub">The live control &amp; event plane for WAVE. Presence, pub/sub, and a streaming-event bus — over one WebSocket, federated through api.wave.online.</p>
<div><span class="tag">presence</span><span class="tag">pub/sub</span><span class="tag">events</span><span class="tag">durable objects</span><span class="tag">edge</span></div>

<pre>  one socket, one channel
    │
    ▼   <span class="acc">realtime.wave.online/v1/connect?channel=stream:abc</span>
  ┌─ presence   who's connected  (join · leave · list)
  ├─ broadcast  chat · reactions · cues · control
  └─ events     <span class="dim">transcription.partial · sentiment.tick · clip.created · stream.*</span>
    │
    └─ <span class="dim">auth + metering federate through api.wave.online</span>
</pre>

<p class="sub">Media moves over the WAVE transports (MoQ/NDI/Dante/SRT/OMT). <span class="acc">Realtime moves the session</span> — the state and events around that media. It's the bus the streaming-AI products push into, so an agent or a UI subscribes once and gets live intelligence with no polling.</p>

<div class="row"><span class="k">subscribe</span><span><span class="dim">WS</span> <span class="acc">GET /v1/connect?channel=&lt;id&gt;</span> <span class="dim">→ welcome · presence · live frames</span></span></div>
<div class="row"><span class="k">publish</span><span><span class="dim">POST</span> <span class="acc">/v1/channels/:id/publish</span> <span class="dim">{"event","data"}</span></span></div>
<div class="row"><span class="k">presence</span><span><span class="dim">GET</span> <span class="acc">/v1/channels/:id/presence</span></span></div>
<div class="row"><span class="k">history</span><span><span class="dim">GET</span> <span class="acc">/v1/channels/:id/history?limit=N</span> <span class="dim">(last 50)</span></span></div>
<div class="row"><span class="k">auth</span><span class="warn">Authorization: Bearer &lt;key&gt;</span> <span class="dim">(via gateway)</span></div>

<pre>  # subscribe (any WebSocket client)
  wscat -c "wss://realtime.wave.online/v1/connect?channel=stream:abc" \\
        -H "Authorization: Bearer $WAVE_API_KEY"

  # a producer pushes a live event into the same channel
  curl -X POST https://realtime.wave.online/v1/channels/stream:abc/publish \\
       -H "Authorization: Bearer $WAVE_API_KEY" \\
       -d '{"event":"caption.cue","data":{"text":"…and we are live"}}'
</pre>

<div class="row" style="margin-top:.8rem"><a class="btn" href="/skill.md">Get started →</a></div>
<p class="sub" style="margin-top:1.0rem"><span class="acc">Early.</span> The v0 control/event plane (presence · pub/sub · history) runs on Cloudflare Durable Objects. Scope, entitlement, and metering federate through the gateway; per-connection x402 metering and producer wiring from the AI spokes are rolling out — track progress in the <a href="https://github.com/wave-av/wave-realtime-edge">repo</a>.</p>`;

export function landingPage(): string {
  return shell({
    product: "Realtime",
    title: "wave Realtime — the live control & event plane for WAVE",
    description:
      "WAVE Realtime — presence, pub/sub broadcast, and a streaming-event bus over one WebSocket, on Cloudflare Durable Objects, federated through api.wave.online. The live session plane around the WAVE media transports.",
    url: "https://realtime.wave.online",
    keywords: "realtime, websocket, presence, pub/sub, events, durable objects, streaming, agents, WAVE",
    inner: LANDING_INNER,
    tokensCss: TOKENS_CSS,
    accentHex: "#ff715d",
    ldHost: "realtime.wave.online",
    ldTagline: "The live control & event plane for WAVE — presence, pub/sub, and streaming events over one WebSocket.",
    cta: {
      primaryLabel: "Open a channel →",
      primaryHref: "https://docs.wave.online/realtime",
      salesLabel: "Talk to sales",
      salesHref: "https://wave.online/enterprise",
      phrases: ["Open a channel", "Track presence", "Broadcast an event", "Stream transcription", "Subscribe once"],
    },
  });
}
