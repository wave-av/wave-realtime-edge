// Cron handler body — extracted to its own leaf module (mirroring dispatch-helpers.ts, task #56) so neither
// this file nor route-dispatch.ts exceeds 800 lines. Imports only leaf modules, so there is no cycle:
// route-dispatch.ts re-exports scheduledHandler from here, and worker.ts's import is unchanged.
import { reconcilePending } from "./rtk-webhook";
import { scheduledStreamReconcile, liveStreamBridgeDeps, liveStreamProbeHealth } from "./stream-bridge";
import { scheduledStreamPoll } from "./stream-bridge-poll";
import { scheduledIngestReconcile } from "./ingest-bridge";
import { scheduledWhipSweep, WHIP_SWEEP_CRON } from "./whip-sweep";
import { scheduledContainerHealth } from "./container-health-alarm";
import { scheduledE3nRecordingSweep } from "./e3n-recording-sweep";
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

	// #8 — CF Stream lifecycle POLL: the PRIMARY dispatch trigger for the container bridge. The
	// `live_input.connected` webhook this bridge was built around was never subscribed on the account
	// (we had the VOD video-ready webhook instead), so nothing ever dispatched or billed. Polling the
	// input's own lifecycle endpoint needs no CF-side subscription and self-heals a missed event.
	// Runs on EVERY tick so go-live latency is the tight */5 cadence, not the 15-minute one.
	{
		const deps = liveStreamBridgeDeps(env);
		// #247 — probeHealth lets the poll detect a bridge whose container died (crash, eviction, or a #235
		// rollout drain) while the input is still live, and clear the stale session so the next tick re-dispatches.
		scheduledStreamPoll(env, ctx, {
			dispatchStart: deps.dispatchStart,
			dispatchStop: deps.dispatchStop,
			probeHealth: (org, uid) => liveStreamProbeHealth(env, org, uid),
		});
	}

	// #35/#260 — WHIP orphan sweeper: bills publish sessions whose container died without sending a teardown
	// DELETE (revenue integrity). GATED to the sweep's own */5 event (isSweepOnlyTick). Both crons
	// (*/15 + */5) fire at :00/:15/:30/:45, so scheduled() is invoked TWICE at those instants; running the
	// sweep unconditionally raced two concurrent sweeps there (#260) — benign post-#240 (emit is idempotent on
	// event_id) but it doubled SFU liveness probes. */5 alone already covers every 5-minute sweep instant, so
	// gating to it keeps the exact cadence with exactly one sweep per tick. INERT unless WHIP_SWEEP_ENABLED +
	// KV bound. Best-effort.
	if (isSweepOnlyTick) scheduledWhipSweep(env, ctx);

	// #234 — container-app WEDGE alarm (`active > 0 && healthy == 0`). Gated to the FIFTEEN-minute tick, not
	// every tick: the signature must be SUSTAINED to mean anything, and two 15-min samples is the ~2-poll-
	// interval dwell #234 asks for while keeping this to 4 CF API reads an hour. INERT unless
	// CONTAINER_HEALTH_ALARM_ENABLED=1 + CF_API_TOKEN/CF_ACCOUNT_ID bound. Never throws.
	if (!isSweepOnlyTick) scheduledContainerHealth(env, ctx, env.RT_MEETING_ORG);

	// E3n (wre#290) auto-record→VOD completion sweep (Axis A2+B1, INERT unless E3N_AUTORECORD_ENABLED + every
	// required binding present). Gated to the FIFTEEN-minute tick — recording completion is not latency
	// sensitive the way live-input lifecycle is, and this keeps the CF Stream API call volume bounded.
	if (!isSweepOnlyTick) scheduledE3nRecordingSweep(env, ctx);
}
