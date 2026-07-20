// #257 — the confirm window that #240 built for 410 now guards EVERY death signal (404/all-inactive "gone" and
// aged once-alive "idle" too). The failure it closes is uniform: bill+drop deletes the KV record, so a session
// billed on a transient death can never be billed correctly by its real teardown (DELETE → 204, no usage). No
// single probe may bill; a death must persist across a sweep, and an "alive" answer in between rescues it.
//
// Split out of whip-sweep.test.ts (non-behavioral test-file refactor) — same assertions, relocated.
import { describe, expect, it } from "vitest";
import { planWhipSweep, sweepWhipResources } from "../src/whip-sweep";
import { ORG, START, MIN, entry, memKv, depsFor, PROVISIONED } from "./whip-sweep-helpers";

describe("planWhipSweep — uniform death confirm gate (#257)", () => {
	it("a first 'gone' (404/all-inactive) MARKS and does NOT bill or drop", () => {
		const observedAt = START + 10 * MIN;
		const plan = planWhipSweep([entry({ verdict: "gone", observedAt })], observedAt);
		expect(plan.meter).toHaveLength(0);
		expect(plan.drop).toHaveLength(0);
		expect(plan.mark).toHaveLength(1);
		expect(plan.mark[0].reason).toBe("gone-first-seen");
		expect(plan.mark[0].record.disconnectedSince).toBe(observedAt);
	});

	it("a first aged once-alive 'idle' MARKS (idle-first-seen) and does NOT bill", () => {
		const observedAt = START + 20 * MIN; // past the 3-min negotiation grace
		const plan = planWhipSweep([entry({ verdict: "idle", observedAt, record: { lastSeenAt: START + 5 * MIN } as never })], observedAt);
		expect(plan.meter).toHaveLength(0);
		expect(plan.mark).toHaveLength(1);
		expect(plan.mark[0].reason).toBe("idle-first-seen");
	});

	it("a 'gone' still within the confirm window keeps waiting (no bill)", () => {
		const firstSeen = START + 5 * MIN;
		const observedAt = firstSeen + 3 * MIN; // < 4-min window
		const plan = planWhipSweep([entry({ verdict: "gone", observedAt, record: { disconnectedSince: firstSeen } as never })], observedAt);
		expect(plan).toEqual({ refresh: [], meter: [], drop: [], mark: [] });
	});

	it("a 'gone' persisted past the confirm window bills+drops", () => {
		const firstSeen = START + 5 * MIN;
		const observedAt = firstSeen + 5 * MIN; // >= 4-min window
		const plan = planWhipSweep(
			[entry({ verdict: "gone", observedAt, record: { disconnectedSince: firstSeen, lastSeenAt: START + 2 * MIN } as never })],
			observedAt,
		);
		expect(plan.meter).toHaveLength(1);
		expect(plan.meter[0].verdict).toBe("gone");
		expect(plan.meter[0].line.meter_value).toBe(2); // to last verified sighting, never sweep-time
		expect(plan.drop).toEqual(["res00000abc"]);
	});

	it("RESCUES a transient 'gone' that recovers to alive within the window — the whole point (no forfeit)", () => {
		const firstSeen = START + 5 * MIN;
		// 1) a first 'gone' stamps and waits
		const p1 = planWhipSweep([entry({ verdict: "gone", observedAt: firstSeen })], firstSeen);
		expect(p1.mark).toHaveLength(1);
		const stamped = p1.mark[0].record; // disconnectedSince = firstSeen
		// 2) an 'alive' sighting 2 min later (still inside the window) CLEARS the stamp and refreshes — never bills
		const recovered = planWhipSweep([entry({ verdict: "alive", observedAt: firstSeen + 2 * MIN, record: stamped as never })], firstSeen + 2 * MIN);
		expect(recovered.meter).toHaveLength(0);
		expect(recovered.drop).toHaveLength(0);
		expect(recovered.refresh).toHaveLength(1);
		expect(recovered.refresh[0].record.disconnectedSince).toBeUndefined();
		// 3) a later 'gone' therefore starts a FRESH clock (no immediate bill) — the session was proven live in between
		const later = planWhipSweep([entry({ verdict: "gone", observedAt: firstSeen + 4 * MIN, record: recovered.refresh[0].record as never })], firstSeen + 4 * MIN);
		expect(later.meter).toHaveLength(0);
		expect(later.mark).toHaveLength(1);
		expect(later.mark[0].record.disconnectedSince).toBe(firstSeen + 4 * MIN); // clock restarted, not carried
	});

	it("RESCUES an aged idle that flaps back to alive within the window", () => {
		const firstSeen = START + 20 * MIN;
		const p1 = planWhipSweep([entry({ verdict: "idle", observedAt: firstSeen, record: { lastSeenAt: START + 5 * MIN } as never })], firstSeen);
		expect(p1.mark).toHaveLength(1);
		expect(p1.mark[0].reason).toBe("idle-first-seen");
		const alive = planWhipSweep([entry({ verdict: "alive", observedAt: firstSeen + 2 * MIN, record: p1.mark[0].record as never })], firstSeen + 2 * MIN);
		expect(alive.meter).toHaveLength(0);
		expect(alive.refresh[0].record.disconnectedSince).toBeUndefined();
	});

	it("does not stamp a fresh publish or a never-seen-alive session (idle preconditions unchanged, #233)", () => {
		// within grace → survive; never-seen-alive → survive. Neither opens a confirm window.
		expect(planWhipSweep([entry({ verdict: "idle", observedAt: START + 30_000 })], START + 30_000)).toEqual({ refresh: [], meter: [], drop: [], mark: [] });
		expect(planWhipSweep([entry({ verdict: "idle", observedAt: START + 45 * MIN })], START + 45 * MIN)).toEqual({ refresh: [], meter: [], drop: [], mark: [] });
	});
});

