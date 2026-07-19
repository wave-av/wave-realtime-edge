// #234 — the container-app wedge alarm. Pure classification + an injected fetch/KV, so no network.
//
// The tests that matter most here are the NEGATIVE ones. An alarm that fires on every rollout gets muted,
// and a muted alarm leaves us exactly as blind as the wedge that motivated it — so "does not fire during a
// rollout" and "does not fire on a single blip" are load-bearing, not padding.
import { describe, it, expect, vi } from "vitest";
import {
	classifyContainerHealth,
	checkContainerHealth,
	WEDGE_SUSTAIN_TICKS,
	type ContainerApp,
} from "../src/container-health-alarm";

const app = (over: Partial<ContainerApp> & { instances?: Record<string, number> } = {}): ContainerApp => ({
	id: over.id ?? "app-1",
	name: over.name ?? "wave-realtime-edge-streambridgecontainer",
	max_instances: over.max_instances ?? 30,
	health: { instances: over.instances ?? { active: 1, healthy: 1, failed: 0, starting: 0 } },
});

/** Minimal in-memory KV with just the three methods the module uses. */
function fakeKv() {
	const m = new Map<string, string>();
	return {
		store: m,
		get: async (k: string) => m.get(k) ?? null,
		put: async (k: string, v: string) => void m.set(k, v),
		delete: async (k: string) => void m.delete(k),
	} as unknown as KVNamespace;
}

const okEnv = { CF_API_TOKEN: "tok", CF_ACCOUNT_ID: "acct", CONTAINER_HEALTH_ALARM_ENABLED: "1" };
const fetchReturning = (apps: ContainerApp[]) =>
	vi.fn(async () => new Response(JSON.stringify({ result: apps }), { status: 200 })) as unknown as typeof fetch;

describe("classifyContainerHealth — the wedge signature", () => {
	it("flags the exact signature observed live: active>0, healthy=0, failed=0", () => {
		// The real rollup captured by hand during the wedge. `failed:0` is the detail that made every
		// failure-based alert useless here.
		expect(
			classifyContainerHealth(app({ instances: { active: 5, assigned: 0, healthy: 0, stopped: 0, failed: 0, scheduling: 0, starting: 0 } })),
		).toBe("wedged");
	});

	it("does NOT flag a rollout in progress (healthy>0 while others start)", () => {
		// Captured verbatim from the v7 rollout on 2026-07-19.
		expect(classifyContainerHealth(app({ instances: { active: 0, healthy: 2, starting: 5, failed: 0 } }))).toBe("ok");
	});

	it("does NOT flag active-but-all-starting — that is a cold start, not a wedge", () => {
		expect(classifyContainerHealth(app({ instances: { active: 3, healthy: 0, starting: 3, failed: 0 } }))).toBe("ok");
	});

	it("does NOT flag a genuinely idle app (nothing active, nothing healthy)", () => {
		expect(classifyContainerHealth(app({ instances: { active: 0, healthy: 0, starting: 0, failed: 0 } }))).toBe("ok");
	});

	it("reports at-capacity when active reaches max_instances", () => {
		expect(classifyContainerHealth(app({ max_instances: 30, instances: { active: 30, healthy: 30 } }))).toBe("at-capacity");
	});

	it("stays silent when no health rollup is reported — absence is not evidence (#229)", () => {
		expect(classifyContainerHealth({ id: "a", name: "n" })).toBe("ok");
	});
});

