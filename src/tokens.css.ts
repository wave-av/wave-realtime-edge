// Realtime (realtime.wave.online) — accent claimed from design-system/accent-wheel.md.
// On-air coral: the "live" signal of the wave. WCAG-gated via validators/contrast.mjs.
export const ACCENT_OKLCH = "oklch(0.72 0.18 30)";
export const ACCENT_HEX = "#ff715d";
export const TOKENS_CSS = `:root{--bg:#0b0f14;--fg:#cfe3f7;--dim:#5b7287;--acc:${ACCENT_OKLCH};--warn:#e6b450}
::selection{background:var(--acc);color:var(--bg)}`;
