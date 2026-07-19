// #234 — alarm on the container-app WEDGE signature: `active > 0 && healthy == 0`.
//
// WHY THIS EXISTS. Stream bridging was wedged account-wide for an unknown period and NOTHING surfaced it.
// The poll's own telemetry read perfectly healthy the whole time:
//
//     {"msg":"stream-poll-tick","scanned":7,"started":0,"stopped":0,"failed":0,"skipped":0}
//
// `failed:0` because there was nothing live to dispatch — so a total wedge was indistinguishable from a
// quiet night. It was found only by hand-querying the container app during an unrelated live-proof attempt:
//
//     "instances": { "active": 5, "assigned": 0, "healthy": 0, "stopped": 0, "failed": 0, ... }
//
// Note `failed: 0` in that state: the zombies are not counted as failures, which is exactly why no
// failure-based alert could ever have caught it. #232 fixed the one KNOWN leak path (release-on-failed-start)
// and raised max_instances 5 → 30. This watches the OUTCOME instead, so a future leak from a different cause
// surfaces in minutes rather than by accident.
//
// This module is the third of #231's three named fix directions; #232 shipped the other two.
//
// INERT by default, in this repo's usual shape: with no CF_API_TOKEN / CF_ACCOUNT_ID, or with the flag off,
// it does nothing at all. It NEVER throws — an observability probe that can take down the cron that carries
// the billing sweeper would be a strictly worse trade than the blindness it replaces.

/** The health rollup CF reports per container application. Only the fields we act on are modelled. */
export interface ContainerInstanceHealth {
	active?: number;
	assigned?: number;
	healthy?: number;
	stopped?: number;
	failed?: number;
	scheduling?: number;
	starting?: number;
}

export interface ContainerApp {
	id: string;
	name: string;
	max_instances?: number;
	health?: { instances?: ContainerInstanceHealth };
}

export type AlarmVerdict = "wedged" | "at-capacity" | "ok";

/**
 * Classify one app's health rollup. Pure, so the signature is unit-testable without any network.
 *
 * `wedged` = `active > 0 && healthy === 0`: every instance is a zombie — occupying a slot, serving nothing.
 * It is unambiguous and cheap to read.
 *
 * DELIBERATE — `starting > 0` is NOT wedged. A rollout legitimately shows active-but-not-yet-healthy for a
 * minute or two (observed directly during the v7 rollout: `healthy:2, starting:5`). Alarming on that would
 * fire on every single deploy, and an alarm that cries wolf on routine operations is one people learn to
 * ignore — which would leave us exactly as blind as we were before. The sustain counter below is the second
 * guard on the same concern.
 *
 * `at-capacity` (`active >= max_instances`) is the precursor worth knowing about: legitimate at 30 concurrent
 * broadcasts, but indistinguishable from a leak without looking, so it is reported at a lower severity.
 */
export function classifyContainerHealth(app: ContainerApp): AlarmVerdict {
	const h = app.health?.instances;
	if (!h) return "ok"; // no rollup reported — absence is not evidence (#229); say nothing rather than guess
	const active = h.active ?? 0;
	const healthy = h.healthy ?? 0;
	const starting = h.starting ?? 0;

	if (active > 0 && healthy === 0 && starting === 0) return "wedged";

	const max = app.max_instances ?? 0;
	if (max > 0 && active >= max) return "at-capacity";
	return "ok";
}

/** KV key holding the consecutive-tick count for an app's wedge verdict. */
const sustainKey = (appId: string) => `container-wedge:${appId}`;
/** Alarm only once the signature SURVIVES this many consecutive ticks (~2 poll intervals, per #234). */
export const WEDGE_SUSTAIN_TICKS = 2;
/** Bound the counter's lifetime so a long-gone app cannot leave a key behind forever. */
const SUSTAIN_TTL_S = 3600;

export interface AlarmDeps {
	fetch: typeof fetch;
	kv?: KVNamespace;
	log?: (msg: string, fields: Record<string, unknown>) => void;
}

export interface AlarmEnv {
	CF_API_TOKEN?: string;
	CF_ACCOUNT_ID?: string;
	/** Off unless explicitly "1" — same INERT-by-default convention as the sweeper and the poll. */
	CONTAINER_HEALTH_ALARM_ENABLED?: string;
}

/**
 * Read every container application's health rollup and alarm on the wedge signature.
 *
 * Reads the APPLICATIONS list, deliberately:
 *   GET /accounts/{account_id}/containers/applications   → .result[].health.instances
 *
 * DO NOT switch this to `GET /containers/applications/{id}/instances`. That endpoint returned an EMPTY
 * ARRAY for every application in the account, including ones certainly running — its silence is
 * indistinguishable from "no instances", so it cannot carry an alarm. Same trap as #229, and the same
 * reasoning-from-absence mistake that has bitten this repo repeatedly.
 *
 * @returns the apps that alarmed, so callers/tests can assert on the decision rather than scrape logs.
 */
