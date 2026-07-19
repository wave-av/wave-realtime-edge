/**
 * #8 — CRON LIFECYCLE POLL: the primary way the bridge learns a live input went live or went away.
 *
 * WHY THIS EXISTS (2026-07-18 outage): the bridge was built to dispatch off a CF Stream
 * `live_input.connected` webhook — which was NEVER SUBSCRIBED. CF Stream has two distinct
 * notification mechanisms and we only ever configured the wrong one:
 *
 *   /accounts/{id}/stream/webhook            -> VOD **video-ready** webhook (a recording finished).
 *                                               This is what we had. Its payload is a VIDEO object
 *                                               whose uid is the RECORDING's uid, not the input's.
 *   alerting policy `stream_live_notifications` -> the live_input.connected/disconnected LIFECYCLE
 *                                               events. No such policy existed on the account.
 *
 * So no push ever produced a dispatch or a meter row. Polling the input's own lifecycle endpoint
 * removes the dependency on that subscription entirely: it is self-healing (a missed or delayed
 * event cannot strand an input), needs no CF-side config, and needs no second webhook auth scheme
 * (CF alerting webhooks sign with their own secret, not our WAVE_STREAM_WEBHOOK_SECRET).
 *
 * An event-driven webhook may be added later as a LATENCY optimisation — but this poll stays as the
 * backstop. A single delivery path that can silently stop delivering is what caused this outage.
 */

import {
  STREAM_INPUT_ORG_PREFIX,
  bridgeRoomFor,
  streamBridgeEnabled,
  type StreamBridgeRuntimeEnv,
} from "./stream-bridge";

/** KV prefix recording an input we have an ACTIVE bridge session for (the poll's edge-trigger state). */
export const STREAM_LIVE_PREFIX = "stream-bridge-live:";

/** A live session outlives a long broadcast but must not leak forever if a stop is somehow missed. */
export const STREAM_LIVE_TTL_SECONDS = 60 * 60 * 12; // 12h

/** Inputs examined per cron tick. Bounds worst-case tick cost as the account's input count grows. */
export const MAX_INPUTS_PER_TICK = 200;

/** Explicit timeout on every lifecycle probe — an unbounded hang would stall the whole tick. */
export const LIFECYCLE_TIMEOUT_MS = 5_000;

/** Cap on authenticated live_inputs status probes per tick (#241 detector is diagnostic, not load-bearing). */
export const MAX_STATE_PROBES_PER_TICK = 20;

/**
 * The CF lifecycle endpoint's OBSERVED shape: `{ isInput, videoUID, live, status, chunked }`.
 *
 * `live: true` alone does NOT mean media is flowing — that misreading cost a round of container
 * thrash. Two real responses, captured 2026-07-18:
 *
 *   idle input   -> {"isInput":true,"videoUID":"unknown","live":true, "status":"ready"}
 *   disconnected -> {"isInput":true,"videoUID":null,     "live":false,"status":"disconnected"}
 *
 * The first is an input that merely EXISTS and is ready to receive. Dispatching on it made the
 * container answer `502 source leg failed (no live media)` on every tick, for every idle input.
 * A concrete `videoUID` is the signal that a broadcast is actually running — see `mediaIsFlowing`.
 */
export interface LifecycleState {
  live: boolean;
  videoUID: string | null;
  /** Diagnostic only ("ready" / "disconnected" / …). Optional so callers need not synthesise it. */
  status?: string | null;
}

/** The sentinel CF returns in `videoUID` for an input that is ready but carrying no broadcast. */
export const VIDEO_UID_UNKNOWN = "unknown";

/**
 * Is a broadcast ACTUALLY running on this input?
 *
 * Requires BOTH `live` and a concrete `videoUID`. Fail-safe direction matters here: a false positive
 * spins up a container that 502s and is retried every tick forever (cost + noise), while a false
 * negative costs at most one 5-minute tick of latency, because the next poll re-evaluates.
 */
export function mediaIsFlowing(state: LifecycleState): boolean {
  return state.live && typeof state.videoUID === "string" && state.videoUID !== VIDEO_UID_UNKNOWN;
}

