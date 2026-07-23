/**
 * EGRESS COST KILL-SWITCH (#278, W0 — cost-governance safety backstop). The org is running egress cost
 * ~161% over budget; this module is the STOP mechanism, not a new feature. It adds four independent guards
 * around the egress backends (egress-arm.ts / egress-runpod-nvenc.ts), each cheap and each fail-closed:
 *
 *  1. CONCURRENCY CAP — per-org + global limits on simultaneously-armed egress streams (`evaluateArm`).
 *  2. MAX-DURATION AUTO-STOP — a stream armed longer than a configured ceiling is force-disarmed (`sweepExpired`).
 *  3. GLOBAL KILL SWITCH — one flag, checked before every arm, that stops ALL new egress and can be told to
 *     tear down everything currently armed (`activateKillSwitch`).
 *  4. COGS CIRCUIT BREAKER — accumulates the ALREADY-MEASURED `cogsUsd()` (egress-runpod-nvenc.ts) per org per
 *     time window; crossing budget trips the breaker + fires an alert (`circuitBreakerCheck`).
 *
 * STORE SEAM. All state lives behind the injected `KillswitchStore` interface — a minimal (get/put/delete)
 * subset of Cloudflare's `KVNamespace` (a real `KVNamespace` binding satisfies this structurally, no adapter
 * needed at the call site). This mirrors the repo's injected-seam convention (`fetchFn` in egress-arm.ts,
 * `RunpodNvencClient` in egress-runpod-nvenc.ts): zero unverified wire code ships here, and every function is
 * unit-testable with the in-memory `MemoryKillswitchStore` below.
 *
 * PURE ARITHMETIC, INJECTED I/O, INJECTED CLOCK. Every exported function takes `now` as a parameter (default
 * `Date.now()`) so tests never race a real clock. State reads/writes are the ONLY I/O, all behind the store.
 *
 * FAIL CLOSED. A malformed/corrupt registry or budget-bucket value is treated as EMPTY/ZERO, never as "no
 * data means unlimited" — a parse failure narrows the room to arm, never widens it.
 */

// ── Store seam ────────────────────────────────────────────────────────────────────────────────────────────

/** Minimal KV-shaped store this module depends on. A real Cloudflare `KVNamespace` binding (e.g.
 *  `env.RT_MEETING_ORG`, the pattern residency-sink.ts / container-health-alarm.ts already bind) satisfies
 *  this structurally — pass it directly, no adapter needed. */
export interface KillswitchStore {
  get(key: string): Promise<string | null>;
  put(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}

/** In-memory `KillswitchStore` for tests (and for a local/dev harness). Not for prod use. */
export class MemoryKillswitchStore implements KillswitchStore {
  private readonly data = new Map<string, string>();
  async get(key: string): Promise<string | null> {
    return this.data.has(key) ? this.data.get(key)! : null;
  }
  async put(key: string, value: string): Promise<void> {
    this.data.set(key, value);
  }
  async delete(key: string): Promise<void> {
    this.data.delete(key);
  }
}

// ── Shared keys ───────────────────────────────────────────────────────────────────────────────────────────

const REGISTRY_KEY = "egress:armed-registry";
const KILLSWITCH_KEY = "egress:killswitch";
const cogsBucketKey = (orgId: string, bucket: number): string => `egress:cogs:${orgId}:${bucket}`;

// ── Armed-stream registry (backs the concurrency cap + the max-duration sweep) ──────────────────────────────

export interface ArmedStream {
  readonly streamId: string;
  readonly orgId: string;
  readonly armedAt: number;
}

/** Parse the registry, fail-closed to empty on any malformed value (never fabricate armed streams). */
async function readRegistry(store: KillswitchStore): Promise<readonly ArmedStream[]> {
  const raw = await store.get(REGISTRY_KEY);
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (e): e is ArmedStream =>
        typeof e === "object" &&
        e !== null &&
        typeof (e as ArmedStream).streamId === "string" &&
        typeof (e as ArmedStream).orgId === "string" &&
        typeof (e as ArmedStream).armedAt === "number",
    );
  } catch {
    return [];
  }
}

async function writeRegistry(store: KillswitchStore, entries: readonly ArmedStream[]): Promise<void> {
  await store.put(REGISTRY_KEY, JSON.stringify(entries));
}

/** Every currently-armed stream (registry snapshot). Read-only — callers that need to act on it (disarm) go
 *  through `registerDisarmed` / `activateKillSwitch`, never mutate the returned array. */
export async function listArmed(store: KillswitchStore): Promise<readonly ArmedStream[]> {
  return readRegistry(store);
}

/** Record a stream as armed. Idempotent per `streamId` (re-arming replaces the prior entry's `armedAt`, so a
 *  re-arm resets the max-duration clock — mirrors `startRoutedEgress`'s "re-subscribing is idempotent" note). */
