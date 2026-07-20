// #35 — WHIP orphan sweeper (revenue integrity). A publish torn down cleanly bills via handleDelete; a
// publish whose CONTAINER IS EVICTED never sends that DELETE, so these tests pin the cron path that bills it.
//
// The rules under test are deliberately asymmetric because this is a BILLING boundary:
//   alive   → refresh lastSeenAt (a verified sighting we may later bill up to)
//   gone    → bill startedAt→lastSeenAt (NEVER →now: that would charge for dead air), then drop
//   unknown → do nothing at all (never bill on a guess, never close a possibly-live session)
import { describe, expect, it } from "vitest";
import {
	planWhipSweep,
	sweepWhipResources,
	whipSweepEnabled,
	WHIP_SWEEP_CRON,
	type WhipSweepEntry,
} from "../src/whip-sweep";
import type { WhipKv } from "../src/whip";

const ORG = "18e9224a-0e81-4c05-a336-5b9cb118d48a";
const START = 1_700_000_000_000;
const MIN = 60_000;

function entry(over: Partial<WhipSweepEntry> & { verdict: WhipSweepEntry["verdict"] }): WhipSweepEntry {
	return {
		resourceId: over.resourceId ?? "res00000abc",
		record: { sessionId: "s".repeat(32), org: ORG, startedAt: START, ...over.record },
		verdict: over.verdict,
		observedAt: over.observedAt ?? START,
	};
}

describe("planWhipSweep — billing rules", () => {
	it("bills a gone session to lastSeenAt, NOT to sweep-time (never charges for dead air)", () => {
		// Session verified alive at +3min; swept at +60min. The publisher died somewhere after +3min, so the
		// only defensible bill is 3 minutes — billing to `now` would invent 57 minutes of dead air.
		const plan = planWhipSweep(
			[entry({ verdict: "gone", record: { lastSeenAt: START + 3 * MIN } as never })],
			START + 60 * MIN,
		);
		expect(plan.meter).toHaveLength(1);
		expect(plan.meter[0].line.meter_value).toBe(3);
		expect(plan.meter[0].org).toBe(ORG);
		expect(plan.drop).toEqual(["res00000abc"]);
		expect(plan.refresh).toHaveLength(0);
	});

	it("bills a gone session that was never probed the documented >=1 ceil-minute (not zero)", () => {
		// No lastSeenAt: the publish died before its first sweep. The window is floored at 1ms so an
		// established publish still bills the documented minimum rather than silently billing nothing.
		const plan = planWhipSweep([entry({ verdict: "gone" })], START + 60 * MIN);
		expect(plan.meter[0].line.meter_value).toBe(1);
	});

	it("uses resourceId as the idempotency key so a sweep cannot double-bill a racing client DELETE", () => {
		const plan = planWhipSweep([entry({ verdict: "gone", resourceId: "abc12345xyz" })], START + MIN);
		expect(plan.meter[0].line.event_id).toBe("abc12345xyz");
	});

	it("refreshes lastSeenAt to the session's OWN probe time, not the page-wide sweep clock", () => {
		// observedAt is stamped just before this session's probe; the page-wide `now` is later because other
		// sessions were probed in between. Crediting `now` would bill liveness that was never observed.
		const observedAt = START + 7 * MIN;
		const plan = planWhipSweep([entry({ verdict: "alive", observedAt })], START + 30 * MIN);
		expect(plan.meter).toHaveLength(0);
		expect(plan.drop).toHaveLength(0);
		expect(plan.refresh[0].record.lastSeenAt).toBe(observedAt);
	});

	it("does NOTHING on an unknown verdict — no bill, no drop, and no unverified lastSeenAt refresh", () => {
		// Refreshing here would silently inflate a LATER orphan bill with time we never actually verified.
		const plan = planWhipSweep([entry({ verdict: "unknown" })], START + 9 * MIN);
		expect(plan).toEqual({ refresh: [], meter: [], drop: [], mark: [] });
	});

	// LIVE-OBSERVED (#35, 2026-07-18): when a publisher dies without a teardown, CF Realtime does NOT 404 the
	// session — it keeps answering 200 with `tracks: []`, still doing so 35 minutes later. Treating that as
	// "alive" refreshed the orphan forever and NEVER billed it, defeating the whole sweeper.
	it("bills an idle (zero-track) session once past the grace window — CF never 404s these", () => {
		const observedAt = START + 20 * MIN;
		const plan = planWhipSweep(
			[entry({ verdict: "idle", observedAt, record: { lastSeenAt: START + 4 * MIN } as never })],
			observedAt,
		);
		expect(plan.meter).toHaveLength(1);
		expect(plan.meter[0].line.meter_value).toBe(4); // billed to the last VERIFIED sighting, not to now
		expect(plan.drop).toEqual(["res00000abc"]);
	});

	it("leaves a freshly-published zero-track session completely alone (mid-negotiation)", () => {
		// Within the grace window an empty track list is normal negotiation, so it must not be billed —
		// and must NOT be refreshed either, or dead air would later be billed as real.
		const observedAt = START + 30_000; // 30s old
		const plan = planWhipSweep([entry({ verdict: "idle", observedAt })], observedAt);
		expect(plan).toEqual({ refresh: [], meter: [], drop: [], mark: [] });
	});

	it("NEVER refreshes lastSeenAt on an idle session (that pollution would bill dead air)", () => {
		// A session can sit idle indefinitely; bumping lastSeenAt each tick would silently convert every
		// idle minute into a billable one. This is the regression that made the first live proof overbill.
		const observedAt = START + 50 * MIN;
		const plan = planWhipSweep(
			[entry({ verdict: "idle", observedAt, record: { lastSeenAt: START + 2 * MIN } as never })],
			observedAt,
		);
		expect(plan.refresh).toHaveLength(0);
		expect(plan.meter[0].line.meter_value).toBe(2); // still only the 2 verified minutes
	});

	it("carries the sealed per-session meter SKU onto the orphan bill (bridge vs bare WHIP)", () => {
		const plan = planWhipSweep(
			[entry({ verdict: "gone", record: { meter: "wave_stream_bridge_minutes" } as never })],
			START + 2 * MIN,
		);
		expect(plan.meter[0].line.meter).toBe("wave_stream_bridge_minutes");
	});

	it("rejects an unknown meter override, falling back to the default WHIP SKU (allowset holds)", () => {
		const plan = planWhipSweep(
			[entry({ verdict: "gone", record: { meter: "wave_free_money" } as never })],
			START + 2 * MIN,
		);
		expect(plan.meter[0].line.meter).toBe("wave_whip_ingest_minutes");
	});
});

