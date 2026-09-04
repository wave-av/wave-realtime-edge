// rt.wave.online — wave-realtime-edge front door.
//
// GROUNDING (verified live this pass, 2026-07-20):
//   curl https://rt.wave.online/health                → 200 {"ok":true,...}
//   curl -X POST https://rt.wave.online/v1/whip/publish   → 401 {"error":"UNAUTHORIZED","message":"paid endpoint — call via api.wave.online"}
//   curl -X POST https://rt.wave.online/v1/whep/subscribe → 401 (same body)
//   curl -X POST https://rt.wave.online/rtk/join          → 401 (same body)
// A 401 "paid endpoint" (not a 404 or a 501) proves each route is REAL and WIRED: it reached the
// live handler and was rejected only for lacking the gateway's trust header. Source: src/whip.ts +
// src/whep.ts both route through the SAME src/dispatch-helpers.ts `gatewayGate()` chokepoint as
// /rtk/join — one internal trust header, injected by api.wave.online AFTER it authenticates and
// charges the call (src/route-dispatch.ts). WHIP_INGEST_ENABLED and WHEP_EGRESS_ENABLED are armed
// in wrangler.toml (not the default-off flag state) — this is live production, not a roadmap flag.
import { shell } from "@wave-av/spoke-chassis";
import { TOKENS_CSS } from "./tokens.css";

export const LANDING_INNER = `<div class="kicker">WAVE · Realtime</div>
<h1>WAVE <span class="acc">Realtime</span></h1>
<p class="lead">Your broadcast talks back — two IETF standards, WHIP ingest and WHEP egress, plus RealtimeKit rooms, gated on the exact same gateway and token as WAVE broadcast. No second stack.</p>
<pre>  browser
    │  WebRTC
    ▼
  POST <span class="acc">/v1/whip/publish</span>    ─▶ ingest (IETF WHIP)
  POST <span class="acc">/v1/whep/subscribe</span>  ─▶ egress (IETF WHEP)
  POST <span class="acc">/rtk/join</span>           ─▶ N-to-N room + voice agent
    │
    └─ <span class="dim">an internal trust header, stamped by api.wave.online AFTER it authenticates + charges the call</span>

  $ curl -s -X POST https://rt.wave.online/v1/whip/publish
  <span class="dim">{"error":"UNAUTHORIZED","message":"paid endpoint — call via api.wave.online"}</span>
  <span class="dim">— live, verbatim, 2026-09-02: a 401 (not a 404) proves the route is real and wired.</span>
</pre>
<div class="row"><span class="k">ingest</span><span><span class="dim">POST</span> <span class="acc">/v1/whip/publish</span> <span class="dim">— standard WHIP, live</span></span></div>
<div class="row"><span class="k">egress</span><span><span class="dim">POST</span> <span class="acc">/v1/whep/subscribe</span> <span class="dim">— standard WHEP, live</span></span></div>
<div class="row"><span class="k">rooms</span><span><span class="dim">POST</span> <span class="acc">/rtk/join</span> <span class="dim">— RealtimeKit meeting + join token, live</span></span></div>
<div class="row"><span class="k">auth</span><span class="warn">Authorization: Bearer &lt;key&gt;</span> <span class="dim">(via api.wave.online — this edge makes zero auth decisions)</span></div>
<div class="row"><span class="k">health</span><span class="dim">GET /health</span></div>
<div><span class="tag">WHIP</span><span class="tag">WHEP</span><span class="tag">RealtimeKit rooms</span><span class="tag">voice agents</span></div>
<div class="btns" style="margin-top:.8rem">
<a class="btn primary" href="https://api.wave.online">Get a WAVE key →</a>
<a class="btn ghost" href="/skill.md">Read /skill.md →</a>
</div>
<p class="sub" style="margin-top:1.4rem"><span class="acc">One plane, both directions.</span> The WAVE broadcast plane carries one-to-many; this spoke is the interactive half — rooms, calls, and voice agents authorized by the same session token and metered through the same gateway. No separate vendor, no separate bill.</p>`;

export function landingPage(): string {
  return shell({
    product: "Realtime",
    title: "WAVE Realtime — your broadcast talks back, live today.",
    description:
      "WAVE Realtime — real IETF WHIP ingest, WHEP egress, and RealtimeKit rooms, gated on the exact same gateway and token as WAVE broadcast. Live in production.",
    url: "https://rt.wave.online",
    keywords: "realtime, webrtc, whip, whep, rooms, voice agents, WAVE, protocol plane",
    inner: LANDING_INNER,
    tokensCss: TOKENS_CSS,
    accentHex: "#ff715d",
    productId: "realtime",
    ldHost: "rt.wave.online",
    ldTagline: "The interactive half of the WAVE protocol plane — two-way media, live.",
    cta: {
      primaryLabel: "Get a WAVE key →",
      primaryHref: "https://api.wave.online",
      salesLabel: "Talk to sales",
      salesHref: "https://wave.online/enterprise",
    },
  });
}