// #257 end-to-end through the real loader: a crashed publisher's 404 must bill on the SECOND sweep, not the first.
describe("sweepWhipResources — a death bills only after it persists a sweep (#257)", () => {
	it("a 'gone' orphan MARKS on sweep 1 (billed:0, record kept+stamped) then BILLS on sweep 2", async () => {
		const kv = memKv({ "whip:res00000abc": { sessionId: "s".repeat(32), org: ORG, startedAt: START, lastSeenAt: START + 2 * MIN } });
		const emits: unknown[] = [];

		// Sweep 1: first 404 → stamp, do not bill, keep the record.
		const s1 = await sweepWhipResources({ ...PROVISIONED, RT_MEETING_ORG: kv } as never, depsFor("gone", START + 10 * MIN, emits) as never);
		expect(s1.billed).toBe(0);
		expect(emits).toHaveLength(0);
		expect(kv.store.has("whip:res00000abc")).toBe(true);
		expect(JSON.parse(kv.store.get("whip:res00000abc")!).disconnectedSince).toBe(START + 10 * MIN);

		// Sweep 2: still 404, now past the confirm window → bill+drop.
		const s2 = await sweepWhipResources({ ...PROVISIONED, RT_MEETING_ORG: kv } as never, depsFor("gone", START + 20 * MIN, emits) as never);
		expect(s2.billed).toBe(1);
		expect(emits).toHaveLength(1);
		expect(emits[0]).toMatchObject({ usage: { meter_value: 2, event_id: "res00000abc" } });
		expect(kv.store.has("whip:res00000abc")).toBe(false);
	});

	it("a 404 that recovers to alive on sweep 2 is never billed — the live session's bill is preserved", async () => {
		const kv = memKv({ "whip:res00000abc": { sessionId: "s".repeat(32), org: ORG, startedAt: START } });
		const emits: unknown[] = [];

		// Sweep 1: transient 404 → stamp only.
		await sweepWhipResources({ ...PROVISIONED, RT_MEETING_ORG: kv } as never, depsFor("gone", START + 5 * MIN, emits) as never);
		expect(JSON.parse(kv.store.get("whip:res00000abc")!).disconnectedSince).toBe(START + 5 * MIN);

		// Sweep 2: alive again → stamp cleared, refreshed, nothing billed, record intact for its real teardown.
		const s2 = await sweepWhipResources({ ...PROVISIONED, RT_MEETING_ORG: kv } as never, depsFor("alive", START + 8 * MIN, emits) as never);
		expect(s2.billed).toBe(0);
		expect(s2.refreshed).toBe(1);
		expect(emits).toHaveLength(0);
		const rec = JSON.parse(kv.store.get("whip:res00000abc")!);
		expect(rec.disconnectedSince).toBeUndefined();
		expect(rec.lastSeenAt).toBe(START + 8 * MIN);
	});
});
