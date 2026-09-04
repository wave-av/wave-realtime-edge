// The response-header floor for every public surface rt.wave.online serves.
//
// BUG (RT catch-all sweep, 2026-09-03): rt was one of only two live WAVE hosts serving NO
// Referrer-Policy. Measured against production that day:
//   curl -sD- -o /dev/null https://rt.wave.online/         → CSP present, NO referrer-policy
//   curl -sD- -o /dev/null https://rt.wave.online/llms.txt → 501, no security headers at all
// Every sibling spoke gets this set for free because it routes through the chassis
// `makeFetch`, which spreads its `SEC` object into every response. rt's custom router
// (route-dispatch.ts) hand-assembled `{content-security-policy, x-content-type-options}` on exactly
// one response — the landing page — and nothing else. This is a leaf module (imports nothing from
// this repo) so both agent-discovery.ts and discovery-routes.ts can use it without a cycle.
//
// The CSP is IMPORTED from the chassis — `DEFAULT_CSP`, the same constant route-dispatch.ts already
// used for the landing page — and is NOT widened here. The chassis defines the full set in
// packages/spoke-chassis/src/headers.ts as `SEC`, but headers.ts is not re-exported from the package
// root at rt's pinned version (verified against the installed dist: `import { SEC }` fails TS2305
// while `DEFAULT_CSP` resolves), so the other three headers are reproduced with the chassis's exact
// values rather than invented.
//
// RE-CHECKED 2026-09-03 against chassis 0.17.1 (the pin #473 landed on main, which this branch is now
// rebased onto): `SEC` is STILL not reachable from the package root. The published `dist/` ships no
// `headers.d.ts`/`headers.js` at all, and `dist/index.d.ts` re-exports worker/shell/pages/sitemap/
// favicon/nav/… but never headers — so `import { SEC }` still fails TS2305 at 0.17.1 (probed against
// the installed package, not assumed). This leaf therefore STAYS local; collapsing it now would not
// compile. Note the chassis's own `SEC` additionally appends `frame-ancestors 'none'` to its CSP —
// visible on any chassis-served response (e.g. the live /_wave/* assets) — whereas `DEFAULT_CSP` does
// not carry it. The `x-frame-options: DENY` below covers the same clickjacking surface, so this floor
// is equivalent in effect, not weaker.
// TODO: collapse this to `export { SEC as SEC_HEADERS } from "@wave-av/spoke-chassis"` once the
// chassis actually re-exports headers.ts from its package root (not yet true as of 0.17.1).
//
// WHY script-src STAYS 'self' (verified, not assumed). Fetched the live page 2026-09-03: the only
// inline <script> in our own markup is `<script type="application/ld+json">`, a DATA block browsers
// never execute and CSP never gates. Every executable script is a same-origin `/_wave/*.js` src,
// which `script-src 'self'` permits. The single inline <style> is covered by
// `style-src 'unsafe-inline'`. Zero violations from the page we ship — so no widening is needed, and
// adding `'unsafe-inline'` to script-src would be a pure regression.
import { DEFAULT_CSP } from "@wave-av/spoke-chassis";

export const SEC_HEADERS: Record<string, string> = {
	"x-content-type-options": "nosniff",
	"referrer-policy": "strict-origin-when-cross-origin",
	"x-frame-options": "DENY",
	"content-security-policy": DEFAULT_CSP,
};
