// wave-realtime-edge (rt.wave.online) — accent claimed from design-system/accent-wheel.md via the
// existing "realtime" entry in @wave-av/spoke-chassis's WAVE_PRODUCTS registry (nav.ts): #ff715d /
// oklch(0.72 0.18 30). Reused here (not re-claimed) so the top-nav highlight and this page's accent
// are the SAME color for the SAME product — one registry, no drift.
export const ACCENT_OKLCH = "oklch(0.72 0.18 30)";
import { buildTokensCss } from "@wave-av/spoke-chassis";

export const ACCENT_HEX = "#ff715d";
const TOKENS = buildTokensCss("dark", { accent: ACCENT_OKLCH });
export const TOKENS_CSS = TOKENS;
