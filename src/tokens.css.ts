// wave-realtime-edge (rt.wave.online) — accent claimed from design-system/accent-wheel.md via the
// existing "realtime" entry in @wave-av/spoke-chassis's WAVE_PRODUCTS registry (nav.ts): #ff715d /
// oklch(0.72 0.18 30). Reused here (not re-claimed) so the top-nav highlight and this page's accent
// are the SAME color for the SAME product — one registry, no drift.
export const ACCENT_OKLCH = "oklch(0.72 0.18 30)";
import { buildTokensCss } from "@wave-av/spoke-chassis";

export const ACCENT_HEX = "#ff715d";
const TOKENS = buildTokensCss("dark", { accent: ACCENT_OKLCH });

// The WHIP/WHEP call-flow drawing and the 401 body are structural. `white-space:pre-wrap` (the
// chassis default) re-flows them into nonsense below ~430px, which reads as a broken layout on
// every phone. Scroll the block instead of breaking the drawing.
// `body pre` (not a bare `pre`) on purpose: the spoke token block is injected BEFORE the chassis
// stylesheet, so a bare `pre` selector loses the cascade tie to the chassis's own `pre` rule. One
// extra element in the selector wins on specificity regardless of injection order.
export const TOKENS_CSS = `${TOKENS}
body pre{white-space:pre;overflow-x:auto;-webkit-overflow-scrolling:touch}
/* The route list reads as a table, so give the label column one width instead of letting each row
   set its own — five ragged left edges were the "looks unaligned" finding on the desktop fold. */
body .row>.k{min-width:6.5rem;flex:0 0 auto}`;