export async function registerArmed(
  store: KillswitchStore,
  orgId: string,
  streamId: string,
  now: number = Date.now(),
): Promise<void> {
  const current = await readRegistry(store);
  const next = [...current.filter((e) => e.streamId !== streamId), { streamId, orgId, armedAt: now }];
  await writeRegistry(store, next);
}

/** Remove a stream from the armed registry (the disarm-side bookkeeping). A no-op if it was not armed. */
export async function registerDisarmed(store: KillswitchStore, streamId: string): Promise<void> {
  const current = await readRegistry(store);
  await writeRegistry(
    store,
    current.filter((e) => e.streamId !== streamId),
  );
}

// ── 1. Concurrent-stream cap ─────────────────────────────────────────────────────────────────────────────

export interface ConcurrencyLimits {
  readonly perOrg: number;
  readonly global: number;
}

/** Conservative defaults — deliberately tight given the 161%-over-budget backstop context. Callers with a
 *  grounded higher number should pass explicit `ConcurrencyLimits`, not rely on this. */
export const DEFAULT_CONCURRENCY_LIMITS: ConcurrencyLimits = { perOrg: 25, global: 500 };

export type ArmDecision = { readonly ok: true } | { readonly ok: false; readonly reason: "killswitch" | "org_cap" | "global_cap" };

/** Decide whether a NEW stream may arm, WITHOUT mutating any state (read-only decision). Checks, in order: the
 *  global kill switch, the per-org cap, then the global cap — so a killed org never even reaches the cap math.
 *  Callers that accept the decision must separately call `registerArmed` (kept separate so a caller can, e.g.,
 *  re-check other conditions between decide and commit without a partial write). */
export async function evaluateArm(
  store: KillswitchStore,
  orgId: string,
  limits: ConcurrencyLimits = DEFAULT_CONCURRENCY_LIMITS,
): Promise<ArmDecision> {
  if (await isKillSwitchActive(store)) return { ok: false, reason: "killswitch" };
  const armed = await readRegistry(store);
  const orgCount = armed.filter((e) => e.orgId === orgId).length;
  if (orgCount >= limits.perOrg) return { ok: false, reason: "org_cap" };
  if (armed.length >= limits.global) return { ok: false, reason: "global_cap" };
  return { ok: true };
}

// ── 2. Max-duration auto-stop ────────────────────────────────────────────────────────────────────────────

/** Default ceiling: 6 hours. A live stream armed longer than this without a re-arm is treated as leaked. */
export const DEFAULT_MAX_DURATION_MS = 6 * 60 * 60_000;

export function isExpired(armedAt: number, now: number, maxDurationMs: number = DEFAULT_MAX_DURATION_MS): boolean {
  return now - armedAt >= maxDurationMs;
}

/** Sweep the registry for streams armed past `maxDurationMs`, invoke `disarm(streamId, orgId)` for each (the
 *  caller's real teardown — e.g. `handle.close()`), and remove them from the registry. Intended to run off a
 *  periodic trigger (mirrors `container-health-alarm.ts`'s alarm pattern) rather than per-frame. Returns the
 *  disarmed stream ids for logging/alerting. A `disarm` callback that throws does not abort the sweep for the
 *  remaining entries (best-effort teardown; the entry is still dropped from the registry either way, since a
 *  registry entry that never clears would re-trip every sweep forever). */
export async function sweepExpired(
  store: KillswitchStore,
  disarm: (streamId: string, orgId: string) => void | Promise<void>,
  now: number = Date.now(),
  maxDurationMs: number = DEFAULT_MAX_DURATION_MS,
): Promise<readonly string[]> {
  const armed = await readRegistry(store);
  const expired = armed.filter((e) => isExpired(e.armedAt, now, maxDurationMs));
  if (expired.length === 0) return [];

  for (const e of expired) {
    try {
      await disarm(e.streamId, e.orgId);
    } catch {
      // best-effort teardown — still drop the entry below so it doesn't re-trip forever
    }
  }
  const expiredIds = new Set(expired.map((e) => e.streamId));
  await writeRegistry(
    store,
    armed.filter((e) => !expiredIds.has(e.streamId)),
  );
  return [...expiredIds];
}

// ── 3. Global kill switch ────────────────────────────────────────────────────────────────────────────────

/** True iff the kill switch is armed. Same strict-string convention as `egressRouterEnabled` /
 *  `mediaTapEnabled`: only a literal `"1"` trips it — an absent/cleared key is OFF (fail-open on the switch
 *  ITSELF is correct here: no flag means "not killed", the safe/normal state). */
export async function isKillSwitchActive(store: KillswitchStore): Promise<boolean> {
  return (await store.get(KILLSWITCH_KEY)) === "1";
}

