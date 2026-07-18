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

/** The CF lifecycle endpoint's shape: `{ isInput, videoUID, live }`. */
export interface LifecycleState {
  live: boolean;
  videoUID: string | null;
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
  log?(msg: string, fields: Record<string, unknown>): void;
}

export interface PollResult {
  scanned: number;
  started: number;
  stopped: number;
  failed: number;
  skipped: number;
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
  const out: PollResult = { scanned: 0, started: 0, stopped: 0, failed: 0, skipped: 0 };
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

    if (state.live && !active) {
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
      }
      continue;
    }

    if (!state.live && active) {
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
}

/** Live PollDeps: KV for inventory + session state, the public lifecycle endpoint for the probe. */
export function livePollDeps(
  env: PollRuntimeEnv,
  dispatch: {
    dispatchStart(org: string, uid: string, room: string): Promise<void>;
    dispatchStop(org: string, uid: string): Promise<void>;
  },
  fetchFn: typeof fetch = fetch,
): PollDeps | null {
  const kv = env.RT_MEETING_ORG;
  const code = env.CF_STREAM_CUSTOMER_CODE ?? env.CLOUDFLARE_STREAM_CUSTOMER_CODE;
  if (!kv || !code) return null; // unconfigured → inert, never a half-working poll

  const log = (msg: string, fields: Record<string, unknown>) => console.log(JSON.stringify({ msg, ...fields }));

  return {
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
        const j = (await res.json()) as { live?: unknown; videoUID?: unknown };
        if (typeof j.live !== "boolean") return null; // unrecognised shape → skip, never guess
        return { live: j.live, videoUID: typeof j.videoUID === "string" ? j.videoUID : null };
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
  },
): void {
  // Every exit path from here is LOUD. The first cut of this function returned early in silence when a
  // precondition was missing, and when the first live tick produced nothing there was no way to tell
  // "inert" from "ran and found nothing" from "threw" — which is the exact silent-no-op failure mode
  // that made #8 take three diagnoses. An unobservable control plane is the bug, not a detail of it.
  const log = (msg: string, fields: Record<string, unknown>) => console.log(JSON.stringify({ msg, ...fields }));

  const enabled = streamBridgeEnabled(env);
  const hasKv = Boolean(env.RT_MEETING_ORG);
  const hasCode = Boolean(env.CF_STREAM_CUSTOMER_CODE ?? env.CLOUDFLARE_STREAM_CUSTOMER_CODE);

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
