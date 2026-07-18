// Cron handler body — extracted to its own leaf module (mirroring dispatch-helpers.ts, task #56) so neither
// this file nor route-dispatch.ts exceeds 800 lines. Imports only leaf modules, so there is no cycle:
// route-dispatch.ts re-exports scheduledHandler from here, and worker.ts's import is unchanged.
import { reconcilePending } from "./rtk-webhook";
import { scheduledStreamReconcile } from "./stream-bridge";
import { scheduledIngestReconcile } from "./ingest-bridge";
import { scheduledWhipSweep, WHIP_SWEEP_CRON } from "./whip";
import { buildPullSink, type Env } from "./dispatch-helpers";

/**
 * Cron (wrangler.toml [triggers]) — durable recovery for PULL-mode recordings. RTK fires the UPLOADED
 * webhook once and never re-delivers after our 200, so a POST-ack pull failure would silently lose the
 * recording. handleRecordingWebhook enqueues a pending-pull record on failure; this reconcile re-pulls each
 * with a freshly resolved download URL (idempotent key) and clears it on success. Best-effort; never throws.
 */
export async function scheduledHandler(
	event: ScheduledEvent,
	env: Env,
	ctx: ExecutionContext,
): Promise<void> {
	// #35 — the WHIP orphan sweeper needs a TIGHTER cadence than the reconciles (its interval bounds how much
	// of a dead session's tail goes unbilled), so wrangler.toml adds a second trigger. Gate the pre-existing
	// reconciles to the original fifteen-minute tick so that added trigger does not triple THEIR cadence.
	const isSweepOnlyTick = event?.cron === WHIP_SWEEP_CRON;

	if (!isSweepOnlyTick) {
		const sink = buildPullSink(env);
		if (sink && env.RT_MEETING_ORG) {
			ctx.waitUntil(
				reconcilePending(env.RT_MEETING_ORG, sink, (msg, fields) => console.log(JSON.stringify({ msg, ...fields }))),
			);
		}
		// B1 (#91-a) — CF Stream bridge lifecycle-poll backstop (INERT unless enabled + KV bound). Best-effort.
		scheduledStreamReconcile(env, ctx);
		// F (#55) — Plane-2 ingest-bridge pending-start reconcile backstop (INERT unless enabled + KV bound). Best-effort.
		scheduledIngestReconcile(env, ctx);
	}

	// #35 — WHIP orphan sweeper: bills publish sessions whose container died without sending a teardown
	// DELETE (revenue integrity). Runs on EVERY tick. INERT unless WHIP_SWEEP_ENABLED + KV bound. Best-effort.
	scheduledWhipSweep(env, ctx);
}
