/**
 * E3n (wre#290) auto-record→VOD — the ONE flag gating both halves of this feature (A2+B1 per the
 * Fable-resolved fork, zoom-live-media-northstar epic 2026-07-24):
 *   1. `cf-stream-live-client.ts createLiveInput()` — flips `recording:{mode}` "off"→"automatic".
 *   2. `e3n-recording-sweep.ts` cron — lists completed recordings per live-input, pulls bytes into R2
 *      (`e3n-recording-pull.ts`), and registers them with the gateway (`recordings-register.ts`).
 *
 * Both must ship gated behind the SAME flag: auto-record without the register path is an orphan/unbilled
 * recording (cost leak); the register path with auto-record off has nothing to correlate (a no-op sweep).
 * Mirrors the strict truthiness contract of `ingressRouterEnabled`/`egressRouterEnabled`/`mediaTapEnabled`:
 * only `true` / "1" / "true" arm it — absent / "0" / anything else is OFF (fully inert, $0).
 */
export interface E3nAutorecordEnv {
  E3N_AUTORECORD_ENABLED?: string | boolean;
}

export function e3nAutorecordEnabled(env: E3nAutorecordEnv): boolean {
  const v = env.E3N_AUTORECORD_ENABLED;
  return v === true || v === "1" || v === "true";
}
