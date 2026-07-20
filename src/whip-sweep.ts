// #35 — WHIP orphan sweeper (revenue integrity), split out of src/whip.ts (file-size-two-tier-gate). Pure
// mechanical extraction — zero behavior change. A publish whose client tears down cleanly is billed by
// handleDelete (src/whip.ts); a publish whose CONTAINER IS EVICTED OR CRASHES never sends that DELETE, so
// without this sweep its minutes are never billed at all. This is the "or cron" teardown path the resource
// record was designed for (see WhipResource.meter).
//
// Shares the WHIP KV record shape, meter accounting, and teardown-meter delivery with src/whip.ts — those
// stay defined there (used by the publish/PATCH/DELETE handlers too) and are imported here.

import type { SfuClient } from "./sfu.js";
import { isEmitProvisioned, type MeterLine } from "./metering.js";
import {
	RESOURCE_ID,
	WHIP_KV_PREFIX,
	WHIP_KV_TTL_SECONDS,
	buildWhipMeterLine,
	deliverWhipTeardownMeter,
	liveWhipDeps,
	loadResource,
	resolveWhipMeter,
	type WhipDeps,
	type WhipEnv,
	type WhipResource,
} from "./whip.js";

/**
 * #35 — where the orphan sweeper parked its pagination cursor. Deliberately NOT under `whip:` so the sweep's
 * own bookkeeping is never enumerated as a resource record by `list({ prefix: WHIP_KV_PREFIX })`.
 */
const WHIP_SWEEP_CURSOR_KEY = "whipsweep:cursor";
/**
 * #35 — how long a session may answer with ZERO tracks before the sweeper treats it as a dead publisher.
 * Tracks appear within seconds of a successful publish, so anything past this window is not negotiation —
 * it is CF holding an empty session open for a publisher that died without a teardown (live-observed still
 * answering 200 with `tracks: []` 35 minutes after the publisher was killed). Generous on purpose: the cost
 * of waiting is delayed revenue, while the cost of being too eager is closing a real session.
 */
const WHIP_IDLE_GRACE_MS = 3 * 60_000; // 3 min

/**
 * #240/#257 — how long a session must CONTINUOUSLY answer a DEATH signal (410 disconnected, 404/all-inactive
 * gone, or an aged once-alive idle) before the sweeper treats it as a dead orphan and bills+drops it. Originally
 * the 410-only gate (#240); #257 generalized it to every bill-triggering verdict so the billing boundary is
 * uniformly safe. Deliberately just UNDER the 5-min sweep interval so a death seen on two consecutive sweeps
 * confirms, while a transient death that recovers by the next sweep (answers "alive" in between → stamp cleared)
 * never bills. NO single probe is proof of terminal death: CF emits 410 for a recoverable ICE blip, tracks can
 * flap inactive→active on renegotiation, and even a 404 can be a mis-routed probe in a sharded SFU. Under-
 * confirming (waiting a sweep) only delays revenue; over-eager billing forfeits a live session's WHOLE bill (its
 * later teardown DELETE finds no record → 204, no usage).
 */
const WHIP_GONE_CONFIRM_MS = 4 * 60_000; // 4 min (< the */5 sweep interval → requires two consecutive death sweeps)

/**
 * #35 — the dedicated cron expression for the orphan sweep. MUST stay byte-identical to the second entry in
 * wrangler.toml `crons`, since scheduledHandler compares `event.cron` against it to keep the pre-existing
 * fifteen-minute reconciles on their original cadence.
 */
export const WHIP_SWEEP_CRON = "*/5 * * * *";

/** #35 — True only when an operator has armed the orphan sweeper. Default (absent/"0"/false) → never runs. */
export function whipSweepEnabled(env: WhipEnv): boolean {
	const v = env.WHIP_SWEEP_ENABLED;
	return v === true || v === "1" || v === "true";
}

/**
 * #35 — cron entrypoint for the WHIP orphan sweeper, mirroring the other scheduled reconciles: flag-gated,
 * best-effort, and detached via waitUntil so a slow sweep never delays the scheduled() return. A sweep
 * failure is logged, never thrown — metering must not break the cron for every other tap.
 */