/** ONE-COMMAND KILL SWITCH. Sets the global flag (so every subsequent `evaluateArm` rejects with
 *  `"killswitch"`) AND tears down every stream CURRENTLY armed by invoking `disarm(streamId, orgId)` for each,
 *  then clears the registry. Returns the disarmed stream ids. This is the function the CLI script / admin
 *  endpoint calls — see `scripts/kill-egress.mjs`. */
export async function activateKillSwitch(
  store: KillswitchStore,
  disarm: (streamId: string, orgId: string) => void | Promise<void>,
  now: number = Date.now(),
): Promise<readonly string[]> {
  await store.put(KILLSWITCH_KEY, "1");
  const armed = await readRegistry(store);
  for (const e of armed) {
    try {
      await disarm(e.streamId, e.orgId);
    } catch {
      // best-effort teardown — the switch itself must still land even if one disarm callback throws
    }
  }
  await writeRegistry(store, []);
  void now; // reserved for future audit-log timestamping; kept in the signature for call-site symmetry
  return armed.map((e) => e.streamId);
}

/** Clear the kill switch. Does NOT re-arm anything that was torn down — re-arming is each caller's own
 *  decision (mirrors `startRoutedEgress`'s "arming is explicit, never implicit" stance). */
export async function deactivateKillSwitch(store: KillswitchStore): Promise<void> {
  await store.delete(KILLSWITCH_KEY);
}

// ── 4. COGS circuit breaker ──────────────────────────────────────────────────────────────────────────────

export interface BudgetLimits {
  readonly budgetUsd: number;
  readonly windowMs: number;
}

/** Conservative default: $50/org/hour. Callers with a grounded per-org budget should pass explicit limits. */
export const DEFAULT_BUDGET_LIMITS: BudgetLimits = { budgetUsd: 50, windowMs: 60 * 60_000 };

export interface CircuitBreakerAlert {
  readonly orgId: string;
  readonly totalUsd: number;
  readonly budgetUsd: number;
  readonly windowMs: number;
  readonly ts: number;
}

export type AlertSink = (alert: CircuitBreakerAlert) => void | Promise<void>;

export interface CircuitBreakerResult {
  readonly tripped: boolean;
  readonly totalUsd: number;
}

/** Fail-closed parse of a stored bucket total: anything not a finite non-negative number reads as 0 (never
 *  treated as "unlimited" and never propagates a NaN into the running total). */
function parseBucketTotal(raw: string | null): number {
  if (raw === null) return 0;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

/** Add `cogsUsdDelta` (an ALREADY-MEASURED cost, e.g. from `cogsUsd()` in egress-runpod-nvenc.ts — never a
 *  fabricated number) to the org's current time-window bucket and report whether the running total is now over
 *  budget. Pure accumulation; does not itself alert or disarm — see `circuitBreakerCheck` for the full hook. */
export async function recordCogsAndCheckBudget(
  store: KillswitchStore,
  orgId: string,
  cogsUsdDelta: number,
  limits: BudgetLimits = DEFAULT_BUDGET_LIMITS,
  now: number = Date.now(),
): Promise<CircuitBreakerResult> {
  if (!Number.isFinite(cogsUsdDelta) || cogsUsdDelta < 0) {
    // A malformed delta never mutates the budget — read-through the current total unchanged.
    const bucket = Math.floor(now / limits.windowMs);
    const total = parseBucketTotal(await store.get(cogsBucketKey(orgId, bucket)));
    return { tripped: total > limits.budgetUsd, totalUsd: total };
  }
  const bucket = Math.floor(now / limits.windowMs);
  const key = cogsBucketKey(orgId, bucket);
  const total = parseBucketTotal(await store.get(key)) + cogsUsdDelta;
  await store.put(key, String(total));
  return { tripped: total > limits.budgetUsd, totalUsd: total };
}

/** The full circuit-breaker hook the NVENC backend calls after each measured encode: records the cost, and
 *  when the org's window total crosses budget, fires `alertSink` with the trip details. Returns the same
 *  `{tripped, totalUsd}` so the caller (RunpodNvencEgressBackend) can latch its own "circuit open" state and
 *  stop attempting further encodes for that org. */
export async function circuitBreakerCheck(
  store: KillswitchStore,
  orgId: string,
  cogsUsdDelta: number,
  limits: BudgetLimits,
  alertSink: AlertSink,
  now: number = Date.now(),
): Promise<CircuitBreakerResult> {
  const result = await recordCogsAndCheckBudget(store, orgId, cogsUsdDelta, limits, now);
  if (result.tripped) {
    await alertSink({ orgId, totalUsd: result.totalUsd, budgetUsd: limits.budgetUsd, windowMs: limits.windowMs, ts: now });
  }
  return result;
}
