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
const fetchOk = () => vi.fn(async () => new Response(JSON.stringify({ result: [] }), { status: 200 })) as unknown as typeof fetch;
const fetchFailing = (status: number) => vi.fn(async () => new Response("nope", { status })) as unknown as typeof fetch;

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
});