export function scheduledWhipSweep(env: WhipEnv, ctx: { waitUntil(p: Promise<unknown>): void }): void {
	if (!whipSweepEnabled(env) || !env.RT_MEETING_ORG) return; // INERT by default
	ctx.waitUntil(
		sweepWhipResources(env, liveWhipDeps()).catch((e) =>
			console.warn(`whip-sweep failed: ${(e as Error)?.message ?? e}`),
		),
	);
}

/** One probed resource, ready for the pure sweep planner. */
export interface WhipSweepEntry {
	resourceId: string;
	record: WhipResource;
	/** SFU liveness verdict (see SfuClient.sessionLiveness). "unknown" ⇒ we could not tell. */
	verdict: "alive" | "gone" | "idle" | "disconnected" | "unknown";
	/**
	 * Epoch ms captured immediately BEFORE this session's own probe. Stamped per-entry rather than once per
	 * page because a page of probes takes real time: a single post-loop timestamp would credit the first
	 * session with liveness it was never observed to have, and that inflated lastSeenAt would later be
	 * billed as real. A conservative pre-probe stamp can only ever under-credit.
	 */
	observedAt: number;
}

/** What the sweeper should DO — computed purely, applied by sweepWhipResources. */
export interface WhipSweepPlan {
	/** Still live → persist a refreshed lastSeenAt so a later orphan teardown bills to a VERIFIED instant. */
	refresh: { resourceId: string; record: WhipResource }[];
	/** Orphaned (publisher died without a DELETE) → bill, then drop. */
	meter: {
		resourceId: string;
		org: string;
		line: MeterLine;
		/** WHY this was billed — carried so the sweep can LOG the reason, not just the count (#233). */
		verdict: WhipSweepEntry["verdict"];
		/** True when the session was never once observed alive, so the billed quantity is a floor, not a measure. */
		neverSeenAlive: boolean;
	}[];
	/** Resource ids whose KV record should be deleted (always the billed ones). */
	drop: string[];
	/**
	 * #240/#257 — record writebacks that are NOT alive-refreshes: stamping `disconnectedSince` on the FIRST death
	 * signal of any kind (410 disconnected, 404/all-inactive gone, or an aged once-alive idle). Kept a separate
	 * bucket (not `refresh`) so the sweep log counts them honestly and never reports a death-stamp as a live
	 * sighting (#233 truthful-logging). The stamp is only ever CLEARED via an "alive" refresh (#240 Phase-2 flap
	 * fix); no idle/gone/unknown probe clears it. `reason` names which verdict opened the confirm window — it is
	 * for the log only and does not change the gate's behaviour (all three wait the same WHIP_GONE_CONFIRM_MS).
	 */
	mark: {
		resourceId: string;
		record: WhipResource;
		reason: "disconnected-first-seen" | "gone-first-seen" | "idle-first-seen";
	}[];
}