/** Injected seam so every path unit-tests with no network and no KV. */
export interface PollDeps {
  /** All known input uids with their org (live: KV list on the stream-input-org: prefix). */
  listInputs(): Promise<{ uid: string; org: string }[]>;
  /** Probe one input's live state. Null → probe failed; the poll SKIPS (never guesses a transition). */
  probeLifecycle(uid: string): Promise<LifecycleState | null>;
  /** True iff we currently hold a bridge session for this input. */
  hasSession(uid: string): Promise<boolean>;
  /** Record / clear the session edge-trigger state. */
  openSession(uid: string, org: string, room: string): Promise<void>;
  closeSession(uid: string): Promise<void>;
  dispatchStart(org: string, uid: string, room: string): Promise<void>;
  dispatchStop(org: string, uid: string): Promise<void>;
  /**
   * Ask the CONTAINER whether it is actually relaying (#247). `null` = could not tell, and is treated as
   * such — never as dead. Optional so existing callers/tests are unaffected; absent → the reconcile below
   * is skipped entirely and behaviour is byte-identical to before.
   */
  probeHealth?(org: string, uid: string): Promise<{ bridging: boolean; tracks: number } | null>;
  /**
   * The INPUT's RTMP connection state from the live_inputs API (#241) — `"connected"`, `"disconnected"`,
   * or null when unreadable. Distinct from `probeLifecycle`, which reads the unauthenticated lifecycle
   * endpoint and CANNOT tell an idle input apart from one that is receiving media without a videoUID.
   * Optional; absent → the mismatch detector below is skipped.
   */
  probeInputState?(uid: string): Promise<string | null>;
  log?(msg: string, fields: Record<string, unknown>): void;
}

export interface PollResult {
  scanned: number;
  started: number;
  stopped: number;
  failed: number;
  skipped: number;
  /** Sessions the CONTAINER reported dead while the input was still live → record cleared for re-dispatch (#247). */
  revived: number;
  /** Inputs RTMP-connected but with no concrete videoUID — a customer pushing media we are NOT bridging (#241). */
  connectedNoVideo: number;
  /**
   * Bridges the container CONFIRMED alive this tick (an explicit `bridging:true`).
   *
   * Without this, `revived:0` is ambiguous: it reads the same whether the probe said "healthy" or could not
   * answer at all — so a totally broken /health path would look exactly like a fleet of healthy bridges.
   * That is the same silence-is-not-evidence defect as #231/#235/#241, and it made the first live proof of
   * this feature unfalsifiable until this counter existed. `healthy + unknown` should equal the number of
   * active bridges; when `unknown` dominates, the probe itself is broken, not the fleet.
   */
  healthy: number;
  /** Active bridges whose health could NOT be determined (timeout, 5xx, absent binding, stale image). */
  healthUnknown: number;
}

/**
 * One cron tick: for every known input, dispatch on the EDGE of its live state.
 *
 *   live && !session -> start (then record the session)
 *   !live && session -> stop  (then clear it)
 *
 * Edge-triggered, not level-triggered, so a still-live input is not re-dispatched every 5 minutes.
 * The session record is written only AFTER a successful start, so a failed start is retried on the
 * next tick rather than being recorded as running. A failed probe is skipped, never guessed:
 * inventing `live:false` would tear down a healthy broadcast.
 */
