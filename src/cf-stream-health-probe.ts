// infra-integration:cloudflare-stream:health-probe — a synthetic reachability check against the Cloudflare
// Stream API itself, distinct from every other "health" concept already in this repo:
//   - container-health-alarm.ts watches the CONTAINER APPLICATION fleet (active/healthy instance counts).
//   - stream-bridge.ts's liveStreamProbeHealth watches ONE session's bridge (is this specific input flowing).
// Neither tells you whether the Cloudflare Stream API ITSELF is up. A Stream-side outage or auth regression
// (rotated/revoked token, account suspension, CF incident) would surface only as scattered 5xx/502s on the
// customer-facing provision path (cf-stream-live-client.ts createLiveInput) — indistinguishable at a glance
// from a one-off customer request failure. This probe watches the DEPENDENCY, not a symptom of it.
//
// Reads the SAME list endpoint the provision path depends on transitively (GET .../stream/live_inputs), so a
// green probe means "the exact API surface we provision against is answering", not just "some CF endpoint is
// up". `per_page=1` keeps it a cheap, side-effect-free read.
//
// INERT by default, same convention as container-health-alarm.ts: absent flag or credentials → no network
// call, no KV read/write. NEVER throws — an observability probe riding the same cron as the billing sweepers
// must not be able to take them down.

/** The minimal KV surface the sustain counter needs. Structurally satisfied by a Workers `KVNamespace`. */
export interface CfStreamHealthKv {
	get(key: string): Promise<string | null>;
	put(key: string, value: string, opts?: { expirationTtl?: number }): Promise<void>;
	delete(key: string): Promise<void>;
}

export interface CfStreamHealthDeps {
	fetch: typeof fetch;
	kv?: CfStreamHealthKv;
	log?: (msg: string, fields: Record<string, unknown>) => void;
	now?: () => number;
}

export interface CfStreamHealthEnv {
	CF_API_TOKEN?: string;
	CF_ACCOUNT_ID?: string;
	/** Off unless explicitly "1" — same INERT-by-default convention as the container wedge alarm. */
	CF_STREAM_HEALTH_PROBE_ENABLED?: string;
}

/** KV key holding the consecutive-failure count. Distinct prefix from container-health-alarm's `container-wedge:`. */
const SUSTAIN_KEY = "cf-stream-health:consecutive-failures";
/** Alarm only once a failure SURVIVES this many consecutive ticks — a single blip (transient network hiccup,
 *  one slow response) is not an outage. Mirrors container-health-alarm's WEDGE_SUSTAIN_TICKS reasoning. */
export const CF_STREAM_HEALTH_SUSTAIN_TICKS = 2;
/** Bound the counter's lifetime so a stale key cannot linger forever. */
const SUSTAIN_TTL_S = 3600;

export interface CfStreamHealthResult {
	ok: boolean;
	status?: number;
	latencyMs?: number;
	alarmed: boolean;
}

/**
 * Probe the Cloudflare Stream API once. Read-only (`per_page=1` list call); never mutates any Stream resource.
 *
 * @returns the verdict, so callers/tests can assert on the decision rather than scrape logs.
 */
