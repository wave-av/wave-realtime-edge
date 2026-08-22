/**
 * flow-tap.ts — the signal-flow observer tap (signal-flow epic E1.P0).
 *
 * A FLAG-GATED transition-record emitter for the voice-agent signal flow. When `AGENT_FLOW_TAP`
 * is set to `"true"` or `"1"` on the worker, each tapped node emits ONE JSON line `{flow:"voice-agent", node, evt, ...}`
 * so a live run can be read as the flow's transition log ([[work:signal-flow:E1-VOICE-DOGFOOD]]).
 * When the flag is absent the function is a no-op — zero cost, zero log volume.
 *
 * The tap is the OBSERVER half of the flow model: it names the node + the data fingerprint at the
 * exact transition, so the "garbled / multiple renditions" defect is read off the log (mis-ordered
 * or duplicated frames, a mono/stereo mismatch, multiple STT turns) rather than guessed from code.
 */
export interface FlowTapEnv {
  /** Enabled only when set to "true" or "1". */
  AGENT_FLOW_TAP?: string;
}

/** Return whether the signal-flow observer tap is explicitly enabled. */
export function isFlowTapEnabled(env: FlowTapEnv | undefined): boolean {
  return env?.AGENT_FLOW_TAP === "true" || env?.AGENT_FLOW_TAP === "1";
}

/** Emit ONE transition record iff the tap flag is on. Returns nothing; never throws. */
export function flowTap(
  env: FlowTapEnv | undefined,
  node: string,
  evt: string,
  fields: Record<string, unknown> = {},
): void {
  if (!isFlowTapEnabled(env)) return;
  try {
    console.log(JSON.stringify({ flow: "voice-agent", node, evt, ...fields }));
  } catch {
    /* a tap must never break the live media path */
  }
}