describe("planWhipSweep — #240 disconnected (410) confirmation gate", () => {
	it("a first 410 stamps disconnectedSince and does NOT bill or drop", () => {
		const observedAt = START + 5 * MIN;
		const plan = planWhipSweep([entry({ verdict: "disconnected", observedAt })], observedAt);
		expect(plan.meter).toHaveLength(0);
		expect(plan.drop).toHaveLength(0);
		expect(plan.refresh).toHaveLength(0);
		expect(plan.mark).toHaveLength(1);
		expect(plan.mark[0].reason).toBe("disconnected-first-seen");
		expect(plan.mark[0].record.disconnectedSince).toBe(observedAt);
	});

	it("a 410 still within the confirm window does nothing (waits for it to persist)", () => {
		const firstSeen = START + 5 * MIN;
		const observedAt = firstSeen + 3 * MIN; // < the 4-min confirm window
		const plan = planWhipSweep(
			[entry({ verdict: "disconnected", observedAt, record: { disconnectedSince: firstSeen } as never })],
			observedAt,
		);
		expect(plan).toEqual({ refresh: [], meter: [], drop: [], mark: [] });
	});

	it("a 410 persisted past the confirm window bills+drops exactly like gone", () => {
		const firstSeen = START + 5 * MIN;
		const observedAt = firstSeen + 5 * MIN; // >= the 4-min confirm window
		const plan = planWhipSweep(
			[entry({ verdict: "disconnected", observedAt, record: { disconnectedSince: firstSeen, lastSeenAt: START + 2 * MIN } as never })],
			observedAt,
		);
		expect(plan.meter).toHaveLength(1);
		expect(plan.meter[0].verdict).toBe("disconnected");
		expect(plan.meter[0].line.meter_value).toBe(2); // to the last VERIFIED sighting, never sweep-time
		expect(plan.drop).toEqual(["res00000abc"]);
		expect(plan.mark).toHaveLength(0);
	});

	it("a persisted 410 never seen alive bills the 1-min floor with neverSeenAlive", () => {
		const firstSeen = START + 5 * MIN;
		const observedAt = firstSeen + 10 * MIN;
		const plan = planWhipSweep(
			[entry({ verdict: "disconnected", observedAt, record: { disconnectedSince: firstSeen } as never })],
			observedAt,
		);
		expect(plan.meter[0].line.meter_value).toBe(1);
		expect(plan.meter[0].neverSeenAlive).toBe(true);
		expect(plan.drop).toEqual(["res00000abc"]);
	});

	it("an alive verdict clears a pending disconnect stamp (recovered)", () => {
		const observedAt = START + 8 * MIN;
		const plan = planWhipSweep(
			[entry({ verdict: "alive", observedAt, record: { disconnectedSince: START + 5 * MIN } as never })],
			observedAt,
		);
		expect(plan.refresh).toHaveLength(1);
		expect(plan.refresh[0].record.disconnectedSince).toBeUndefined();
		expect(plan.refresh[0].record.lastSeenAt).toBe(observedAt);
		expect(plan.meter).toHaveLength(0);
	});

	it("an idle (200) answer clears a pending disconnect stamp without billing", () => {
		const observedAt = START + 8 * MIN;
		const plan = planWhipSweep(
			[entry({ verdict: "idle", observedAt, record: { disconnectedSince: START + 5 * MIN } as never })],
			observedAt,
		);
		expect(plan.meter).toHaveLength(0);
		expect(plan.drop).toHaveLength(0);
		expect(plan.mark).toHaveLength(1);
		expect(plan.mark[0].reason).toBe("reconnected");
		expect(plan.mark[0].record.disconnectedSince).toBeUndefined();
	});

	it("an unknown verdict leaves a pending disconnect stamp intact (never erased on a guess)", () => {
		const plan = planWhipSweep(
			[entry({ verdict: "unknown", record: { disconnectedSince: START + 5 * MIN } as never })],
			START + 9 * MIN,
		);
		expect(plan).toEqual({ refresh: [], meter: [], drop: [], mark: [] });
	});

	it("an aged-out idle with a stale disconnect stamp bills+drops and does NOT also mark (no put/delete race)", () => {
		const observedAt = START + 30 * MIN;
		const plan = planWhipSweep(
			[entry({ verdict: "idle", observedAt, record: { lastSeenAt: START + 6 * MIN, disconnectedSince: START + 5 * MIN } as never })],
			observedAt,
		);
		expect(plan.meter).toHaveLength(1);
		expect(plan.drop).toEqual(["res00000abc"]);
		expect(plan.mark).toHaveLength(0);
	});
});

