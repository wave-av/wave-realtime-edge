/**
 * #293 (W0/E5n) — the per-transport LIVE-PROOF HARNESS. One engine, five gated legs, two callers:
 *
 *   1. GATE — each W1 ingest/egress leg PR imports its leg's probe and asserts `verdict !== "fail"` in CI
 *      (see test/proof-harness.test.ts + each leg's own test). "Merges only on its harness receipt" means:
 *      the receipt IS the gate — no leg lands until `runLeg` for it returns non-"fail".
 *   2. CRON — the SAME engine, unmodified, is what a scheduled trigger (or a `harness/*.mjs` synthetic
 *      runner, for legs needing real media I/O Workers can't do) invokes on an interval to prove the legs
 *      are STILL live in prod (synthetic monitoring), not just at merge time.
 *
 * DESIGN:
 *   - `LegProbe` is a pure(-ish) async function: given a `now()` clock (injected — NEVER `Date.now()`
 *     called directly inside a probe, so this is deterministic in tests and Workers-safe), it does ONE
 *     synthetic check for its leg and returns a verdict + markers. It does its OWN I/O (fetch/KV/etc,
 *     itself injected by the leg module) — this engine owns only orchestration + receipt shape.
 *   - `runLeg` wraps a probe with timing + fail-loud error capture: a throw becomes a `"fail"` receipt,
 *     never an uncaught rejection (a cron tick must survive one wedged leg to still report the other four).
 *   - `runProofHarness` runs every leg in `LEG_NAMES`, backfilling any leg the caller didn't wire with a
 *     `"stub"` verdict (upstream not built yet — explicit and visible, never silently skipped).
 *   - `legGate` is the merge-gate policy: a `"stub"` leg does NOT block (nothing to prove yet); a
 *     `"fail"` on any REQUIRED leg does. Once a leg's real probe lands, it stops being a stub and starts
 *     gating for real — no engine change needed, only the probe wiring in `proof-harness-legs.ts`.
 */

/** The five W1 transport legs this harness gates (issue #293 acceptance list). Order is the report order. */
export const LEG_NAMES = ["rtmp-in", "ext-rtmp-out", "ext-srt-out", "vod-register", "rtms-in"] as const;
export type LegName = (typeof LEG_NAMES)[number];

/** `"pass"`/`"fail"` are real verdicts from a real probe. `"stub"` = the leg's upstream isn't wired yet —
 *  the harness SHAPE is real (it ran, it reported) but there is nothing live to prove. */
export type LegVerdict = "pass" | "fail" | "stub";

/** What one probe run returns, before the engine adds timing. `markers` are the observed evidence
 *  (status codes, byte counts, header values — whatever proves the leg actually moved bytes/state), the
 *  same spirit as `canary-proof.ts`'s per-call header digest. */
export interface LegProbeOutcome {
  readonly verdict: LegVerdict;
  readonly markers: Record<string, unknown>;
  readonly note?: string;
}

/** A leg's synthetic check. Takes the injected clock so it never reads `Date.now()` itself (Worker-safe,
 *  deterministic under test) — pass `() => 0` or a fake in tests, `Date.now` in the real cron/CI caller. */
export type LegProbe = (now: () => number) => Promise<LegProbeOutcome>;

/** One leg's structured pass/fail RECEIPT — the artifact both the merge gate and the cron monitor read. */
export interface LegReceipt {
  readonly leg: LegName;
  readonly verdict: LegVerdict;
  readonly startedAt: number;
  readonly finishedAt: number;
  readonly durationMs: number;
  readonly markers: Record<string, unknown>;
  readonly note?: string;
}

/** Run ONE leg's probe, capturing timing and converting a throw into a `"fail"` receipt (never propagates —
 *  a wedged leg must not take down the rest of a cron tick or the rest of the harness run). */