/**
 * #35 — decide, PURELY, what to do with each probed WHIP resource. No I/O, so the billing rules are
 * unit-testable in isolation (mirrors buildWhipMeterLine's pure-accounting stance).
 *
 * A BILLING boundary has one dominant failure mode: over-eager billing FORFEITS a live session's WHOLE bill,
 * because bill→drop deletes the KV record and its later teardown DELETE then finds nothing (204, no usage).
 * Under-billing by one sweep only DELAYS revenue. So the correct error direction is always to WAIT, and #257
 * makes that uniform: EVERY death signal is confirmed across a sweep before it bills.
 *  - "alive" (200 + ≥1 active track) → refresh lastSeenAt to the probe instant and CLEAR any pending death
 *                stamp. This is the only verdict that clears the stamp, so a genuinely recovered session is
 *                always rescued from a pending bill.
 *  - death signals — "disconnected" (410), "gone" (404/all-inactive), and an aged once-alive "idle" — all go
 *                through ONE confirm gate: the first occurrence stamps `disconnectedSince` and WAITS; it bills
 *                (startedAt → lastSeenAt, floored at startedAt+1ms) and drops only once that stamp has PERSISTED
 *                past WHIP_GONE_CONFIRM_MS. A transient death (a mis-routed 404, a track-inactive or ICE flap, a
 *                renegotiation blip) that answers "alive" before the window closes clears the stamp and never
 *                bills — the #240 protection, generalized to every path (#257). Billed to the last VERIFIED
 *                sighting, never to `now`, so a real orphan is never charged for dead air.
 *  - "idle" preconditions (unchanged, #233): a session NEVER seen alive tells us nothing (CF answers
 *                200/zero-track for a healthy WHIP publish its whole life), and a freshly-published one is
 *                legitimately zero-track mid-negotiation. Only an aged, once-alive idle is a death candidate;
 *                below either bar it simply survives and any existing stamp persists untouched.
 *  - "unknown" → do NOTHING (no refresh, no bill, no stamp change). The record survives to the next tick
 *                (24h KV TTL bounds it); acting on a probe we could not read would either invent liveness or
 *                close a live session.
 *
 * The billed window is floored at 1ms so a session that dies before its first successful probe still bills
 * the documented ≥1 ceil-minute for a started publish, rather than silently billing zero.
 */
export function planWhipSweep(entries: WhipSweepEntry[], now: number): WhipSweepPlan {
	const plan: WhipSweepPlan = { refresh: [], meter: [], drop: [], mark: [] };
	for (const { resourceId, record, verdict, observedAt } of entries) {
		const at = observedAt ?? now;
		if (verdict === "unknown") continue; // cannot tell → never act on a guess (any pending death stamp survives)
		if (verdict === "alive") {
			// Stamp the instant THIS session was probed, never the page-wide `now` (see WhipSweepEntry.observedAt).
			// Verified live ⇒ clear any pending death stamp (the session recovered; JSON.stringify drops undefined).
			// This is the ONLY verdict that clears the stamp, so recovery always rescues a session from a pending bill.
			plan.refresh.push({ resourceId, record: { ...record, lastSeenAt: at, disconnectedSince: undefined } });
			continue;
		}

		// ── Everything below is a DEATH SIGNAL: "gone" (404/all-inactive), "disconnected" (410), or an aged
		//    once-alive "idle". #257 routes them ALL through ONE persistence-confirm gate (generalizing the #240
		//    410 gate). Over-eager billing forfeits a live session's WHOLE bill — its later teardown DELETE finds
		//    no record → 204, no usage — so NO single probe may bill+drop. A first death-of-any-kind stamps
		//    `disconnectedSince` and WAITS; only "alive" (above) clears it; it bills only once the stamp persists
		//    past WHIP_GONE_CONFIRM_MS. Waiting one sweep only DELAYS revenue; eager billing on a transient death
		//    (a mis-routed 404, a track-inactive flap, a renegotiation blip) forfeits the whole session (#240).

		// "idle" is a death CANDIDATE only when once-alive AND aged past the negotiation grace (#233): CF answers
		// 200/zero-track for a healthy WHIP publish its entire life, and a fresh publish is legitimately
		// zero-track mid-negotiation. Below either bar it survives untouched (any existing stamp persists).
		if (verdict === "idle") {
			if (record.lastSeenAt === undefined) continue; // never seen alive → idle proves nothing; survive
			if (at - record.startedAt <= WHIP_IDLE_GRACE_MS) continue; // within the negotiation grace → leave alone
		}

		// Unified confirm gate for every death candidate. First death signal → stamp and wait one sweep; the
		// `reason` names which verdict opened the window (truthful logging, #233) without altering the gate.
		if (record.disconnectedSince === undefined) {
			const reason =
				verdict === "disconnected"
					? "disconnected-first-seen"
					: verdict === "idle"
						? "idle-first-seen"
						: "gone-first-seen";
			plan.mark.push({ resourceId, record: { ...record, disconnectedSince: at }, reason });
			continue;
		}
		if (at - record.disconnectedSince < WHIP_GONE_CONFIRM_MS) continue; // still confirming → wait for it to persist

		// Persisted past the confirm window → bill to the last VERIFIED-alive instant, never to `now`. Floor at
		// startedAt+1ms so an established publish always bills the documented minimum of one ceil-minute.
		const endedAt = Math.max(record.lastSeenAt ?? 0, record.startedAt + 1);
		plan.meter.push({
			resourceId,
			org: record.org,
			line: buildWhipMeterLine(resourceId, record.startedAt, endedAt, resolveWhipMeter(record.meter)),
			verdict,
			// With no sighting the window collapses to startedAt+1ms — i.e. the documented 1-minute MINIMUM,
			// not a measurement of how long the session actually ran. Surfaced so the log says so out loud
			// rather than presenting a floor as if it were a duration (#233).
			neverSeenAlive: record.lastSeenAt === undefined,
		});
		plan.drop.push(resourceId);
	}
	return plan;
}