// #233 — the sweeper billed LIVE sessions a flat minute and destroyed their records.
//
// GROUND TRUTH (live probe, 2026-07-19): a WHIP publish is created with `newSession(offer)` and never
// calls pushTracks, so the SFU registers no tracks and answers `{"tracks":[]}` for the ENTIRE life of a
// healthy publish — confirmed against a session that was actively bridging media when probed. Every WHIP
// session therefore looks "idle" forever, and the old rule billed each one as an orphan the moment it aged
// past the grace window. The bill was `startedAt→startedAt+1ms` = 1 flat minute (lastSeenAt is only ever
// written on an "alive" verdict, which this API can never produce here), and the record was then DROPPED —
// so the real client DELETE found nothing and returned 204 with NO usage at all.
//
// Measured live: a 14.5-minute broadcast billed 1 minute. Not bridge-specific — it is the shared WHIP path.
describe("planWhipSweep — an idle verdict alone must never bill a live session (#233)", () => {
	it("does NOT bill a never-seen-alive idle session, however old it gets", () => {
		// The exact production shape: no lastSeenAt (no "alive" verdict is reachable for a WHIP session),
		// long past the grace window, media still flowing. The old code billed 1 minute and dropped it.
		const observedAt = START + 45 * MIN;
		const plan = planWhipSweep([entry({ verdict: "idle", observedAt })], observedAt);
		expect(plan).toEqual({ refresh: [], meter: [], drop: [], mark: [] });
	});

	it("above all does not DROP that record — dropping is what disarms the real teardown meter", () => {
		// The irreversible half. Billing 1 minute is a wrong number; destroying the record means the
		// correct number can never be billed by anyone, because handleDelete needs the record to exist.
		const observedAt = START + 45 * MIN;
		const plan = planWhipSweep([entry({ verdict: "idle", observedAt })], observedAt);
		expect(plan.drop).toHaveLength(0);
	});

	it("still bills an idle session that WAS once observed alive (the real orphan case survives)", () => {
		// The sweeper must not be neutered: a verified sighting makes the tracks array meaningful again,
		// so a genuine orphan still bills — to its last verified instant, exactly as before.
		const observedAt = START + 45 * MIN;
		const plan = planWhipSweep(
			[entry({ verdict: "idle", observedAt, record: { lastSeenAt: START + 6 * MIN } as never })],
			observedAt,
		);
		expect(plan.meter).toHaveLength(1);
		expect(plan.meter[0].line.meter_value).toBe(6);
		expect(plan.drop).toEqual(["res00000abc"]);
	});

	it("still bills a GONE session with no sighting — 404/all-inactive is real evidence of death", () => {
		// "gone" is a positive death signal (the SFU forgot the session, or every track went inactive),
		// unlike "idle" which for this surface is no signal at all. That path is deliberately untouched.
		const plan = planWhipSweep([entry({ verdict: "gone" })], START + 60 * MIN);
		expect(plan.meter).toHaveLength(1);
		expect(plan.meter[0].line.meter_value).toBe(1);
	});

	it("flags a bill computed with no sighting as neverSeenAlive, so the log states it is a floor", () => {
		// 1 minute here is the documented MINIMUM for a started publish, not a measurement of duration.
		// Reporting only `billed:1` is what let this hide: it read identically to a correct orphan sweep.
		const plan = planWhipSweep([entry({ verdict: "gone" })], START + 60 * MIN);
		expect(plan.meter[0].neverSeenAlive).toBe(true);
		expect(plan.meter[0].verdict).toBe("gone");
	});

	it("does not flag a bill backed by a real sighting", () => {
		const plan = planWhipSweep(
			[entry({ verdict: "gone", record: { lastSeenAt: START + 3 * MIN } as never })],
			START + 60 * MIN,
		);
		expect(plan.meter[0].neverSeenAlive).toBe(false);
	});
});

