// The response-header floor for every public surface rt.wave.online serves.
//
// This file used to hand-copy the chassis security-header set. It no longer does: it re-exports the
// chassis's own `SEC`, so there is exactly ONE definition of the floor and it cannot drift again.
//
// WHY IT WAS A FORK, AND WHY THE FORK IS NOW GONE (#490).
// rt is the one spoke whose fetch() is a fully custom router (route-dispatch.ts) rather than the
// chassis `makeFetch` every sibling uses, so it has to compose response headers itself. When this
// module was written the chassis exported only a CSP *string* (`DEFAULT_CSP`); its header *set* was
// private to the chassis worker, so the set was reproduced here by hand. That copy predates the
// chassis's `x-chassis` version stamp and never carried it — so every rt surface built from
// SEC_HEADERS shipped WITHOUT the stamp, and this host was unauditable for chassis drift. Measured
// 2026-09-07, before this change — note the control is on THIS host, which is what localises the
// defect to the fork rather than to the chassis:
//   rt.wave.online/robots.txt     200  x-chassis ABSENT   <- built from the local fork
//   rt.wave.online/_wave/nav.js   200  x-chassis 0.20.2   <- genuinely chassis-served, stamp present
// A missing version stamp means a security fix shipped in the chassis cannot be shown to be present
// on this host, and the spoke can produce no deploy receipt at all — its chassis version is
// permanently "could-not-measure" even after a fully successful deploy.
//
// The previous revision of this file carried a TODO — "collapse this to
// `export { SEC as SEC_HEADERS } from '@wave-av/spoke-chassis'` once the chassis actually re-exports
// headers.ts from its package root (not yet true as of 0.17.1)". At the pinned 0.20.2 that condition
// is MET, verified against the installed package rather than assumed: `dist/index.d.ts` now contains
// `export * from "./headers.js"`, and importing `SEC` from the package root resolves and yields the
// full set. So the TODO is discharged here rather than carried another release.
//
// WHAT CHANGES ON THE WIRE — a strict SUPERSET; nothing is dropped and nothing is widened.
// Every header the local fork emitted is still emitted, with the same value:
//   x-content-type-options: nosniff · referrer-policy: strict-origin-when-cross-origin
//   x-frame-options: DENY · content-security-policy
// The CSP is BYTE-IDENTICAL: at 0.20.2 the chassis's `CHASSIS_CSP` and the `DEFAULT_CSP` this file
// used to import are the same string (compared directly against the installed dist — same directive
// set, `frame-ancestors 'none'` included). The stale note in the previous revision, that DEFAULT_CSP
// lacked `frame-ancestors`, was true at 0.17.1 and is no longer true. Three headers are ADDED:
//   x-chassis                    the running chassis version — the whole point of #490
//   strict-transport-security    max-age=31536000; includeSubDomains; preload
//   permissions-policy           geolocation=(), camera=(), microphone=()
// HSTS is pinned to the value the zone already enforces at the edge, so source == live rather than a
// new promise; rt is https-only, so it cannot strand a plain-http surface.
//
// `SEC` deliberately carries NO cache-control, which is what makes it safe to spread LAST. Call
// sites here write `{ "content-type": …, "cache-control": …, ...SEC_HEADERS }`, and because the set
// contributes neither content-type nor cache-control, each response keeps its own explicit
// per-response decision (see discovery-routes.ts `headers()` and agent-discovery.ts).
//
// WHY `script-src 'self'` IS STILL RIGHT FOR THIS HOST (carried forward from the fork's own
// verification, which the swap does not invalidate — the chassis CSP's script-src is also 'self').
// The only inline <script> in rt's own markup is `<script type="application/ld+json">`, a DATA block
// browsers never execute and CSP never gates. Every executable script is a same-origin `/_wave/*.js`
// src, which `script-src 'self'` permits, and the single inline <style> is covered by
// `style-src 'unsafe-inline'`. The page we ship produces zero violations, so nothing needs widening —
// adding `'unsafe-inline'` to script-src would be a pure regression.
//
// This is still a leaf module (it imports nothing from this repo), so agent-discovery.ts and
// discovery-routes.ts can both use it without a cycle.
export { SEC as SEC_HEADERS } from "@wave-av/spoke-chassis";
