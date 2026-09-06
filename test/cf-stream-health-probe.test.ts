// infra-integration:cloudflare-stream:health-probe — a synthetic reachability check against the Cloudflare
// Stream API, distinct from container-health-alarm.ts (container fleet) and liveStreamProbeHealth
// (per-session bridge). Injected fetch/KV/clock throughout, so no real network runs in test.
import { describe, it, expect, vi } from "vitest";
import {
	checkCfStreamHealth,
	CF_STREAM_HEALTH_SUSTAIN_TICKS,
	type CfStreamHealthKv,
} from "../src/cf-stream-health-probe";

/** Minimal in-memory KV with just the three methods the module uses. */
function fakeKv(): CfStreamHealthKv {
	const m = new Map<string, string>();
	return {
		get: async (k: string) => m.get(k) ?? null,
		put: async (k: string, v: string) => void m.set(k, v),
		delete: async (k: string) => void m.delete(k),
	};
}

const okEnv = { CF_API_TOKEN: "tok", CF_ACCOUNT_ID: "acct", CF_STREAM_HEALTH_PROBE_ENABLED: "1" };
const fetchOk = () => vi.fn(async () => new Response(JSON.stringify({ success: true, result: [] }), { status: 200 })) as unknown as typeof fetch;
const fetchFailing = (status: number) => vi.fn(async () => new Response("nope", { status })) as unknown as typeof fetch;
/** A 2xx reply whose CF envelope reports `success:false` — the "looks fine, isn't" case. */
const fetchSuccessFalse = () => vi.fn(async () => new Response(JSON.stringify({ success: false, errors: [{ message: "nope" }] }), { status: 200 })) as unknown as typeof fetch;

describe("checkCfStreamHealth — inertness", () => {
	it("is INERT unless explicitly enabled", async () => {
		const f = fetchOk();
		const r = await checkCfStreamHealth({ ...okEnv, CF_STREAM_HEALTH_PROBE_ENABLED: undefined }, { fetch: f });
		expect(r).toEqual({ ok: true, alarmed: false });
		expect(f).not.toHaveBeenCalled();
	});

	it("is INERT without credentials — never calls the API unauthenticated", async () => {
		const f = fetchOk();
		const r = await checkCfStreamHealth({ ...okEnv, CF_API_TOKEN: undefined }, { fetch: f });
		expect(r).toEqual({ ok: true, alarmed: false });
		expect(f).not.toHaveBeenCalled();
	});

	it("reads the live_inputs list — the same surface the provision path depends on", async () => {
		const f = fetchOk();
		await checkCfStreamHealth(okEnv, { fetch: f, kv: fakeKv() });
		const url = String((f as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0]);
		expect(url).toContain("/stream/live_inputs");
		const headers = (f as unknown as ReturnType<typeof vi.fn>).mock.calls[0][1]?.headers as Record<string, string>;
		expect(headers.authorization).toBe("Bearer tok");
	});
});

describe("checkCfStreamHealth — sustain and alarm behavior", () => {
	it("does not alarm on the FIRST failing tick — a single reading can be a blip", async () => {
		const kv = fakeKv();
		const log = vi.fn();
		const r = await checkCfStreamHealth(okEnv, { fetch: fetchFailing(503), kv, log });
		expect(r).toMatchObject({ ok: false, alarmed: false });
		expect(log).not.toHaveBeenCalledWith("cf-stream-health-alarm", expect.anything());
	});

	it("alarms once the failure SURVIVES the sustain window", async () => {
		const kv = fakeKv();
		const log = vi.fn();
		let last;
		for (let i = 0; i < CF_STREAM_HEALTH_SUSTAIN_TICKS; i++) {
			last = await checkCfStreamHealth(okEnv, { fetch: fetchFailing(503), kv, log });
		}
		expect(last).toMatchObject({ ok: false, alarmed: true });
		expect(log).toHaveBeenCalledWith(
			"cf-stream-health-alarm",
			expect.objectContaining({ streak: CF_STREAM_HEALTH_SUSTAIN_TICKS, status: 503 }),
		);
	});

	it("a recovery CLEARS the streak, so blips cannot accumulate into a false alarm", async () => {
		const kv = fakeKv();
		const log = vi.fn();
		await checkCfStreamHealth(okEnv, { fetch: fetchFailing(503), kv, log }); // streak 1
		await checkCfStreamHealth(okEnv, { fetch: fetchOk(), kv, log }); // healthy → clear
		await checkCfStreamHealth(okEnv, { fetch: fetchFailing(503), kv, log }); // streak 1 again
		expect(log).not.toHaveBeenCalledWith("cf-stream-health-alarm", expect.anything());
	});

	it("never throws when the API is unreachable, and still counts toward the sustain streak", async () => {
		const kv = fakeKv();
		const log = vi.fn();
		const f = vi.fn(async () => { throw new Error("boom"); }) as unknown as typeof fetch;
		let last;
		for (let i = 0; i < CF_STREAM_HEALTH_SUSTAIN_TICKS; i++) {
			last = await checkCfStreamHealth(okEnv, { fetch: f, kv, log });
		}
		expect(last).toMatchObject({ ok: false, alarmed: true });
		expect(log).toHaveBeenCalledWith("cf-stream-health-probe-failed", expect.objectContaining({ error: expect.stringContaining("boom") }));
	});

	it("emits a heartbeat EVERY tick, so all-clear is a positive observation not an absence", async () => {
		const log = vi.fn();
		await checkCfStreamHealth(okEnv, { fetch: fetchOk(), kv: fakeKv(), log });
		expect(log).toHaveBeenCalledWith("cf-stream-health-tick", expect.objectContaining({ ok: true, alarmed: false }));
	});

	it("carries status and latency into every log line — the diagnosis travels with the alarm", async () => {
		const kv = fakeKv();
		const log = vi.fn();
		let now = 1000;
		const clock = () => (now += 50);
		for (let i = 0; i < CF_STREAM_HEALTH_SUSTAIN_TICKS; i++) {
			await checkCfStreamHealth(okEnv, { fetch: fetchFailing(500), kv, log, now: clock });
		}
		expect(log).toHaveBeenCalledWith(
			"cf-stream-health-alarm",
			expect.objectContaining({ status: 500, latencyMs: expect.any(Number) }),
		);
	});

	it("treats a 2xx reply with success:false as UNHEALTHY, not a clean read", async () => {
		const kv = fakeKv();
		const log = vi.fn();
		const r = await checkCfStreamHealth(okEnv, { fetch: fetchSuccessFalse(), kv, log });
		expect(r).toMatchObject({ ok: false, status: 200 });
		expect(log).toHaveBeenCalledWith("cf-stream-health-probe-failed", expect.objectContaining({ status: 200 }));
	});
});

