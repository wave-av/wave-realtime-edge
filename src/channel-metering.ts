// channel-metering.ts — item #5: usage emit for the channel pub/sub plane.
//
// Mirrors metering.ts's server-to-server `/v1/internal/usage` POST — the metering pattern this repo
// ALREADY uses for the ROOM plane (see metering.ts's header comment for why: a DO-internal event has no
// live customer response to stamp for the room's leave-flush). A channel `publish` DOES have a live HTTP
// response in flight, but this repo has exactly one metering sink today, so channels reuse it rather than
// introduce a second (response-header) carrier for one route family.
//
// INERT by construction: no network call happens unless an operator has provisioned BOTH GATEWAY_BASE_URL
// and WAVE_SERVICE_TOKEN (same two fields metering.ts already reads). The meter name below is NOT yet in
// the priced catalog — this counts events but bills $0 until an operator binds a price, exactly the
// "counts-but-bills-$0 until STRIPE_PRICE_* is bound" precedent wrangler.toml documents for WHIP ingest.

/** Meter event name for one published channel event. Not yet priced — counts only until an operator binds
 *  a catalog price (see file header). */
export const METER_CHANNEL_EVENTS = "wave_realtime_channel_events";

export interface ChannelMeterEmitEnv {
  /** Gateway origin, e.g. https://api.wave.online (var; not a secret). */
  GATEWAY_BASE_URL?: string;
  /** Internal service-to-service bearer for /v1/internal/usage (secret; the SAME token metering.ts uses). */
  WAVE_SERVICE_TOKEN?: string;
}

/** True only when an operator has provisioned BOTH the gateway URL and the service token (else INERT). */
export function isChannelEmitProvisioned(env: ChannelMeterEmitEnv): boolean {
  return Boolean(env.GATEWAY_BASE_URL && env.WAVE_SERVICE_TOKEN);
}

/**
 * Flush one channel-publish usage line to the gateway. Fire-and-forget friendly (call via ctx.waitUntil);
 * NEVER throws and NEVER affects the live publish response — a usage-emit failure is logged loud
 * (observability only) and swallowed, matching metering.ts's fail-open contract. Idempotent on the
 * publish's own event id, so a retried emit can never double-count.
 */
export async function emitChannelPublishUsage(
  env: ChannelMeterEmitEnv,
  org: string,
  channel: string,
  eventId: string,
  fetchFn: typeof fetch = fetch,
): Promise<void> {
  if (!isChannelEmitProvisioned(env)) return; // INERT until operator provisions URL + token
  const base = (env.GATEWAY_BASE_URL as string).replace(/\/+$/, "");
  const token = env.WAVE_SERVICE_TOKEN as string;
  const body = {
    org,
    usage: { meter: METER_CHANNEL_EVENTS, meter_value: 1, event_id: `${org}:${channel}:${eventId}` },
  };
  try {
    const res = await fetchFn(`${base}/v1/internal/usage`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      console.warn(`channel-meter emit failed status=${res.status} org=${org} channel=${channel}`);
    }
  } catch (e) {
    console.warn(`channel-meter emit error org=${org} channel=${channel}: ${(e as Error)?.message ?? e}`);
  }
}
