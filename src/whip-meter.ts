// B3 (#98) — WHIP billing/metering emission cluster, split out of whip.ts (non-behavioral refactor).
//
// FROZEN CONTRACT: ~/.claude/plans/wave-any-to-any-matrix/whip-v1-frozen-contract.md (v1.1), §3/§4/§6-B3/§9.

import { isEmitProvisioned, type UsageEnvelope, type MeterLine } from "./metering.js";
import type { WhipEnv } from "./whip.js";

/** WHIP ingest meter — dedicated SKU per the frozen contract §4 (priced to STRIPE_PRICE_WHIP_INGEST_MIN). */
export const METER_WHIP_INGEST_MINUTES = "wave_whip_ingest_minutes";

/**
 * #91 B2 stream-bridge SKU — a CF-Stream→SFU bridge publish bills a DISTINCT meter (4-layer COGS; frozen
 * contract §4 / orphan-COGS-blocks-GA), NOT the bare WHIP-ingest SKU. The gateway directs it via the SEALED
 * `x-wave-meter-override` header (stamped server-side ONLY for a `stream-bridge:write` key; forward() strips
 * any client copy). The edge honors that override but ONLY against this allowset (validate-before-sink) — an
 * unknown/malformed value can NEVER be billed; it falls back to the default WHIP-ingest meter.
 */
export const METER_STREAM_BRIDGE_MINUTES = "wave_stream_bridge_minutes";
const WHIP_METER_OVERRIDE_ALLOW: ReadonlySet<string> = new Set([METER_STREAM_BRIDGE_MINUTES]);
export const WHIP_METER_OVERRIDE_HEADER = "x-wave-meter-override";

/** Resolve the session's billing meter from the gateway-sealed override: the named bridge SKU when present
 *  AND allowed, else the default wave_whip_ingest_minutes. Pure — the security boundary (the override is
 *  gateway-sealed, never client-supplied) is upstream; this is the defense-in-depth allowset check. */
export function resolveWhipMeter(override: string | null | undefined): string {
	return override && WHIP_METER_OVERRIDE_ALLOW.has(override) ? override : METER_WHIP_INGEST_MINUTES;
}

/**
 * Build the one teardown meter line for a WHIP publish session. PURE (no I/O) so the accounting is
 * unit-testable. Duration is ceil-minutes (a started publish bills ≥1 min); idempotency = resourceId (§4).
 */
export function buildWhipMeterLine(
	resourceId: string,
	startedAt: number,
	endedAt: number,
	meter: string = METER_WHIP_INGEST_MINUTES,
): MeterLine {
	const ms = endedAt - startedAt;
	const minutes = ms > 0 ? Math.ceil(ms / 60_000) : 0;
	return { meter, meter_value: minutes, event_id: resourceId };
}

/**
 * Emit the WHIP ingest teardown meter to the gateway `/v1/internal/usage` (same ingest the realtime tap
 * uses). FAIL-OPEN (§4): a meter failure must never affect the teardown response. Idempotent on resourceId.
 * No-op (no network) when the emit is not provisioned (GATEWAY_BASE_URL + WAVE_SERVICE_TOKEN) or value is 0.
 */
export async function emitWhipTeardownMeter(
	env: WhipEnv,
	org: string,
	line: MeterLine,
	fetchFn: typeof fetch,
): Promise<void> {
	// Fail-open by contract: the client-DELETE path must never be affected by a metering failure.
	await deliverWhipTeardownMeter(env, org, line, fetchFn);
}

/**
 * The same emit, but REPORTING whether the usage was actually accepted. The cron sweeper needs this: unlike
 * handleDelete (where the client is tearing down regardless and fail-open is correct), the sweeper OWNS the
 * only remaining record of that session's usage. If it dropped the record on an emit that silently failed,
 * the minutes would be lost forever — reintroducing the exact revenue leak this sweeper exists to close.
 * So the sweeper retries on the next tick instead, which is safe because the emit is idempotent on
 * event_id = resourceId.
 *
 * @returns true when the usage is durably accounted for (delivered, or nothing billable to deliver).
 */
export async function deliverWhipTeardownMeter(
	env: WhipEnv,
	org: string,
	line: MeterLine,
	fetchFn: typeof fetch,
): Promise<boolean> {
	if (!isEmitProvisioned(env)) return false; // INERT — nothing was recorded, so nothing may be dropped
	if (!(line.meter_value > 0)) return true; // nothing billable (zero/negative duration) → safe to drop
	const base = (env.GATEWAY_BASE_URL as string).replace(/\/+$/, "");
	const token = env.WAVE_SERVICE_TOKEN as string;
	const body: UsageEnvelope = { org, usage: line };
	try {
		const res = await fetchFn(`${base}/v1/internal/usage`, {
			method: "POST",
			headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
			body: JSON.stringify(body),
		});
		if (!res.ok) {
			console.warn(`whip-meter emit failed status=${res.status} org=${org}`); // loud, non-blocking
			return false;
		}
		return true;
	} catch (e) {
		console.warn(`whip-meter emit error org=${org}: ${(e as Error)?.message ?? e}`);
		return false;
	}
}