export async function pollStreamLifecycles(deps: PollDeps): Promise<PollResult> {
  const out: PollResult = { scanned: 0, started: 0, stopped: 0, failed: 0, skipped: 0, revived: 0, connectedNoVideo: 0, healthy: 0, healthUnknown: 0 };
  // Bound the authenticated status probes per tick. The detector below is diagnostic, not load-bearing, and
  // must not turn a 200-input account into 200 extra API calls every five minutes.
  let stateProbeBudget = MAX_STATE_PROBES_PER_TICK;
  const inputs = (await deps.listInputs()).slice(0, MAX_INPUTS_PER_TICK);

  for (const { uid, org } of inputs) {
    out.scanned++;
    const state = await deps.probeLifecycle(uid).catch(() => null);
    if (!state) {
      out.skipped++;
      deps.log?.("stream-poll-probe-failed", { uid, org });
      continue;
    }

    const active = await deps.hasSession(uid).catch(() => false);
    const flowing = mediaIsFlowing(state);

    if (flowing && !active) {
      const room = bridgeRoomFor(uid); // deterministic → a duplicate start joins the same room
      try {
        await deps.dispatchStart(org, uid, room);
        await deps.openSession(uid, org, room);
        out.started++;
        deps.log?.("stream-poll-started", { uid, org, room, videoUID: state.videoUID });
      } catch (err) {
        // No session recorded → the next tick retries. Loud, never silent.
        out.failed++;
        deps.log?.("stream-poll-start-failed", { uid, org, room, error: String(err) });

        // RELEASE THE INSTANCE. A failed `/start` still leaves the container DO instance ACTIVE but never
        // HEALTHY, and because no session was recorded nothing else will ever stop it — so the slot is held
        // forever. Five such failures exhausted `max_instances` and wedged stream bridging account-wide
        // (observed 2026-07-19: active:5, healthy:0; every real broadcast then 500'd with "Maximum number of
        // running container instances exceeded"). Best-effort and non-throwing: a failed release must not
        // mask the start error above, and must not abort the rest of the tick.
        await deps
          .dispatchStop(org, uid)
          .then(() => deps.log?.("stream-poll-start-released", { uid, org }))
          .catch((releaseErr) =>
            deps.log?.("stream-poll-start-release-failed", { uid, org, error: String(releaseErr) }),
          );
      }
      continue;
    }

    // LIVE INPUT, SESSION RECORDED — previously a total no-op, and that silence hid two real failures (#247).
    //
    // The session record alone was treated as proof the bridge was working. It is not: it only proves a
    // /start once succeeded. If the container has since died — crashed, been evicted, or been DRAINED by a
    // rollout (#235, now the expected path on every deploy) — the record SURVIVES, `hasSession` keeps
    // answering true, and the poll never re-dispatches. The customer's broadcast stays dark until the KV
    // TTL expires, while `stream-poll-tick` reports a clean `started:0` throughout.
    //
    // So ask the container itself. This is the first consumer of the truthful /health #236 shipped — until
    // now that sensor was built, deployed, and read by nothing.
    //
    // FAIL SAFE, DELIBERATELY: only an explicit `bridging:false` clears the record. `null` (timeout, 5xx,
    // absent binding, or an OLD image that answers `{ok:true}` with no `bridging` field) means "cannot tell"
    // and changes nothing. Tearing down a healthy broadcast on a transient blip is far worse than a late
    // re-dispatch, and reading absence as death is the single most repeated defect in this subsystem.
    if (flowing && active && deps.probeHealth) {
      const health = await deps.probeHealth(org, uid).catch(() => null);
      if (!health) out.healthUnknown++;
      else if (health.bridging) out.healthy++;
      if (health && !health.bridging) {
        // Clear the record only. The NEXT tick's `flowing && !active` edge does the actual re-dispatch, so
        // this reuses the one start path that already handles failure, instance release, and logging —
        // rather than opening a second way to start a bridge.
        try {
          await deps.dispatchStop(org, uid); // release the dead instance's slot (#231) before re-starting
        } catch (err) {
          deps.log?.("stream-poll-revive-stop-failed", { uid, org, error: String(err) });
        }
        await deps.closeSession(uid);
        out.revived++;
        deps.log?.("stream-poll-bridge-dead", { uid, org, tracks: health.tracks, videoUID: state.videoUID });
      }
      continue;
    }

    // #241 — RTMP-CONNECTED BUT NO videoUID: a customer is pushing real media and we are not bridging it.
    //
    // Observed 2026-07-19: a 13-minute push, ffmpeg exit 0, CF reporting {"state":"connected"} the whole
    // window — and ZERO dispatches, because CF never minted a videoUID. Every tick logged
    // {"scanned":7,"started":0,"failed":0,"skipped":0}, which is byte-identical to a quiet night. The
    // customer's stream was up; from our telemetry nothing was wrong.
    //
    // The lifecycle endpoint alone CANNOT distinguish this: an idle-ready input and a receiving-but-unminted
    // input can both read {live:true, videoUID:"unknown"}. Only the authenticated live_inputs API carries the
    // RTMP connection state (`.result.status.current.state`, verified against the live API), so the detector
    // needs that second probe — which is exactly why this state was invisible for so long.
    //
    // DIAGNOSTIC ONLY. It deliberately does NOT dispatch. Widening mediaIsFlowing to accept the "unknown"
    // sentinel would bridge idle inputs, burning container instances and billing customers for dead air —
    // the fail-safe direction is the one already coded, and the real fix belongs upstream of the check.
    // What this does is turn an ABSENCE into a named, queryable condition.
    if (!flowing && !active && deps.probeInputState && stateProbeBudget > 0) {
      stateProbeBudget--;
      const inputState = await deps.probeInputState(uid).catch(() => null);
      if (inputState === "connected") {
        out.connectedNoVideo++;
        deps.log?.("stream-poll-connected-no-video", {
          uid,
          org,
          inputState,
          videoUID: state.videoUID,
          status: state.status ?? null,
        });
      }
    }

    if (!flowing && active) {
      try {
        await deps.dispatchStop(org, uid);
        await deps.closeSession(uid);
        out.stopped++;
        deps.log?.("stream-poll-stopped", { uid, org });
      } catch (err) {
        // Session record LEFT IN PLACE so the stop is retried — dropping it would strand the meter open.
        out.failed++;
        deps.log?.("stream-poll-stop-failed", { uid, org, error: String(err) });
      }
    }
  }

  deps.log?.("stream-poll-tick", { ...out });
  return out;
}