export async function runLeg(leg: LegName, probe: LegProbe, now: () => number = Date.now): Promise<LegReceipt> {
  const startedAt = now();
  try {
    const outcome = await probe(now);
    const finishedAt = now();
    return { leg, ...outcome, startedAt, finishedAt, durationMs: finishedAt - startedAt };
  } catch (e) {
    const finishedAt = now();
    return {
      leg,
      verdict: "fail",
      markers: {},
      note: `threw: ${(e as Error)?.message ?? String(e)}`,
      startedAt,
      finishedAt,
      durationMs: finishedAt - startedAt,
    };
  }
}

/** A stub probe for a leg with no wired probe yet — reports `"stub"`, never `"fail"`, so an unwired leg
 *  cannot accidentally block a merge or page an on-call from a synthetic monitor. */
function stubProbe(leg: LegName): LegProbe {
  return async () => ({
    verdict: "stub",
    markers: {},
    note: `${leg}: no probe wired yet (upstream leg not built) — harness shape only, see #293`,
  });
}

/** The full harness run: every leg in `LEG_NAMES`, in order. `probes` supplies a real probe per leg it has
 *  wired (see `proof-harness-legs.ts`); any leg it omits gets `stubProbe`. `overall` is `"fail"` iff ANY
 *  leg (wired or not) came back `"fail"` — a stub never fails the roll-up, only an actual bad probe does. */
export interface ProofHarnessResult {
  readonly overall: "pass" | "fail";
  readonly generatedAt: number;
  readonly receipts: readonly LegReceipt[];
}

export async function runProofHarness(
  probes: Partial<Record<LegName, LegProbe>>,
  now: () => number = Date.now,
): Promise<ProofHarnessResult> {
  const generatedAt = now();
  const receipts: LegReceipt[] = [];
  for (const leg of LEG_NAMES) {
    receipts.push(await runLeg(leg, probes[leg] ?? stubProbe(leg), now));
  }
  const overall: "pass" | "fail" = receipts.some((r) => r.verdict === "fail") ? "fail" : "pass";
  return { overall, generatedAt, receipts };
}

/** The merge-gate policy for ONE leg's own PR (`"merges only on its harness receipt"`): a leg is mergeable
 *  iff its OWN receipt is not `"fail"`. A `"stub"` receipt (this PR IS the one wiring the probe, so there's
 *  no prior real receipt) is treated as blocking by callers that pass `allowStub: false` — the default is
 *  permissive (`true`) since a leg PR typically lands its own probe in the same change and can't have a
 *  prior non-stub receipt to point to. */
export function legGate(receipt: LegReceipt, opts: { allowStub?: boolean } = {}): { allow: boolean; reason?: string } {
  const allowStub = opts.allowStub ?? true;
  if (receipt.verdict === "fail") return { allow: false, reason: receipt.note ?? `${receipt.leg} probe failed` };
  if (receipt.verdict === "stub" && !allowStub) return { allow: false, reason: `${receipt.leg} has no live probe yet` };
  return { allow: true };
}

/** The cron/synthetic-monitoring gate over a FULL harness run: which of the `requiredLegs` (typically every
 *  leg with a real, non-stub probe wired) came back `"fail"`. An empty `blocking` list = green synthetic
 *  run — the W0 exit receipt issue #293 asks for. `stubLegs` is surfaced ALONGSIDE `blocking` (not folded
 *  into `allow`) so a consumer can never read `allow:true` as "all five transports proven live" when some are
 *  still on the default stub (no upstream probe wired yet, see `proof-harness-legs.ts`) — a stub is invisible
 *  to `allow` by design (it must not block), but it should never be silently invisible to a human reading the
 *  gate result either. */
export function harnessGate(
  result: ProofHarnessResult,
  requiredLegs: readonly LegName[] = LEG_NAMES,
): { allow: boolean; blocking: readonly LegName[]; stubLegs: readonly LegName[] } {
  const required = new Set(requiredLegs);
  const blocking = result.receipts.filter((r) => required.has(r.leg) && r.verdict === "fail").map((r) => r.leg);
  const stubLegs = result.receipts.filter((r) => required.has(r.leg) && r.verdict === "stub").map((r) => r.leg);
  return { allow: blocking.length === 0, blocking, stubLegs };
}