describe("checkContainerHealth — sustain, inertness, and failure modes", () => {
	const wedged = [app({ instances: { active: 5, healthy: 0, failed: 0, starting: 0 } })];

	it("does not alarm on the FIRST wedged tick — a single reading can be a blip", async () => {
		const kv = fakeKv();
		const log = vi.fn();
		const r = await checkContainerHealth(okEnv, { fetch: fetchReturning(wedged), kv, log });
		expect(r.verdicts[0]).toMatchObject({ verdict: "wedged", alarmed: false });
		expect(log).not.toHaveBeenCalledWith("container-wedge-alarm", expect.anything());
	});

	it("alarms once the signature SURVIVES the sustain window", async () => {
		const kv = fakeKv();
		const log = vi.fn();
		for (let i = 0; i < WEDGE_SUSTAIN_TICKS; i++) {
			await checkContainerHealth(okEnv, { fetch: fetchReturning(wedged), kv, log });
		}
		expect(log).toHaveBeenCalledWith("container-wedge-alarm", expect.objectContaining({ streak: WEDGE_SUSTAIN_TICKS }));
	});

	it("a recovery CLEARS the streak, so blips cannot accumulate into a false alarm", async () => {
		const kv = fakeKv();
		const log = vi.fn();
		await checkContainerHealth(okEnv, { fetch: fetchReturning(wedged), kv, log }); // streak 1
		await checkContainerHealth(okEnv, { fetch: fetchReturning([app()]), kv, log }); // healthy → clear
		await checkContainerHealth(okEnv, { fetch: fetchReturning(wedged), kv, log }); // streak 1 again
		expect(log).not.toHaveBeenCalledWith("container-wedge-alarm", expect.anything());
	});

	it("is INERT unless explicitly enabled", async () => {
		const f = fetchReturning(wedged);
		const r = await checkContainerHealth({ ...okEnv, CONTAINER_HEALTH_ALARM_ENABLED: undefined }, { fetch: f });
		expect(r.verdicts).toEqual([]);
		expect(f).not.toHaveBeenCalled();
	});

	it("is INERT without credentials — never calls the API unauthenticated", async () => {
		const f = fetchReturning(wedged);
		const r = await checkContainerHealth({ ...okEnv, CF_API_TOKEN: undefined }, { fetch: f });
		expect(r.verdicts).toEqual([]);
		expect(f).not.toHaveBeenCalled();
	});

	it("LOGS a probe failure rather than failing silently", async () => {
		// A silent probe failure would recreate the exact blindness this module exists to end.
		const log = vi.fn();
		const f = vi.fn(async () => new Response("nope", { status: 403 })) as unknown as typeof fetch;
		await checkContainerHealth(okEnv, { fetch: f, log });
		expect(log).toHaveBeenCalledWith("container-health-probe-failed", { status: 403 });
	});

	it("never throws when the API is unreachable", async () => {
		const log = vi.fn();
		const f = vi.fn(async () => { throw new Error("boom"); }) as unknown as typeof fetch;
		await expect(checkContainerHealth(okEnv, { fetch: f, log })).resolves.toEqual({ verdicts: [] });
		expect(log).toHaveBeenCalledWith("container-health-probe-failed", expect.objectContaining({ error: expect.stringContaining("boom") }));
	});

	it("reads the APPLICATIONS list, not the instances endpoint that returns empty for everything", async () => {
		const f = fetchReturning(wedged);
		await checkContainerHealth(okEnv, { fetch: f, kv: fakeKv() });
		const url = String((f as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0]);
		expect(url).toContain("/containers/applications");
		expect(url).not.toMatch(/\/instances$/);
	});

	it("emits a heartbeat EVERY tick, so all-clear is a positive observation not an absence", async () => {
		// Without this line, "never fired" and "never ran" are byte-identical in the logs — the exact
		// failure class (#231/#235/#241) this module exists to end.
		const log = vi.fn();
		await checkContainerHealth(okEnv, { fetch: fetchReturning([app()]), kv: fakeKv(), log });
		expect(log).toHaveBeenCalledWith("container-health-tick", { apps: 1, wedged: 0, atCapacity: 0, alarmed: 0 });
	});

	it("the heartbeat counts the wedge even on the pre-sustain tick that does not alarm", async () => {
		const log = vi.fn();
		await checkContainerHealth(okEnv, { fetch: fetchReturning(wedged), kv: fakeKv(), log });
		expect(log).toHaveBeenCalledWith("container-health-tick", { apps: 1, wedged: 1, atCapacity: 0, alarmed: 0 });
	});

	it("survives a fetch that enforces the Workers `this` contract (the bug that shipped)", async () => {
		// scheduledContainerHealth originally passed the bare global `fetch` by reference, which the Workers
		// runtime rejects with "Illegal invocation: function called with incorrect `this` reference". The alarm
		// was 100% dead in production from its first tick. This models the runtime's actual contract: the
		// function throws unless invoked with the correct receiver, so passing it unbound fails here too.
		const realFetch = fetchReturning([app()]) as unknown as (i: unknown, x?: unknown) => Promise<Response>;
		const host = {
			fetch(input: unknown, init?: unknown) {
				if (this !== host) throw new TypeError("Illegal invocation: function called with incorrect `this` reference");
				return realFetch(input, init);
			},
		};
		const log = vi.fn();
		// Bare reference — must fail, exactly as it did in prod.
		await checkContainerHealth(okEnv, { fetch: host.fetch as unknown as typeof fetch, kv: fakeKv(), log });
		expect(log).toHaveBeenCalledWith("container-health-probe-failed", expect.objectContaining({ error: expect.stringContaining("Illegal invocation") }));

		// Wrapped the way scheduledContainerHealth now does it — must work.
		const log2 = vi.fn();
		const r = await checkContainerHealth(okEnv, {
			fetch: ((i: unknown, x?: unknown) => host.fetch(i, x)) as unknown as typeof fetch,
			kv: fakeKv(),
			log: log2,
		});
		expect(r.verdicts).toHaveLength(1);
		expect(log2).not.toHaveBeenCalledWith("container-health-probe-failed", expect.anything());
	});

	it("carries the rollup verbatim into the alarm line — the counts ARE the diagnosis", async () => {
		const kv = fakeKv();
		const log = vi.fn();
		for (let i = 0; i < WEDGE_SUSTAIN_TICKS; i++) {
			await checkContainerHealth(okEnv, { fetch: fetchReturning(wedged), kv, log });
		}
		expect(log).toHaveBeenCalledWith(
			"container-wedge-alarm",
			expect.objectContaining({ instances: expect.objectContaining({ active: 5, healthy: 0, failed: 0 }) }),
		);
	});
});
