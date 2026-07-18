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
	type WhipKv,
	type WhipSweepEntry,
} from "../src/whip";

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
		expect(plan).toEqual({ refresh: [], meter: [], drop: [] });
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
