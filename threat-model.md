# wave-spoke-template — threat model

A spoke is a **thin** WAVE Protocol Plane edge surface. Its security posture is deliberately small: it
reverse-proxies `/api/*` to `api.wave.online` and serves a few static pages. **All authentication,
authorization, scope, entitlement, metering, and payment settlement are DELEGATED to the WAVE API gateway**
(Sub-Project A). This document is the per-spoke security contract; the live summary is at `/threat-model`.

Legend: ✅ mitigated · ⚠️ partial / by-design · ☐ delegated (out of scope for the spoke).

## Trust boundary

```
  client ──Authorization: Bearer <wave_key>──▶  wave-spoke (this worker)
                                                   │  NO auth logic here
                                                   │  + X-Wave-Product / X-Wave-Protocol / X-Wave-Spoke
                                                   │  Authorization forwarded UNTOUCHED
                                                   ▼
                                      the WAVE API gateway  ── authorize · scope · entitlement · meter
                                                   ▼
                                               api.wave.online  (the WAVE hub / @wave/core)
```

A spoke is **inside** the WAVE trust domain but is **not** a trust authority. It must never make an
access decision; doing so would create a 5th competing key system (the exact anti-pattern the gateway
program exists to eliminate).

## Threats & posture

| # | Threat | Posture | Mitigation |
|---|--------|---------|------------|
| 1 | Page XSS / clickjacking / embedding | ✅ | Zero-JS pages under strict CSP (`default-src 'none'`, inline styles only), `X-Frame-Options: DENY`, HSTS, `X-Content-Type-Options: nosniff` (`src/pages.ts`). |
| 2 | Origin misconfiguration silently 200s | ✅ | `proxyToOrigin()` fail-closes to 502 `ORIGIN_UNCONFIGURED` if `ORIGIN_URL` is unset — never returns a fake success. |
| 3 | Attribution spoofing (caller forges product/protocol) | ✅ | `X-Wave-Product` / `X-Wave-Protocol` / `X-Wave-Spoke` are SERVER-SET, overwriting any client-supplied value before forwarding. |
| 4 | Cross-tenant cache leak | ✅ | Edge cache stores ONLY GET/HEAD requests with NO `Authorization` and NO `X-Payment` header, and only origin responses without `private`/`no-store`/`Set-Cookie` (`src/cache.ts`). A cache hit can never serve one caller's authorized data to another. |
| 5 | Credential leakage in logs / config | ✅ | No secrets in `wrangler.toml`; auth secrets are NOT a spoke concern. `Authorization` is forwarded but never read, logged, or persisted. `.dev.vars` is gitignored. |
| 6 | CORS credential exposure | ⚠️ | Default `*` is safe because the spoke carries NO cookies/credentials (auth is an explicit Bearer header). When a spoke needs a restricted origin set, configure `SPOKE_CORS_ORIGINS`. |
| 7 | Credential validation | ⚠️ by-design | The spoke forwards `Authorization` untouched and does NOT validate it. An invalid key is rejected downstream by the gateway/origin, not here. |
| 8 | AuthN / scope / entitlement / metering | ☐ delegated | Enforced by the **WAVE API gateway** (`authorize → scope → entitlement → rateLimit → meter`). |
| 9 | x402 pay-per-use settlement | ☐ delegated | Challenge + on-chain settlement verification happen at the gateway / WAVE hub. The spoke forwards `X-Payment` untouched. |
| 10 | DDoS / volumetric abuse | ☐ delegated | Cloudflare WAF + the gateway's per-org rate limiter. The spoke adds no per-caller counters. |

## Invariants a spoke must preserve (do not regress)

- **Never add an access decision in a spoke.** If you find yourself reading the key, stop — push it to
  the gateway.
- **Never inline a secret** in `wrangler.toml` or any tracked file (`wrangler secret put` only).
- **Never cache an authenticated or payment-bearing request.**
- **Always attach attribution headers server-side; never trust client-supplied `X-Wave-*`.**
- **Fail closed on origin misconfig** (502, not a fabricated 200).

## ⛔ Gating

Spokes built from this template depend on Wave 0. Do not point a live `*.wave.online` route at a spoke
until the WAVE API gateway is deployed in front of it. The gateway is a hard prerequisite: spoke
origins are designed to trust that authentication, authorization, and payment enforcement have
already happened upstream, so a spoke must never be the first hop for a live route.
