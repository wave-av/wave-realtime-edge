// rt.wave.online — wave-realtime-edge front door.
//
// GROUNDING (re-verified live 2026-09-03; first verified 2026-07-20):
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
<p class="lead">Your broadcast talks back. Two IETF standards, WHIP ingest and WHEP egress, plus N-to-N rooms, gated on the same gateway and the same token as WAVE broadcast. No second stack, no second bill.</p>
<pre>  browser
    │  WebRTC
    ▼
  POST <span class="acc">/v1/whip/publish</span>    ─▶ ingest (IETF WHIP)
  POST <span class="acc">/v1/whep/subscribe</span>  ─▶ egress (IETF WHEP)
  POST <span class="acc">/rtk/join</span>           ─▶ N-to-N room + voice agent
    │
    └─ <span class="dim">an internal trust header, stamped by api.wave.online AFTER it authenticates and charges the call</span>
</pre>
<div class="row"><span class="k">ingest</span><span><span class="dim">POST</span> <span class="acc">/v1/whip/publish</span> <span class="dim">standard WHIP · live</span></span></div>
<div class="row"><span class="k">egress</span><span><span class="dim">POST</span> <span class="acc">/v1/whep/subscribe</span> <span class="dim">standard WHEP · live</span></span></div>
<div class="row"><span class="k">rooms</span><span><span class="dim">POST</span> <span class="acc">/rtk/join</span> <span class="dim">N-to-N meeting + join token · live</span></span></div>
<div class="row"><span class="k">auth</span><span class="warn">Authorization: Bearer &lt;key&gt;</span> <span class="dim">(via api.wave.online; this edge makes zero auth decisions)</span></div>
<div class="row"><span class="k">health</span><span class="dim">GET <a href="/health">/health</a> → 200 {"ok":true}</span></div>
<div><span class="tag">WHIP</span><span class="tag">WHEP</span><span class="tag">rooms</span><span class="tag">voice agents</span></div>

<h2>Three routes. Check that all three are real.</h2>
<p class="sub">A roadmap page returns 404. A demo returns 200 to anyone. These return 401, which is the interesting answer: the request reached a live handler and was refused for exactly one reason, the gateway's trust header. Run all three yourself. No key needed.</p>
<pre>$ curl -s -X POST https://rt.wave.online/<span class="acc">v1/whip/publish</span>
$ curl -s -X POST https://rt.wave.online/<span class="acc">v1/whep/subscribe</span>
$ curl -s -X POST https://rt.wave.online/<span class="acc">rtk/join</span>

<span class="warn">401</span> {"error":"UNAUTHORIZED",
     "message":"paid endpoint — call via api.wave.online"}
</pre>
<p class="sub"><span class="acc">Every route answers. None answers for free.</span> WHIP ingest, WHEP egress and rooms pass the same chokepoint, so one place decides who is authorized and one meter charges them.</p>
<div class="btns" style="margin-top:.8rem">
<a class="btn primary" href="https://console.wave.online/signup">Get a WAVE key →</a>
<a class="btn ghost" href="/skill.md">Read /skill.md →</a>
</div>
<p class="sub" style="margin-top:1.4rem"><span class="acc">One plane, both directions.</span> WAVE is media infrastructure for the agentic internet: one call shape moves live and on-demand media, and both kinds of user, people and agents, call it and pay for it per call. The broadcast plane carries one-to-many. This spoke is the interactive half, with rooms, calls and voice agents authorized by the same token and metered through the same gateway.</p>`;

export function landingPage(): string {
  return shell({
    product: "Realtime",
    title: "WAVE Realtime — your broadcast talks back, live today.",
    description:
      "IETF WHIP ingest, WHEP egress and N-to-N rooms, gated on the same gateway and the same token as WAVE broadcast. All three are live: call them with no key and each answers 401, not 404.",
    url: "https://rt.wave.online",
    keywords: "realtime, webrtc, whip, whep, rooms, voice agents, WAVE, protocol plane",
    inner: LANDING_INNER,
    tokensCss: TOKENS_CSS,
    accentHex: "#ff715d",
    productId: "realtime",
    ldHost: "rt.wave.online",
    ldTagline: "The interactive half of the WAVE protocol plane: two-way media, live.",
    cta: {
      primaryLabel: "Get a WAVE key →",
      primaryHref: "https://console.wave.online/signup",
      salesLabel: "Talk to sales",
      salesHref: "https://wave.online/enterprise",
      phrases: ["Publish over WHIP", "Subscribe over WHEP", "Open a room", "Add a voice agent"],
    },
  });
}