/** In-memory KV implementing the full WhipKv surface, seeded with `whip:`-prefixed records. */
function memKv(seed: Record<string, unknown> = {}): WhipKv & { store: Map<string, string> } {
	const store = new Map<string, string>();
	for (const [k, v] of Object.entries(seed)) store.set(k, JSON.stringify(v));
	return {
		store,
		async list({ prefix = "" } = {}) {
			const keys = [...store.keys()].filter((n) => n.startsWith(prefix)).map((name) => ({ name }));
			return { keys, list_complete: true };
		},
		async get(k) {
			return store.get(k) ?? null;
		},
		async put(k, v) {
			store.set(k, v);
		},
		async delete(k) {
			store.delete(k);
		},
	};
}

/** Deps whose SFU returns a fixed verdict, recording every usage emit the sweeper makes. */
function depsFor(verdict: "alive" | "gone" | "unknown", now: number, emits: unknown[]) {
	return {
		sfu: () => ({ sessionLiveness: async () => verdict }) as never,
		now: () => now,
		mintResourceId: () => "unused",
		fetch: (async (_url: string, init?: RequestInit) => {
			emits.push(JSON.parse(String(init?.body ?? "{}")));
			return new Response(null, { status: 202 });
		}) as unknown as typeof fetch,
	};
}

const PROVISIONED = { GATEWAY_BASE_URL: "https://api.wave.online", WAVE_SERVICE_TOKEN: "t", CF_CALLS_APP_ID: "a", CF_CALLS_APP_SECRET: "s" };