describe("checkCfStreamHealth — KV isolation", () => {
	it("a rejected kv.get does not abort the probe — the failure log and heartbeat still fire", async () => {
		const log = vi.fn();
		const kv: CfStreamHealthKv = {
			get: async () => { throw new Error("kv down"); },
			put: async () => undefined,
			delete: async () => undefined,
		};
		const r = await checkCfStreamHealth(okEnv, { fetch: fetchFailing(503), kv, log });
		expect(r.ok).toBe(false);
		expect(log).toHaveBeenCalledWith("cf-stream-health-kv-error", expect.objectContaining({ op: "sustain", error: expect.stringContaining("kv down") }));
		expect(log).toHaveBeenCalledWith("cf-stream-health-probe-failed", expect.anything());
		expect(log).toHaveBeenCalledWith("cf-stream-health-tick", expect.objectContaining({ ok: false }));
	});

	it("a rejected kv.put does not abort the probe — the failure log and heartbeat still fire", async () => {
		const log = vi.fn();
		const kv: CfStreamHealthKv = {
			get: async () => "0",
			put: async () => { throw new Error("kv write down"); },
			delete: async () => undefined,
		};
		const r = await checkCfStreamHealth(okEnv, { fetch: fetchFailing(503), kv, log });
		expect(r.ok).toBe(false);
		expect(log).toHaveBeenCalledWith("cf-stream-health-kv-error", expect.objectContaining({ op: "sustain", error: expect.stringContaining("kv write down") }));
		expect(log).toHaveBeenCalledWith("cf-stream-health-tick", expect.objectContaining({ ok: false }));
	});

	it("a rejected kv.delete does not abort the probe — the recovery is still logged", async () => {
		const log = vi.fn();
		const kv: CfStreamHealthKv = {
			get: async () => "0",
			put: async () => undefined,
			delete: async () => { throw new Error("kv delete down"); },
		};
		const r = await checkCfStreamHealth(okEnv, { fetch: fetchOk(), kv, log });
		expect(r.ok).toBe(true);
		expect(log).toHaveBeenCalledWith("cf-stream-health-kv-error", expect.objectContaining({ op: "delete", error: expect.stringContaining("kv delete down") }));
		expect(log).toHaveBeenCalledWith("cf-stream-health-tick", expect.objectContaining({ ok: true }));
	});

	it("a failed kv.delete leaves a stale streak that is bounded by SUSTAIN_TTL_S, not permanent", async () => {
		// Regression guard for the codeant-ai finding on PR #486: if recovery's kv.delete() fails, the
		// prior failure streak survives in KV (this is the whole point of the try/catch — the heartbeat
		// must still fire). Assert the write that IS visible to us (the sustain put on the NEXT failure)
		// still carries an expirationTtl, i.e. the module never persists an un-bounded/permanent key.
		const log = vi.fn();
		const store = new Map<string, string>([["cf-stream-health:consecutive-failures", "1"]]);
		const put = vi.fn(async (k: string, v: string) => void store.set(k, v));
		const kv: CfStreamHealthKv = {
			get: async (k: string) => store.get(k) ?? null,
			put,
			delete: async () => undefined,
		};
		// A subsequent isolated failure (as if recovery's delete had failed on a prior tick and left "1"
		// behind) reaches the sustain threshold (2) on this single failure rather than requiring two
		// fresh consecutive ones — that is the documented, TTL-bounded trade-off, not an unbounded bug.
		const r = await checkCfStreamHealth(okEnv, { fetch: fetchFailing(503), kv, log });
		expect(r.alarmed).toBe(true);
		expect(put).toHaveBeenCalledWith(
			"cf-stream-health:consecutive-failures",
			"2",
			expect.objectContaining({ expirationTtl: expect.any(Number) }),
		);
	});
});