/** Build the lifecycle probe URL. Secret-free and deterministic (same construction as the WHEP path). */
export function lifecycleUrl(code: string, uid: string): string {
  return `https://customer-${code}.cloudflarestream.com/${uid}/lifecycle`;
}

interface PollRuntimeEnv extends StreamBridgeRuntimeEnv {
  CF_STREAM_CUSTOMER_CODE?: string;
  CLOUDFLARE_STREAM_CUSTOMER_CODE?: string;
  /** #241 — Stream:Read token for the live_inputs status probe. Absent → the detector is inert. */
  CLOUDFLARE_STREAM_API_TOKEN?: string;
  CF_ACCOUNT_ID?: string;
}

/**
 * Read one input's RTMP connection state (#241).
 *
 * Shape verified against the live API 2026-07-19, not assumed:
 *   {"result":{"status":{"current":{"state":"disconnected","reason":"client_disconnect",...}}}}
 *
 * Returns null on ANY failure — the caller treats null as "cannot tell" and does nothing, so a flaky
 * status API can never manufacture a false #241 report.
 */
export async function liveProbeInputState(
  env: PollRuntimeEnv,
  uid: string,
  fetchFn: typeof fetch = fetch,
): Promise<string | null> {
  try {
    const res = await fetchFn(
      `https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/stream/live_inputs/${uid}`,
      { headers: { authorization: `Bearer ${env.CLOUDFLARE_STREAM_API_TOKEN}` } },
    );
    if (!res.ok) return null;
    const body = (await res.json()) as { result?: { status?: { current?: { state?: unknown } } } };
    const state = body.result?.status?.current?.state;
    return typeof state === "string" ? state : null;
  } catch {
    return null;
  }
}

/**
 * Resolve the Stream customer code, skipping EMPTY bindings.
 *
 * `??` was wrong here and cost a full diagnosis cycle: it falls through only on null/undefined, so a
 * secret bound to the EMPTY STRING (which is what `wrangler secret put` does when its input is empty)
 * SHADOWED the working fallback and made the poll report `hasCode:false` on every tick. The binding
 * looked correct from outside — the CF API listed the secret as present — while being falsy inside the
 * isolate. Any config read whose "missing" case is falsy-but-not-nullish needs truthiness, not `??`.
 */
export function customerCodeOf(env: PollRuntimeEnv): string | undefined {
  return [env.CF_STREAM_CUSTOMER_CODE, env.CLOUDFLARE_STREAM_CUSTOMER_CODE].find(
    (v): v is string => typeof v === "string" && v.trim() !== "",
  );
}

