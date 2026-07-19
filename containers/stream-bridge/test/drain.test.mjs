// #235 — drain-on-rollout tests. Werift-free: every effect (server close, relay stop, process exit) is injected.
//
// The load-bearing assertion is that `relay.stop()` is actually awaited before exit. That call is what sends
// the WHIP DELETE, and the DELETE is what books the session's REAL duration. Skipping it — which is what a
// SIGKILL did — silently hands the session to the whip-sweep orphan cron, which bills one ceil'd minute for
// an entire broadcast. So "did we exit cleanly" and "did we get paid" are the same question here.
import { describe, it, expect, vi } from "vitest";
import { makeDrain } from "../server/drain.mjs";

function harness(over = {}) {
	const relay = over.relay === null ? null : (over.relay ?? { stop: vi.fn(async () => {}) });
	let active = relay;
	const log = vi.fn();
	const exit = vi.fn();
	const closeServer = vi.fn();
	const drain = makeDrain({
		getActive: () => active,
		setActive: (v) => { active = v; },
		closeServer,
		log,
		exit,
		timer: over.timer,
		deadlineMs: over.deadlineMs,
	});
	return { drain, relay, log, exit, closeServer, getActive: () => active };
}

describe("makeDrain — #235 rollout drain", () => {
	it("tears the relay down via stop() — the call that sends the WHIP DELETE and books real duration", async () => {
		const { drain, relay, log, exit } = harness();
		await drain("SIGTERM");
		expect(relay.stop).toHaveBeenCalledOnce();
		expect(log).toHaveBeenCalledWith("bridge-drained", { signal: "SIGTERM", clean: true });
		expect(exit).toHaveBeenCalledWith(0);
	});

	it("stops accepting new connections BEFORE tearing down", async () => {
		// A /start racing the rollout would otherwise leave an orphaned relay nothing will ever tear down.
		const order = [];
		const relay = { stop: vi.fn(async () => void order.push("stop")) };
		const { drain, closeServer } = harness({ relay });
		closeServer.mockImplementation(() => void order.push("close"));
		await drain("SIGTERM");
		expect(order).toEqual(["close", "stop"]);
	});

	it("clears the active handle so a racing request cannot see a torn-down relay", async () => {
		const { drain, getActive } = harness();
		await drain("SIGTERM");
		expect(getActive()).toBeNull();
	});

	it("is idempotent — a second signal mid-drain must not start a second teardown", async () => {
		// relay.stop() is idempotent, but a concurrent drain could exit the process while the first
		// teardown's DELETE is still in flight, losing exactly the billing this handler preserves.
		let release;
		const gate = new Promise((r) => { release = r; });
		const relay = { stop: vi.fn(() => gate) };
		const { drain, exit } = harness({ relay });
		const first = drain("SIGTERM");
		await drain("SIGTERM"); // arrives mid-teardown
		expect(relay.stop).toHaveBeenCalledOnce();
		expect(exit).not.toHaveBeenCalled();
		release();
		await first;
		expect(exit).toHaveBeenCalledOnce();
	});

	it("exits on its OWN deadline when teardown hangs — never held past the platform's window", async () => {
		const relay = { stop: vi.fn(() => new Promise(() => {})) }; // never resolves
		const { drain, log, exit } = harness({
			relay,
			timer: () => Promise.reject(new Error("drain timeout")),
		});
		await drain("SIGTERM");
		expect(log).toHaveBeenCalledWith("bridge-drain-failed", expect.objectContaining({ message: expect.stringContaining("timeout") }));
		expect(exit).toHaveBeenCalledWith(0);
	});

	it("LOGS a failed teardown rather than exiting quietly", async () => {
		// A teardown we could not complete means the duration falls to the orphan sweeper. That must never
		// be something you have to infer from silence.
		const relay = { stop: vi.fn(async () => { throw new Error("whip delete 500"); }) };
		const { drain, log, exit } = harness({ relay });
		await drain("SIGTERM");
		expect(log).toHaveBeenCalledWith("bridge-drain-failed", expect.objectContaining({ message: expect.stringContaining("whip delete 500") }));
		expect(exit).toHaveBeenCalledWith(0);
	});

	it("exits cleanly when idle — no relay, no teardown, still loud", async () => {
		const { drain, log, exit } = harness({ relay: null });
		await drain("SIGTERM");
		expect(log).toHaveBeenCalledWith("bridge-draining", { signal: "SIGTERM", hadRelay: false });
		expect(exit).toHaveBeenCalledWith(0);
	});

	it("handles SIGINT the same way (local/dev parity with the rollout path)", async () => {
		const { drain, relay } = harness();
		await drain("SIGINT");
		expect(relay.stop).toHaveBeenCalledOnce();
	});
});
