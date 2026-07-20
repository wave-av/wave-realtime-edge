// #261 — the sweep emits a per-resource verdict line so orphan billing is directly observable. Before this,
// only bills and disconnect-marks logged; a refreshed/skipped/unknown session left no trace, which is how the
// #240 mis-billing hid through two misdiagnoses.
//
// Split out of whip-sweep.test.ts (non-behavioral test-file refactor) — same assertions, relocated.
import { afterEach, describe, expect, it, vi } from "vitest";
import { sweepWhipResources } from "../src/whip-sweep";
import { ORG, START, MIN, memKv, depsFor, PROVISIONED } from "./whip-sweep-helpers";

describe("sweepWhipResources — per-resource verdict log (#261)", () => {
	function verdictLines(spy: ReturnType<typeof vi.spyOn>): Record<string, unknown>[] {
		return (spy.mock.calls as unknown[][])
			.map((c): Record<string, unknown> => {
				try {
					return JSON.parse(String(c[0]));
				} catch {
					return {};
				}
			})
			.filter((o) => o && o.msg === "whip-sweep-verdict");
	}
	afterEach(() => vi.restoreAllMocks());

	it("emits exactly one verdict line per SCANNED resource, not just the billed ones", async () => {
		const spy = vi.spyOn(console, "log").mockImplementation(() => {});
		const kv = memKv({
			"whip:resaaaaaaaa": { sessionId: "a".repeat(32), org: ORG, startedAt: START },
			"whip:resbbbbbbbb": { sessionId: "b".repeat(32), org: ORG, startedAt: START },
		});
		// "alive" → both refresh; the point is a non-billed verdict still logs a line each.
		await sweepWhipResources({ ...PROVISIONED, RT_MEETING_ORG: kv } as never, depsFor("alive", START + MIN, []) as never);
		const lines = verdictLines(spy);
		expect(lines).toHaveLength(2);
		expect(lines.every((l) => l.action === "refresh")).toBe(true);
		expect(new Set(lines.map((l) => l.resourceId))).toEqual(new Set(["resaaaaaaaa", "resbbbbbbbb"]));
	});

	it("labels a billed orphan action:bill and carries the fields the decision turns on", async () => {
		const spy = vi.spyOn(console, "log").mockImplementation(() => {});
		// disconnectedSince ripened past the confirm window (#257) so this single sweep BILLS rather than marks.
		const kv = memKv({ "whip:res00000abc": { sessionId: "s".repeat(32), org: ORG, startedAt: START, lastSeenAt: START + 2 * MIN, disconnectedSince: START } });
		await sweepWhipResources({ ...PROVISIONED, RT_MEETING_ORG: kv } as never, depsFor("gone", START + 30 * MIN, []) as never);
		const [line] = verdictLines(spy);
		expect(line).toMatchObject({ resourceId: "res00000abc", verdict: "gone", action: "bill", lastSeenAt: START + 2 * MIN });
	});

	it("labels a first-410 disconnect stamp action:mark (disconnectedSince is undefined at observation)", async () => {
		// The line records the OBSERVED input record: a first 410 has no prior stamp yet (action:mark is what
		// writes it), so disconnectedSince is undefined here. The next sweep's line will carry the stamp.
		const spy = vi.spyOn(console, "log").mockImplementation(() => {});
		const kv = memKv({ "whip:res00000abc": { sessionId: "s".repeat(32), org: ORG, startedAt: START } });
		await sweepWhipResources({ ...PROVISIONED, RT_MEETING_ORG: kv } as never, depsFor("disconnected", START + 5 * MIN, []) as never);
		const [line] = verdictLines(spy);
		expect(line).toMatchObject({ verdict: "disconnected", action: "mark" });
		expect(line.disconnectedSince).toBeUndefined();
	});

	it("carries a persisted disconnectedSince onto the bill line when a 410 ripens past the confirm window", async () => {
		const spy = vi.spyOn(console, "log").mockImplementation(() => {});
		const firstSeen = START + 2 * MIN;
		const kv = memKv({ "whip:res00000abc": { sessionId: "s".repeat(32), org: ORG, startedAt: START, lastSeenAt: START + MIN, disconnectedSince: firstSeen } });
		await sweepWhipResources({ ...PROVISIONED, RT_MEETING_ORG: kv } as never, depsFor("disconnected", firstSeen + 10 * MIN, []) as never);
		const [line] = verdictLines(spy);
		expect(line).toMatchObject({ verdict: "disconnected", action: "bill", disconnectedSince: firstSeen, lastSeenAt: START + MIN });
	});

	it("labels an unheld unknown verdict action:skip", async () => {
		const spy = vi.spyOn(console, "log").mockImplementation(() => {});
		const kv = memKv({ "whip:res00000abc": { sessionId: "s".repeat(32), org: ORG, startedAt: START } });
		await sweepWhipResources({ ...PROVISIONED, RT_MEETING_ORG: kv } as never, depsFor("unknown", START + 5 * MIN, []) as never);
		const [line] = verdictLines(spy);
		expect(line).toMatchObject({ verdict: "unknown", action: "skip" });
	});
});
