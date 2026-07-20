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
 * #240 — how long a session must CONTINUOUSLY answer 410 Gone (PeerConnection disconnected) before the sweeper
 * treats it as a dead orphan and bills+drops it. Deliberately just UNDER the 5-min sweep interval so a 410 seen
 * on two consecutive sweeps confirms, while a transient ICE disconnect that recovers by the next sweep (answers
 * 200 in between → stamp cleared) never bills. A single 410 is NOT proof of death: unlike a 404, CF also emits
 * 410 for a recoverable ICE `disconnected` blip. Under-confirming (waiting a sweep) only delays revenue; over-
 * eager billing forfeits a live session's WHOLE bill (its later teardown DELETE finds no record → 204, no usage).
 */
const WHIP_GONE_CONFIRM_MS = 4 * 60_000; // 4 min (< the */5 sweep interval → requires two consecutive 410 sweeps)

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
	 * #240 — record writebacks that are NOT alive-refreshes: stamping `disconnectedSince` on a first 410. Kept a
	 * separate bucket (not `refresh`) so the sweep log counts them honestly and never reports a disconnect-stamp
	 * as a live sighting (#233 truthful-logging). The disconnect stamp is only ever CLEARED via an "alive"
	 * refresh now (#240 Phase-2 flap fix); an idle 200 no longer clears it, so there is no "reconnected" mark.
	 */
	mark: { resourceId: string; record: WhipResource; reason: "disconnected-first-seen" }[];
}

/**
 * #35 — decide, PURELY, what to do with each probed WHIP resource. No I/O, so the billing rules are
 * unit-testable in isolation (mirrors buildWhipMeterLine's pure-accounting stance).
 *
 * The verdicts map to deliberately asymmetric actions, because this is a BILLING boundary:
 *  - "alive"   → refresh lastSeenAt to `now`. We just verified it, so it is safe to bill up to here later.
 *  - "gone"    → bill `startedAt → lastSeenAt` and drop. NEVER bill to `now`: the publisher died at some
 *                unknown point since the last verified sighting, so billing to sweep-time would charge for
 *                dead air. Under-billing by at most one sweep interval is the correct error direction.
 *  - "disconnected" (410) → stamp `disconnectedSince` and WAIT. Only bill+drop (exactly like "gone") once the
 *                410 has persisted past WHIP_GONE_CONFIRM_MS; only an "alive" answer (200 + ACTIVE tracks) in
 *                between clears the stamp. This keeps a transient ICE blip from forfeiting a live session's
 *                whole bill (#240) WITHOUT letting an ambiguous 200/idle flap reset the clock forever (#240 P2).
 *  - "idle"    → answered 200 with no ACTIVE tracks: bill only if previously seen alive AND past the grace
 *                window (else survives). Does NOT clear a disconnect stamp — post branch-A a real reconnect
 *                answers "alive", so an idle 200 no longer proves the session recovered (#240 Phase-2 flap fix).
 *  - "unknown" → do NOTHING (no refresh, no bill). Refreshing on an unverified probe would silently inflate
 *                a later orphan bill; billing on it could close a session that is actually live. The record
 *                simply survives to the next tick (and the 24h KV TTL bounds it).
 *
 * The billed window is floored at 1ms so a session that dies before its first successful probe still bills
 * the documented ≥1 ceil-minute for a started publish, rather than silently billing zero.
 */
export function planWhipSweep(entries: WhipSweepEntry[], now: number): WhipSweepPlan {
	const plan: WhipSweepPlan = { refresh: [], meter: [], drop: [], mark: [] };
	for (const { resourceId, record, verdict, observedAt } of entries) {
		const at = observedAt ?? now;
		if (verdict === "unknown") continue; // cannot tell → never act on a guess (any disconnect stamp survives)
		if (verdict === "alive") {
			// Stamp the instant THIS session was probed, never the page-wide `now` (see WhipSweepEntry.observedAt).
			// Verified live ⇒ clear any pending disconnect stamp (the session recovered; JSON.stringify drops it).
			plan.refresh.push({ resourceId, record: { ...record, lastSeenAt: at, disconnectedSince: undefined } });
			continue;
		}
		if (verdict === "disconnected") {
			// #240 — 410 Gone: the PeerConnection is disconnected. Unlike 404 this is NOT proven terminal (a
			// transient ICE drop can 410 then recover), so a single 410 may NOT bill+drop — that would forfeit a
			// live session's whole bill (its later teardown DELETE would find no record → 204, no usage). Stamp
			// the first 410 and wait; only once it PERSISTS past the confirm window (a recovered blip would have
			// answered 200 in between and cleared the stamp) does it bill exactly like a "gone" session.
			if (record.disconnectedSince === undefined) {
				plan.mark.push({ resourceId, record: { ...record, disconnectedSince: at }, reason: "disconnected-first-seen" });
				continue;
			}
			if (at - record.disconnectedSince < WHIP_GONE_CONFIRM_MS) continue; // still within the confirm window
			// else: confirmed persistently disconnected → fall through to the "gone" billing path.
		}
		if (verdict === "idle") {
			// An "idle" verdict means the SFU answered 200 but listed no ACTIVE tracks. For THIS surface it is
			// not evidence of anything on its own — and, post branch-A, it must NEVER clear a pending 410 stamp.
			//
			// GROUND TRUTH (2026-07-19): the old direct path `sfu.newSession(offer)` never called pushTracks, so
			// a perfectly healthy publish answered `{"tracks":[]}` for its ENTIRE life. The old rule billed that
			// healthy session as an orphan past the grace window and — worse — DROPPED its KV record, disarming
			// the real teardown meter (later DELETE → 204, no usage): a flat 1 minute for a 14.5-min broadcast (#233).
			// So an idle verdict may only age into a bill for a session ACTUALLY observed alive at least once;
			// with no sighting the tracks array tells us nothing (the "unknown" case: no refresh, no bill, survive).
			//
			// #240 Phase-2 (2026-07-20, proven live): a CRASHED branch-A orphan's SFU flaps 410 ↔ 200-idle. The
			// old code cleared `disconnectedSince` on every idle ("reconnected"), which RESET the 4-min confirm
			// clock each sweep → the dead orphan never billed. That clear was reconnect-protection, but it is now
			// REDUNDANT AND HARMFUL: branch-A registers local tracks (whip.ts pushTracks), so a genuinely
			// recovered publisher answers "alive" (200 + active tracks) and clears the stamp above (line ~145).
			// An "idle" answer no longer proves liveness, so it leaves any 410 stamp intact to ripen into a bill.
			if (record.lastSeenAt === undefined) continue; // never seen alive → idle proves nothing; survive (stamp, if any, persists)
			// Below the grace window an empty track list is normal mid-negotiation, so leave it alone.
			// CRITICALLY, an idle session is NEVER refreshed: bumping lastSeenAt here would silently convert
			// dead air into billable minutes, since the session can sit idle indefinitely. The disconnect stamp
			// is intentionally NOT cleared here either — only "alive" clears it.
			if (at - record.startedAt <= WHIP_IDLE_GRACE_MS) continue;
			// else: fall through and bill it exactly like a "gone" session.
		}
		// "gone": bill to the last VERIFIED-alive instant, never to `now`. Floor at startedAt+1ms so an
		// established publish always bills the documented minimum of one ceil-minute.
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

		// #261 — one structured verdict line PER scanned resource, not only the billed/marked ones. The sweep
		// previously logged an orphan-bill (whip-sweep-orphan) and a disconnect-stamp (whip-sweep-mark) but was
		// SILENT for the refresh/skip majority, so a session that was refreshed, held idle, or judged "unknown"
		// left no trace at all — which is precisely how #240's mis-billing hid through two misdiagnoses (the
		// only visible signal was an aggregate {billed:N}). This makes every verdict directly observable. It is
		// bounded by the per-tick `examined` limit (entries never exceeds it) and carries the two fields the
		// billing decision actually turns on — lastSeenAt and the #240 disconnectedSince stamp. `action` mirrors
		// which plan bucket the resource landed in; keep it in sync with the buckets planWhipSweep returns.
		const meterIds = new Set(plan.meter.map((m) => m.resourceId));
		const markIds = new Set(plan.mark.map((m) => m.resourceId));
		const refreshIds = new Set(plan.refresh.map((r) => r.resourceId));
		for (const { resourceId, record, verdict } of entries) {
			const action = meterIds.has(resourceId)
				? "bill"
				: markIds.has(resourceId)
					? "mark"
					: refreshIds.has(resourceId)
						? "refresh"
						: "skip";
			console.log(
				JSON.stringify({
					msg: "whip-sweep-verdict",
					resourceId,
					verdict,
					lastSeenAt: record.lastSeenAt,
					disconnectedSince: record.disconnectedSince,
					action,
				}),
			);
		}

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