/**
 * #35 — the WHIP orphan sweeper (revenue integrity). A publish whose client tears down cleanly is billed by
 * handleDelete; a publish whose CONTAINER IS EVICTED OR CRASHES never sends that DELETE, so without this
 * sweep its minutes are never billed at all. This is the "or cron" teardown path the resource record was
 * designed for (see WhipResource.meter).
 *
 * SAFE BY CONSTRUCTION:
 *  - idempotent — emitWhipTeardownMeter keys on event_id = resourceId, so a sweep that races a late client
 *    DELETE cannot double-bill.
 *  - fail-open — every emit is best-effort (a metering blip must never throw out of scheduled()).
 *  - inert — no KV binding or unconfigured SFU creds ⇒ a no-op, matching the repo's default-off stance.
 *
 * Bounded per tick (`limit`) so the cron stays well inside its CPU budget; the remainder is swept next tick.
 */
export async function sweepWhipResources(
	env: WhipEnv,
	deps: WhipDeps,
	opts: { limit?: number } = {},
): Promise<{ scanned: number; billed: number; refreshed: number; skipped: number; deferred: number }> {
	// `deferred` = orphans whose usage could NOT be confirmed delivered; their records are kept for retry.
	const stats = { scanned: 0, billed: 0, refreshed: 0, skipped: 0, deferred: 0 };
	const kv = env.RT_MEETING_ORG;
	if (!kv) return stats; // no binding → inert
	let sfu: SfuClient;
	try {
		sfu = deps.sfu(env);
	} catch {
		return stats; // SFU unconfigured (fail-closed) → nothing can be probed, so sweep nothing
	}
	// No billing sink ⇒ nothing this sweep does could be recorded, and dropping records against a dead sink
	// would destroy usage. Stay inert instead.
	if (!isEmitProvisioned(env)) return stats;

	const limit = opts.limit ?? 200;
	// RESUME where the last tick stopped. A sweep that always restarted at the first page would re-probe the
	// same head of the keyspace every tick, so with more than `limit` live sessions the tail would NEVER be
	// swept and its orphaned minutes would never bill — the very leak this exists to close.
	let cursor = (await kv.get(WHIP_SWEEP_CURSOR_KEY)) ?? undefined;
	// Bound on keys EXAMINED, not on records successfully loaded: counting only valid records would let a run
	// of corrupt/foreign keys enumerate the whole namespace without ever hitting the limit.
	let examined = 0;
	let listComplete = false;

	do {
		const page = await kv.list({ prefix: WHIP_KV_PREFIX, cursor });
		const entries: WhipSweepEntry[] = [];
		for (const { name } of page.keys) {
			if (examined >= limit) break;
			examined++;
			const resourceId = name.slice(WHIP_KV_PREFIX.length);
			if (!RESOURCE_ID.test(resourceId)) continue; // ignore anything that is not a resource record
			const record = await loadResource(kv, resourceId);
			if (!record) continue; // absent/corrupt → nothing to bill
			stats.scanned++;
			// Stamp BEFORE the probe: a conservative timestamp can only under-credit liveness, never invent it.
			const observedAt = deps.now();
			// A probe failure must never abort the sweep — treat it as "unknown" and move on.
			let verdict: WhipSweepEntry["verdict"];
			try {
				verdict = await sfu.sessionLiveness(record.sessionId);
			} catch {
				verdict = "unknown";
			}
			entries.push({ resourceId, record, verdict, observedAt });
		}

		const plan = planWhipSweep(entries, deps.now());
		stats.skipped += entries.length - plan.refresh.length - plan.meter.length - plan.mark.length;

		// Bill the orphans FIRST (while org/startedAt/meter are still in hand), and DROP ONLY WHAT WAS ACCEPTED.
		// An unconfirmed emit leaves the record in place so the next tick retries it; that retry is safe because
		// the emit is idempotent on event_id = resourceId.
		for (const { resourceId, org, line, verdict, neverSeenAlive } of plan.meter) {
			// Say WHY, before acting. The sweep used to report only what it did ({"billed":1}), so a session
			// billed a flat minute and destroyed looked identical in the logs to a correct orphan sweep —
			// which is how #233 stayed invisible until the quantities were traced by hand. An irreversible
			// billing decision must state its own reasoning.
			console.log(
				JSON.stringify({
					msg: "whip-sweep-orphan",
					resourceId,
					verdict,
					neverSeenAlive,
					meter: line.meter,
					minutes: line.meter_value,
				}),
			);
			const delivered = await deliverWhipTeardownMeter(env, org, line, deps.fetch);
			if (!delivered) {
				stats.deferred++;
				continue; // keep the record — it is the ONLY remaining evidence of this session's usage
			}
			stats.billed++;
			try {
				await kv.delete(`${WHIP_KV_PREFIX}${resourceId}`);
			} catch (e) {
				console.warn(`whip-sweep drop failed resourceId=${resourceId}: ${(e as Error)?.message ?? e}`);
			}
		}
		// #240 — persist disconnect-stamp writes (first-410 stamp / 200-recovery clear) on a DISJOINT set of
		// resources from refresh/drop. NOT counted as refreshed (not live sightings); each logs its reason so
		// the sweep never presents a pending-close or a recovery as an alive session (#233 truthful-logging).
		for (const { resourceId, record, reason } of plan.mark) {
			try {
				await kv.put(`${WHIP_KV_PREFIX}${resourceId}`, JSON.stringify(record), {
					expirationTtl: WHIP_KV_TTL_SECONDS,
				});
				console.log(JSON.stringify({ msg: "whip-sweep-mark", resourceId, reason }));
			} catch (e) {
				console.warn(`whip-sweep mark failed resourceId=${resourceId}: ${(e as Error)?.message ?? e}`);
			}
		}
		// Persist refreshed sightings (preserving the original TTL window).
		for (const { resourceId, record } of plan.refresh) {
			try {
				await kv.put(`${WHIP_KV_PREFIX}${resourceId}`, JSON.stringify(record), {
					expirationTtl: WHIP_KV_TTL_SECONDS,
				});
				stats.refreshed++;
			} catch (e) {
				console.warn(`whip-sweep refresh failed resourceId=${resourceId}: ${(e as Error)?.message ?? e}`);
			}
		}
		listComplete = page.list_complete;
		cursor = page.list_complete ? undefined : page.cursor;
	} while (cursor && examined < limit);

	// Park the cursor for the next tick; clear it once a full pass has wrapped so the next sweep starts fresh.
	try {
		if (listComplete || !cursor) await kv.delete(WHIP_SWEEP_CURSOR_KEY);
		else await kv.put(WHIP_SWEEP_CURSOR_KEY, cursor, { expirationTtl: WHIP_KV_TTL_SECONDS });
	} catch (e) {
		console.warn(`whip-sweep cursor persist failed: ${(e as Error)?.message ?? e}`);
	}

	if (stats.billed > 0 || stats.scanned > 0) {
		console.log(JSON.stringify({ msg: "whip-sweep", ...stats }));
	}
	return stats;
}