export async function checkCfStreamHealth(env: CfStreamHealthEnv, deps: CfStreamHealthDeps): Promise<CfStreamHealthResult> {
	const log = deps.log ?? ((msg, fields) => console.log(JSON.stringify({ msg, ...fields })));
	const now = deps.now ?? Date.now;

	if (env.CF_STREAM_HEALTH_PROBE_ENABLED !== "1") return { ok: true, alarmed: false };
	if (!env.CF_API_TOKEN || !env.CF_ACCOUNT_ID) return { ok: true, alarmed: false };

	const started = now();
	let status: number | undefined;
	let ok = false;
	let errorMessage: string | undefined;

	try {
		const res = await deps.fetch(
			`https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/stream/live_inputs?per_page=1`,
			{ headers: { authorization: `Bearer ${env.CF_API_TOKEN}` } },
		);
		status = res.status;
		// CF wraps every reply in a `{success, errors, result}` envelope (same shape cf-stream-live-client.ts
		// checks). A 2xx with `success:false` (auth/scoping regression, malformed request) is NOT healthy —
		// trusting `res.ok` alone would clear the sustain streak on a response that is actually an error.
		const body = (await res.json().catch(() => ({}))) as { success?: boolean };
		ok = res.ok && body.success === true;
	} catch (e) {
		errorMessage = String((e as Error)?.message ?? e).slice(0, 160);
	}
	const latencyMs = now() - started;

	let alarmed = false;
	if (!ok) {
		// A probe failure is itself worth a line — a silent probe failure would recreate the exact blindness
		// this module exists to end.
		log("cf-stream-health-probe-failed", { status: status ?? null, error: errorMessage ?? null, latencyMs });

		// KV get/put are wrapped in their OWN try/catch, separate from the fetch above: a KV outage/transient
		// error must not reject checkCfStreamHealth and skip the alarm-decision log + the heartbeat below —
		// that would recreate exactly the "probe ran but silently did nothing" blindness this module exists to
		// end, just one layer down (a real Stream outage coinciding with a KV hiccup would go unrecorded).
		// On a KV error, fall back to the SAME streak the no-KV-bound branch already uses (SUSTAIN_TICKS - 1) —
		// a KV blip degrades this tick to "as if no persistent counter were configured", not an instant alarm.
		let streak = CF_STREAM_HEALTH_SUSTAIN_TICKS - 1;
		try {
			const prior = deps.kv ? Number((await deps.kv.get(SUSTAIN_KEY)) ?? "0") : streak;
			streak = (Number.isFinite(prior) ? prior : 0) + 1;
			await deps.kv?.put(SUSTAIN_KEY, String(streak), { expirationTtl: SUSTAIN_TTL_S });
		} catch (e) {
			log("cf-stream-health-kv-error", { op: "sustain", error: String((e as Error)?.message ?? e).slice(0, 160) });
		}

		if (streak >= CF_STREAM_HEALTH_SUSTAIN_TICKS) {
			alarmed = true;
			log("cf-stream-health-alarm", { status: status ?? null, error: errorMessage ?? null, streak, latencyMs });
		}
	} else {
		// Any successful reading clears the streak, so a single transient blip cannot accumulate into a false
		// alarm across separate outages. Same isolation as above: a KV error here must not suppress the
		// heartbeat. If the delete itself fails (KV outage/transient error), the stale streak key is left in
		// place — bounded by SUSTAIN_TTL_S (1h) above, so a recovery-time KV hiccup can cause at most one
		// early alarm on the very next failure (never a permanently stuck alarm). `op: "delete"` on the log
		// line disambiguates this recovery-path failure from the sustain-path one above.
		try {
			if (deps.kv) await deps.kv.delete(SUSTAIN_KEY);
		} catch (e) {
			log("cf-stream-health-kv-error", { op: "delete", error: String((e as Error)?.message ?? e).slice(0, 160) });
		}
	}

	// HEARTBEAT — one line per tick, even when everything is fine, so "the probe never fired" and "the probe
	// never ran" produce distinguishable logs (the exact failure class container-health-alarm.ts was built to
	// end). The all-clear is a positive observation you can query for, not an absence you have to trust.
	log("cf-stream-health-tick", { ok, status: status ?? null, latencyMs, alarmed });

	return { ok, status, latencyMs, alarmed };
}

/**
 * Cron entrypoint. Best-effort and non-throwing by construction: this rides the same fifteen-minute tick as
 * the billing-adjacent sweeps, and an observability probe must never be able to take one of those down.
 *
 * NON-OVERLAPPING BY CONSTRUCTION, not by locking: the caller (scheduled.ts) only invokes this from the
 * `!isSweepOnlyTick` branch, and `isSweepOnlyTick` is exactly the every-five-minute cron pattern — the SAME
 * double-invocation hazard that #260 hit for the WHIP sweep (both the every-fifteen-minute and every-five-
 * minute crons fire simultaneously at :00/:15/:30/:45) cannot recur here because the every-five-minute
 * invocation never reaches this call at all. So the SUSTAIN_KEY read-increment-write above is never raced
 * against a concurrent invocation of itself.
 */
export function scheduledCfStreamHealth(env: CfStreamHealthEnv, ctx: ExecutionContext, kv?: CfStreamHealthKv): void {
	ctx.waitUntil(
		// `fetch` MUST be wrapped, not passed by reference — the Workers runtime rejects a bare global `fetch`
		// invoked through another binding with "Illegal invocation" (the exact bug container-health-alarm.ts
		// shipped with once; see its scheduledContainerHealth comment). Wrapping here avoids repeating it.
		checkCfStreamHealth(env, { fetch: (input, init) => fetch(input, init), kv }).then(
			() => undefined,
			(e) => {
				console.log(JSON.stringify({ msg: "cf-stream-health-alarm-error", error: String(e).slice(0, 160) }));
			},
		),
	);
}