/** Live PollDeps: KV for inventory + session state, the public lifecycle endpoint for the probe. */
export function livePollDeps(
  env: PollRuntimeEnv,
  dispatch: {
    dispatchStart(org: string, uid: string, room: string): Promise<void>;
    dispatchStop(org: string, uid: string): Promise<void>;
    /** #247 — container self-report. Optional: absent → the dead-bridge reconcile is skipped entirely. */
    probeHealth?(org: string, uid: string): Promise<{ bridging: boolean; tracks: number } | null>;
  },
  fetchFn: typeof fetch = fetch,
): PollDeps | null {
  const kv = env.RT_MEETING_ORG;
  const code = customerCodeOf(env);
  if (!kv || !code) return null; // unconfigured → inert, never a half-working poll

  const log = (msg: string, fields: Record<string, unknown>) => console.log(JSON.stringify({ msg, ...fields }));

  return {
    probeHealth: dispatch.probeHealth,
    // #241 — authenticated input-state probe. Inert without the Stream token, so an env that lacks it keeps
    // today's behaviour rather than logging a failure every tick.
    probeInputState: env.CLOUDFLARE_STREAM_API_TOKEN && env.CF_ACCOUNT_ID
      ? (uid) => liveProbeInputState(env, uid, fetchFn)
      : undefined,
    listInputs: async () => {
      const listed = await kv.list({ prefix: STREAM_INPUT_ORG_PREFIX, limit: MAX_INPUTS_PER_TICK });
      const rows = await Promise.all(
        listed.keys.map(async (k) => {
          const uid = k.name.slice(STREAM_INPUT_ORG_PREFIX.length);
          const org = await kv.get(k.name);
          return org ? { uid, org } : null;
        }),
      );
      return rows.filter((r): r is { uid: string; org: string } => r !== null);
    },
    probeLifecycle: async (uid) => {
      // Explicit timeout: an unbounded probe would stall every remaining input in the tick.
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), LIFECYCLE_TIMEOUT_MS);
      try {
        const res = await fetchFn(lifecycleUrl(code, uid), { signal: ac.signal });
        if (!res.ok) return null;
        const j = (await res.json()) as { live?: unknown; videoUID?: unknown; status?: unknown };
        if (typeof j.live !== "boolean") return null; // unrecognised shape → skip, never guess
        return {
          live: j.live,
          videoUID: typeof j.videoUID === "string" ? j.videoUID : null,
          status: typeof j.status === "string" ? j.status : null,
        };
      } catch {
        return null;
      } finally {
        clearTimeout(timer);
      }
    },
    hasSession: async (uid) => (await kv.get(`${STREAM_LIVE_PREFIX}${uid}`)) !== null,
    openSession: async (uid, org, room) => {
      await kv.put(`${STREAM_LIVE_PREFIX}${uid}`, JSON.stringify({ org, room }), {
        expirationTtl: STREAM_LIVE_TTL_SECONDS,
      });
    },
    closeSession: async (uid) => {
      await kv.delete(`${STREAM_LIVE_PREFIX}${uid}`);
    },
    dispatchStart: dispatch.dispatchStart,
    dispatchStop: dispatch.dispatchStop,
    log,
  };
}

/** Cron delegate for scheduled(): INERT unless the bridge is enabled AND KV + customer code are present. */
export function scheduledStreamPoll(
  env: PollRuntimeEnv,
  ctx: { waitUntil(p: Promise<unknown>): void },
  dispatch: {
    dispatchStart(org: string, uid: string, room: string): Promise<void>;
    dispatchStop(org: string, uid: string): Promise<void>;
    /** #247 — container self-report. Optional: absent → the dead-bridge reconcile is skipped entirely. */
    probeHealth?(org: string, uid: string): Promise<{ bridging: boolean; tracks: number } | null>;
  },
): void {
  // Every exit path from here is LOUD. The first cut of this function returned early in silence when a
  // precondition was missing, and when the first live tick produced nothing there was no way to tell
  // "inert" from "ran and found nothing" from "threw" — which is the exact silent-no-op failure mode
  // that made #8 take three diagnoses. An unobservable control plane is the bug, not a detail of it.
  const log = (msg: string, fields: Record<string, unknown>) => console.log(JSON.stringify({ msg, ...fields }));

  const enabled = streamBridgeEnabled(env);
  const hasKv = Boolean(env.RT_MEETING_ORG);
  const hasCode = Boolean(customerCodeOf(env));

  if (!enabled || !hasKv || !hasCode) {
    log("stream-poll-inert", { enabled, hasKv, hasCode });
    return;
  }

  const deps = livePollDeps(env, dispatch);
  if (!deps) {
    log("stream-poll-inert", { enabled, hasKv, hasCode, reason: "livePollDeps-null" });
    return;
  }

  // A throw anywhere in the tick (e.g. KV list failing) must surface, not vanish into a rejected
  // waitUntil — the tick's own summary log only runs on the success path.
  ctx.waitUntil(
    pollStreamLifecycles(deps).catch((err) => log("stream-poll-tick-failed", { error: String(err) })),
  );
}