describe("sweepWhipResources — applying the plan", () => {
	it("bills and drops an orphaned record, emitting the sealed bridge SKU to the gateway", async () => {
		const kv = memKv({
			"whip:res00000abc": { sessionId: "s".repeat(32), org: ORG, startedAt: START, lastSeenAt: START + 2 * MIN, meter: "wave_stream_bridge_minutes" },
		});
		const emits: unknown[] = [];
		const stats = await sweepWhipResources({ ...PROVISIONED, RT_MEETING_ORG: kv } as never, depsFor("gone", START + 30 * MIN, emits) as never);

		expect(stats.billed).toBe(1);
		expect(emits).toHaveLength(1);
		expect(emits[0]).toMatchObject({ org: ORG, usage: { meter: "wave_stream_bridge_minutes", meter_value: 2, event_id: "res00000abc" } });
		// Record dropped, so a later client DELETE is the idempotent 204 no-op rather than a second bill.
		expect(kv.store.has("whip:res00000abc")).toBe(false);
	});

	it("leaves a live session billed-nothing and persists the refreshed sighting", async () => {
		const kv = memKv({ "whip:res00000abc": { sessionId: "s".repeat(32), org: ORG, startedAt: START } });
		const emits: unknown[] = [];
		const now = START + 5 * MIN;
		const stats = await sweepWhipResources({ ...PROVISIONED, RT_MEETING_ORG: kv } as never, depsFor("alive", now, emits) as never);

		expect(stats.billed).toBe(0);
		expect(stats.refreshed).toBe(1);
		expect(emits).toHaveLength(0);
		expect(JSON.parse(kv.store.get("whip:res00000abc")!).lastSeenAt).toBe(now);
	});

	it("never bills or drops on an unknown verdict — the record survives to the next tick", async () => {
		const kv = memKv({ "whip:res00000abc": { sessionId: "s".repeat(32), org: ORG, startedAt: START } });
		const emits: unknown[] = [];
		const stats = await sweepWhipResources({ ...PROVISIONED, RT_MEETING_ORG: kv } as never, depsFor("unknown", START + 5 * MIN, emits) as never);

		expect(stats.billed).toBe(0);
		expect(stats.skipped).toBe(1);
		expect(emits).toHaveLength(0);
		expect(kv.store.has("whip:res00000abc")).toBe(true);
	});

	it("ignores non-resource keys sharing the namespace", async () => {
		const kv = memKv({ "whip:!!bad": { sessionId: "s".repeat(32), org: ORG, startedAt: START } });
		const emits: unknown[] = [];
		const stats = await sweepWhipResources({ ...PROVISIONED, RT_MEETING_ORG: kv } as never, depsFor("gone", START + MIN, emits) as never);
		expect(stats.scanned).toBe(0);
		expect(emits).toHaveLength(0);
	});

	it("is inert with no KV binding (no throw, nothing billed)", async () => {
		const emits: unknown[] = [];
		const stats = await sweepWhipResources({ ...PROVISIONED } as never, depsFor("gone", START, emits) as never);
		expect(stats).toEqual({ scanned: 0, billed: 0, refreshed: 0, skipped: 0, deferred: 0 });
	});

	it("is inert when the SFU is unconfigured (fail-closed: probe nothing rather than guess)", async () => {
		const kv = memKv({ "whip:res00000abc": { sessionId: "s".repeat(32), org: ORG, startedAt: START } });
		const emits: unknown[] = [];
		const throwingDeps = { ...depsFor("gone", START, emits), sfu: () => { throw new Error("unconfigured"); } };
		const stats = await sweepWhipResources({ ...PROVISIONED, RT_MEETING_ORG: kv } as never, throwingDeps as never);
		expect(stats.billed).toBe(0);
		expect(kv.store.has("whip:res00000abc")).toBe(true);
	});
});

