// #260 — the cron scheduled() handler is invoked once PER matching cron expression. wrangler.toml declares
// two: "*/15 * * * *" (reconciles) and "*/5 * * * *" (WHIP orphan sweep). At :00/:15/:30/:45 BOTH match, so
// CF delivers TWO scheduled events at those instants. The sweep must fire on exactly one of them or it races
// two concurrent sweeps every quarter hour (benign post-#240 — the emit is idempotent on event_id — but it
// doubles the SFU liveness probes). These tests pin: sweep gated to its own */5 event, reconciles to */15.
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/rtk-webhook", () => ({ reconcilePending: vi.fn() }));
vi.mock("../src/stream-bridge", () => ({
	scheduledStreamReconcile: vi.fn(),
	liveStreamBridgeDeps: vi.fn(() => ({ dispatchStart: vi.fn(), dispatchStop: vi.fn() })),
	liveStreamProbeHealth: vi.fn(),
}));
vi.mock("../src/stream-bridge-poll", () => ({ scheduledStreamPoll: vi.fn() }));
vi.mock("../src/ingest-bridge", () => ({ scheduledIngestReconcile: vi.fn() }));
// Preserve the REAL module so WHIP_SWEEP_CRON stays byte-identical to production; only stub the entrypoint.
vi.mock("../src/whip-sweep", async (importOriginal) => ({
	...(await importOriginal<typeof import("../src/whip-sweep")>()),
	scheduledWhipSweep: vi.fn(),
}));
vi.mock("../src/container-health-alarm", () => ({ scheduledContainerHealth: vi.fn() }));
vi.mock("../src/dispatch-helpers", () => ({ buildPullSink: vi.fn(() => null) }));

import { scheduledHandler } from "../src/scheduled";
import { scheduledWhipSweep, WHIP_SWEEP_CRON } from "../src/whip-sweep";
import { scheduledStreamReconcile } from "../src/stream-bridge";
import { scheduledContainerHealth } from "../src/container-health-alarm";

const RECONCILE_CRON = "*/15 * * * *";

async function fireTick(cron: string): Promise<void> {
	const ctx = { waitUntil: vi.fn() };
	await scheduledHandler({ cron } as never, {} as never, ctx as never);
}

describe("scheduledHandler — WHIP sweep is gated to a single cron (#260)", () => {
	beforeEach(() => vi.clearAllMocks());

	it("runs the sweep on its own */5 event", async () => {
		await fireTick(WHIP_SWEEP_CRON);
		expect(scheduledWhipSweep).toHaveBeenCalledTimes(1);
	});

	it("does NOT run the sweep on the */15 reconcile event (this is the double-run fix)", async () => {
		await fireTick(RECONCILE_CRON);
		expect(scheduledWhipSweep).not.toHaveBeenCalled();
	});

	it("fires the sweep EXACTLY ONCE across the two events delivered at an overlapping :00/:15/:30/:45 tick", async () => {
		// CF delivers both matching crons as separate scheduled() invocations at the overlap instant.
		await fireTick(WHIP_SWEEP_CRON);
		await fireTick(RECONCILE_CRON);
		expect(scheduledWhipSweep).toHaveBeenCalledTimes(1);
	});

	it("keeps the reconciles on the */15 event only (gating symmetry preserved)", async () => {
		await fireTick(RECONCILE_CRON);
		expect(scheduledStreamReconcile).toHaveBeenCalledTimes(1);
		expect(scheduledContainerHealth).toHaveBeenCalledTimes(1);

		vi.clearAllMocks();
		await fireTick(WHIP_SWEEP_CRON);
		expect(scheduledStreamReconcile).not.toHaveBeenCalled();
		expect(scheduledContainerHealth).not.toHaveBeenCalled();
	});
});
