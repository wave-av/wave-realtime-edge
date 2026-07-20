// wave-realtime-edge (rt.wave.online) — accent claimed from design-system/accent-wheel.md via the
// existing "realtime" entry in @wave-av/spoke-chassis's WAVE_PRODUCTS registry (nav.ts): #ff715d /
// oklch(0.72 0.18 30). Reused here (not re-claimed) so the top-nav highlight and this page's accent
// are the SAME color for the SAME product — one registry, no drift.
export const ACCENT_OKLCH = "oklch(0.72 0.18 30)";
export const ACCENT_HEX = "#ff715d";
export const TOKENS_CSS = `:root{--bg:#0b0f14;--fg:#cfe3f7;--dim:#5b7287;--acc:${ACCENT_OKLCH};--warn:#e6b450}
::selection{background:var(--acc);color:var(--bg)}`;
