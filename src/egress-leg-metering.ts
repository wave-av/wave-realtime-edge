// W1 slice-1b (Zoom Live Media epic, wave-zoom#46) — INERT egress-leg metering helper.
//
// Mirrors src/metering.ts's emitParticipantUsage EXACTLY: same env (GATEWAY_BASE_URL +
// WAVE_SERVICE_TOKEN), same POST /v1/internal/usage envelope shape ({org, usage:{meter,
// meter_value, event_id}}), same Bearer-token auth header, same fail-open error handling (a
// metering emit must NEVER throw out of the media path — log + swallow, exactly like the sibling).
//
// UNLIKE emitParticipantUsage (per-participant, per-minute, publish-gated), this helper is
// per-(meeting, egress-leg): ONE emit at leg teardown carrying that leg's TOTAL connected
// duration. Redelivery-safety comes not from a local "already sent" flag but from the event_id
// itself: `zoomLegEventId(meetingUuid, leg)` is COPIED VERBATIM (same string formula) from the
// gateway's src/product-meters-zoom-egress.ts so a retried/duplicated teardown call produces the
// IDENTICAL event_id the gateway has already seen — gateway-side KV dedup (recordUsage, keyed on
// event_id) absorbs the retry with zero edge-side state.
//
// The four SKUs are ALREADY-PRICED-AT-$0 minute meters (gateway ZOOM_EGRESS_PRODUCT_METERS) —
// billed only once an operator provisions the corresponding STRIPE_PRICE_ZOOM_* env + the meter
// syncs `billed`. This helper ships INERT: it is not wired to any arm/teardown call site yet.
//
// meter_value (fractional MINUTES, never truncated) is used — NOT meter_ms — matching
// emitParticipantUsage's precedent and the gateway's documented precedence (usage.ts: meter_value
// wins over meter_ms for `_minutes` event names, `Math.round(meter_value * 60000)`).

/** The four Zoom egress transport legs — VERBATIM identifiers, must match gateway ZOOM_EGRESS_LEGS keys. */
export type ZoomEgressLeg = "ingest" | "rtms" | "rtmp-out" | "srt-out";

/** leg → catalog meter event_name. VERBATIM copy of gateway src/product-meters-zoom-egress.ts ZOOM_EGRESS_LEGS. */
export const ZOOM_EGRESS_LEGS: Record<ZoomEgressLeg, string> = {
  ingest: "wave_zoom_ingest_minutes",
  rtms: "wave_zoom_rtms_minutes",
  "rtmp-out": "wave_zoom_rtmp_out_minutes",
  "srt-out": "wave_zoom_srt_out_minutes",
};

/**
 * Idempotency key for ONE metered leg of ONE Zoom meeting. COPIED VERBATIM (same formula, same
 * `zoom-egress:` namespace) from the gateway's zoomLegEventId so both sides derive the IDENTICAL
 * string for the same (meetingUuid, leg) — this is what lets the gateway's event_id-keyed KV
 * dedup absorb a redelivered/duplicated edge-side emit with no edge-side "already sent" state.
 */
export function zoomLegEventId(meetingUuid: string, leg: ZoomEgressLeg): string {
  return `zoom-egress:${meetingUuid}:${leg}`;
}

/** The subset of env this tap reads — matches src/metering.ts's MeterEmitEnv exactly (same binding names). */
export interface EgressLegMeterEnv {
  /** Gateway origin, e.g. https://api.wave.online (var; not a secret). */
  GATEWAY_BASE_URL?: string;
  /** Internal service-to-service bearer for /v1/internal/usage (secret; deploy-time, Jake-named binding). */
  WAVE_SERVICE_TOKEN?: string;
}

export interface EmitEgressLegUsageArgs {
  org: string;
  meetingUuid: string;
  leg: ZoomEgressLeg;
  /** Total connected duration of this leg in ms, captured at teardown (before the leg is torn down). */
  durationMs: number;
}

/** The gateway `/v1/internal/usage` envelope — identical shape to src/metering.ts's UsageEnvelope. */
export interface EgressLegUsageEnvelope {
  org: string;
  usage: {
    meter: string;
    meter_value: number;
    event_id: string;
  };
}

/** True only when an operator has provisioned BOTH the gateway URL and the service token (else INERT). */
export function isEgressLegEmitProvisioned(env: EgressLegMeterEnv): boolean {
  return Boolean(env.GATEWAY_BASE_URL && env.WAVE_SERVICE_TOKEN);
}

/**
 * Flush one Zoom egress leg's total teardown usage to the gateway. Fire-and-forget friendly (call
 * via ctx.waitUntil / state.waitUntil); NEVER throws and NEVER breaks the media path — a metering
 * emit failure is logged and swallowed, exactly like emitParticipantUsage. No-op (and no network)
 * when the emit is not provisioned or the duration is non-positive (clock skew / zero-length leg).
 *
 * INERT: this helper has no caller yet — no arm/teardown call site wires it in this change.
 */
export async function emitEgressLegUsage(
  env: EgressLegMeterEnv,
  args: EmitEgressLegUsageArgs,
  deps?: { fetchFn?: typeof fetch },
): Promise<void> {
  if (!isEgressLegEmitProvisioned(env)) return; // INERT until operator provisions URL + token
  if (!(args.durationMs > 0)) return; // zero-length / inverted clock → nothing billable

  const fetchFn = deps?.fetchFn ?? fetch;
  const meter = ZOOM_EGRESS_LEGS[args.leg];
  const meter_value = args.durationMs / 60_000; // fractional minutes, never truncated
  const event_id = zoomLegEventId(args.meetingUuid, args.leg);

  const base = (env.GATEWAY_BASE_URL as string).replace(/\/+$/, "");
  const token = env.WAVE_SERVICE_TOKEN as string;
  const body: EgressLegUsageEnvelope = { org: args.org, usage: { meter, meter_value, event_id } };

  try {
    const res = await fetchFn(`${base}/v1/internal/usage`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      // Loud, but never blocking — observability only, no secret/PII in the line.
      console.warn(
        `egress-leg-meter emit failed meter=${meter} leg=${args.leg} status=${res.status} org=${args.org}`,
      );
    }
  } catch (e) {
    // Fail-open: a usage emit must NEVER affect the live media path (mirrors emitParticipantUsage).
    console.warn(
      `egress-leg-meter emit error meter=${meter} leg=${args.leg} org=${args.org}: ${(e as Error)?.message ?? e}`,
    );
  }
}
