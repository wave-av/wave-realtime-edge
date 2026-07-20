// Shared fixtures for the whip-sweep test files (test/whip-sweep*.test.ts). Split out of whip-sweep.test.ts
// (non-behavioral test-file refactor) so each sibling file can build its own plan/apply fixtures without
// duplicating the entry/confirmed/memKv/depsFor helpers.
import type { WhipSweepEntry } from "../src/whip-sweep";
import type { WhipKv } from "../src/whip";

export const ORG = "18e9224a-0e81-4c05-a336-5b9cb118d48a";
export const START = 1_700_000_000_000;
export const MIN = 60_000;

export function entry(over: Partial<WhipSweepEntry> & { verdict: WhipSweepEntry["verdict"] }): WhipSweepEntry {
	return {
		resourceId: over.resourceId ?? "res00000abc",
		record: { sessionId: "s".repeat(32), org: ORG, startedAt: START, ...over.record },
		verdict: over.verdict,
		observedAt: over.observedAt ?? START,
	};
}

// #257 — a death candidate whose confirm window has ALREADY elapsed: stamped at startedAt and observed
// +30min later (≫ WHIP_GONE_CONFIRM_MS = 4min), so planWhipSweep BILLS it on this sweep instead of opening
// the window. The bill-MATH assertions below (quantity, SKU, idempotency key, neverSeenAlive) are unchanged
// by the confirm gate — it only changes WHEN a session bills, not for how much. planWhipSweep clocks the gate
// off the per-entry observedAt (`at`), so observedAt drives it, not the `now` argument.
export function confirmed(over: Partial<WhipSweepEntry> & { verdict: WhipSweepEntry["verdict"] }): WhipSweepEntry {
	return entry({
		observedAt: START + 30 * MIN,
		...over,
		record: { disconnectedSince: START, ...over.record } as never,
	});
}

/** In-memory KV implementing the full WhipKv surface, seeded with `whip:`-prefixed records. */
export function memKv(seed: Record<string, unknown> = {}): WhipKv & { store: Map<string, string> } {
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
export function depsFor(verdict: "alive" | "gone" | "unknown" | "disconnected" | "idle", now: number, emits: unknown[]) {
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

export const PROVISIONED = { GATEWAY_BASE_URL: "https://api.wave.online", WAVE_SERVICE_TOKEN: "t", CF_CALLS_APP_ID: "a", CF_CALLS_APP_SECRET: "s" };