export async function checkContainerHealth(env: AlarmEnv, deps: AlarmDeps): Promise<{ verdicts: Array<{ app: string; verdict: AlarmVerdict; alarmed: boolean }> }> {
	const log = deps.log ?? ((msg, fields) => console.log(JSON.stringify({ msg, ...fields })));
	const out: Array<{ app: string; verdict: AlarmVerdict; alarmed: boolean }> = [];

	if (env.CONTAINER_HEALTH_ALARM_ENABLED !== "1") return { verdicts: out };
	if (!env.CF_API_TOKEN || !env.CF_ACCOUNT_ID) return { verdicts: out };

	let apps: ContainerApp[];
	try {
		const res = await deps.fetch(
			`https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/containers/applications`,
			{ headers: { authorization: `Bearer ${env.CF_API_TOKEN}` } },
		);
		if (!res.ok) {
			// A probe failure is itself worth a line — a SILENT probe failure would recreate the exact blindness
			// this module exists to end.
			log("container-health-probe-failed", { status: res.status });
			return { verdicts: out };
		}
		const body = (await res.json()) as { result?: ContainerApp[] };
		apps = Array.isArray(body.result) ? body.result : [];
	} catch (e) {
		log("container-health-probe-failed", { error: String(e).slice(0, 160) });
		return { verdicts: out };
	}

	for (const app of apps) {
		const verdict = classifyContainerHealth(app);
		let alarmed = false;

		if (verdict === "wedged") {
			// Require the signature to SURVIVE consecutive ticks. A single-tick reading can be a rollout or a
			// scheduling blip; a sustained one cannot. Without KV we cannot count, so we alarm immediately —
			// a possible duplicate line is a far cheaper failure than staying silent.
			const prior = deps.kv ? Number((await deps.kv.get(sustainKey(app.id))) ?? "0") : WEDGE_SUSTAIN_TICKS - 1;
			const streak = (Number.isFinite(prior) ? prior : 0) + 1;
			await deps.kv?.put(sustainKey(app.id), String(streak), { expirationTtl: SUSTAIN_TTL_S });

			if (streak >= WEDGE_SUSTAIN_TICKS) {
				alarmed = true;
				log("container-wedge-alarm", {
					app: app.name,
					appId: app.id,
					streak,
					// Carry the rollup verbatim: the counts ARE the diagnosis, and `failed:0` alongside
					// `healthy:0` is the detail that makes this signature recognisable at a glance.
					instances: app.health?.instances ?? null,
				});
			}
		} else {
			// Any non-wedged reading clears the streak, so a transient blip cannot accumulate across an hour
			// into a false alarm.
			if (deps.kv) await deps.kv.delete(sustainKey(app.id));
			if (verdict === "at-capacity") {
				alarmed = true;
				log("container-at-capacity", {
					app: app.name,
					appId: app.id,
					active: app.health?.instances?.active ?? 0,
					max: app.max_instances ?? 0,
				});
			}
		}

		out.push({ app: app.name, verdict, alarmed });
	}

	// HEARTBEAT — one line per tick, even when everything is fine.
	//
	// Without this the module is SILENT on success, which makes "the alarm never fired" and "the alarm never
	// ran" produce byte-identical logs. That is the exact failure this file was written to end (#231's wedge
	// hid behind `failed:0`; #235 behind `{ok:true}`; #241 behind `started:0`), and it would have been
	// self-inflicted here: an unprovable watchdog is not a watchdog. The counts also make the all-clear a
	// POSITIVE observation you can query for, rather than an absence you have to trust.
	log("container-health-tick", {
		apps: out.length,
		wedged: out.filter((v) => v.verdict === "wedged").length,
		atCapacity: out.filter((v) => v.verdict === "at-capacity").length,
		alarmed: out.filter((v) => v.alarmed).length,
	});

	return { verdicts: out };
}

/**
 * Cron entrypoint. Best-effort and non-throwing by construction: the cron it rides also carries the WHIP
 * billing sweeper, and an observability probe must never be able to take that down.
 */
export function scheduledContainerHealth(env: AlarmEnv, ctx: ExecutionContext, kv?: KVNamespace): void {
	ctx.waitUntil(
		// `fetch` MUST be wrapped, not passed by reference. The Workers runtime rejects a bare global `fetch`
		// invoked through another binding with:
		//   TypeError: Illegal invocation: function called with incorrect `this` reference
		// This shipped unbound and the alarm was 100% non-functional in production from its first tick — every
		// run died inside the try/catch. The ONLY reason it was caught within the hour is that the catch logs
		// `container-health-probe-failed` loudly instead of returning quietly, which is the whole thesis of
		// this module. A silent catch here would have left a watchdog that looked deployed and did nothing.
		checkContainerHealth(env, { fetch: (input, init) => fetch(input, init), kv }).then(
			() => undefined,
			(e) => {
				console.log(JSON.stringify({ msg: "container-health-alarm-error", error: String(e).slice(0, 160) }));
			},
		),
	);
}