describe("sweepWhipResources — usage is never destroyed", () => {
	/** Deps whose usage emit FAILS (gateway down), so the sweeper must not drop the evidence. */
	function failingDeps(now: number, attempts: unknown[]) {
		return {
			sfu: () => ({ sessionLiveness: async () => "gone" }) as never,
			now: () => now,
			mintResourceId: () => "unused",
			fetch: (async (_url: string, init?: RequestInit) => {
				attempts.push(JSON.parse(String(init?.body ?? "{}")));
				return new Response("upstream down", { status: 503 });
			}) as unknown as typeof fetch,
		};
	}

	it("KEEPS an orphan record when the usage emit is not confirmed, so the next tick retries", async () => {
		// The regression that matters: emitting fail-open and deleting anyway would lose these minutes
		// forever — reintroducing the exact revenue leak this sweeper exists to close.
		const kv = memKv({ "whip:res00000abc": { sessionId: "s".repeat(32), org: ORG, startedAt: START } });
		const attempts: unknown[] = [];
		const stats = await sweepWhipResources(
			{ ...PROVISIONED, RT_MEETING_ORG: kv } as never,
			failingDeps(START + 10 * MIN, attempts) as never,
		);

		expect(attempts).toHaveLength(1); // it did try
		expect(stats.billed).toBe(0);
		expect(stats.deferred).toBe(1);
		expect(kv.store.has("whip:res00000abc")).toBe(true); // evidence preserved for retry
	});

	it("is inert without a billing sink rather than dropping records against a dead sink", async () => {
		const kv = memKv({ "whip:res00000abc": { sessionId: "s".repeat(32), org: ORG, startedAt: START } });
		const emits: unknown[] = [];
		// No GATEWAY_BASE_URL / WAVE_SERVICE_TOKEN → nothing can be recorded.
		const stats = await sweepWhipResources(
			{ CF_CALLS_APP_ID: "a", CF_CALLS_APP_SECRET: "s", RT_MEETING_ORG: kv } as never,
			depsFor("gone", START + MIN, emits) as never,
		);
		expect(stats.billed).toBe(0);
		expect(emits).toHaveLength(0);
		expect(kv.store.has("whip:res00000abc")).toBe(true);
	});

	it("stamps each live sighting at ITS OWN probe time, not one page-wide timestamp", async () => {
		// A page of probes takes real time; a single post-loop `now` would credit the first session with
		// liveness it was never observed to have, and that inflated lastSeenAt would later be billed.
		const kv = memKv({
			"whip:resaaaaaaaa": { sessionId: "a".repeat(32), org: ORG, startedAt: START },
			"whip:resbbbbbbbb": { sessionId: "b".repeat(32), org: ORG, startedAt: START },
		});
		let tick = START;
		const deps = {
			sfu: () => ({ sessionLiveness: async () => "alive" }) as never,
			now: () => (tick += MIN), // clock advances on every read, as a real probe loop would
			mintResourceId: () => "unused",
			fetch: (async () => new Response(null, { status: 202 })) as unknown as typeof fetch,
		};
		await sweepWhipResources({ ...PROVISIONED, RT_MEETING_ORG: kv } as never, deps as never);

		const seenA = JSON.parse(kv.store.get("whip:resaaaaaaaa")!).lastSeenAt;
		const seenB = JSON.parse(kv.store.get("whip:resbbbbbbbb")!).lastSeenAt;
		expect(seenA).not.toBe(seenB); // distinct per-probe stamps, not one shared value
	});

	it("parks a pagination cursor so a later page cannot starve, and clears it when the pass wraps", async () => {
		const kv = memKv({ "whip:res00000abc": { sessionId: "s".repeat(32), org: ORG, startedAt: START } });
		const emits: unknown[] = [];
		await sweepWhipResources({ ...PROVISIONED, RT_MEETING_ORG: kv } as never, depsFor("alive", START + MIN, emits) as never);
		// This stub returns list_complete on the first page, so a full pass wrapped → no stale cursor parked.
		expect(kv.store.has("whipsweep:cursor")).toBe(false);
	});

	it("does not enumerate its own cursor bookkeeping as a resource record", async () => {
		const kv = memKv({ "whip:res00000abc": { sessionId: "s".repeat(32), org: ORG, startedAt: START } });
		kv.store.set("whipsweep:cursor", "somecursor");
		const emits: unknown[] = [];
		const stats = await sweepWhipResources({ ...PROVISIONED, RT_MEETING_ORG: kv } as never, depsFor("gone", START + MIN, emits) as never);
		expect(stats.scanned).toBe(1); // only the real record, never the cursor key
	});
});

describe("sweeper arming", () => {
	it("is default-off and arms only on an explicit truthy flag", () => {
		expect(whipSweepEnabled({})).toBe(false);
		expect(whipSweepEnabled({ WHIP_SWEEP_ENABLED: "0" })).toBe(false);
		expect(whipSweepEnabled({ WHIP_SWEEP_ENABLED: "1" })).toBe(true);
		expect(whipSweepEnabled({ WHIP_SWEEP_ENABLED: true })).toBe(true);
	});

	it("pins the sweep cron to the wrangler.toml trigger it is compared against", () => {
		// scheduledHandler gates the fifteen-minute reconciles by comparing event.cron to this exact string.
		expect(WHIP_SWEEP_CRON).toBe("*/5 * * * *");
	});
});
