/// <reference types="@cloudflare/workers-types" />
/**
 * E3n (wre#290) — Axis A2: cron-sweep completion correlation, extending the same poll-is-backstop
 * philosophy `stream-bridge-poll.ts` already uses (2026-07-18 outage doc there). We do NOT parse a
 * `liveInput` back-reference off the CF Stream "video-ready" webhook (`stream-bridge.ts:215-221`) — that
 * field is UNVERIFIED (no captured payload proves it exists on that event). Instead, for every live input
 * WE already know about (the same `stream-input-org:` forward KV the poll reads), list CF's videos FILTERED
 * BY that liveInput uid and correlate a completed one straight back to its owning org. Self-healing (a
 * missed/delayed webhook cannot strand a recording) and needs no new CF-side subscription.
 *
 * PIPELINE per completed recording: dedupe check → pull bytes to R2 (`e3n-recording-pull.ts`, B1) → register
 * with the gateway (`recordings-register.ts`, metadata-only, NEVER fetches bytes itself — this is why the
 * pull happens first) → mark registered. Fail-safe at every step: a pull failure or register failure is
 * logged and the recording is retried on the NEXT tick — it is never marked registered without provably
 * durable bytes AND a successful register, so a failure can neither wedge the cron nor double-bill.
 *
 * IDEMPOTENCY (mirrors `rtk-webhook.ts`'s re-delivery safety): the R2 key is deterministic
 * (`e3nRecordingKey`), so a re-pull overwrites the SAME object rather than duplicating storage, AND a local
 * KV marker (`e3n-registered:{videoUid}`) is set ONLY after a successful register — so a re-sweep of an
 * already-registered recording is a single cheap KV read, never a second pull/register call.
 *
 * OUT OF SCOPE (declared, not built here — see PR body): no VOD/recording meter emit (SKU absent — a
 * gateway/pricing add); no retention (issue #7 absent — flag stays OFF until it exists); no
 * multi-asset grouping (issue #11 — N reconnects register as N ungrouped rows, same as the live-input KV
 * itself already is).
 */
import { STREAM_INPUT_ORG_PREFIX } from "./stream-bridge.js";
import {
  e3nRecordingKey,
  isCompletedRecording,
  listCfVideosForLiveInput,
  pullCfRecordingBytes,
  requestCfDownloadUrl,
  type CfVideoSummary,
} from "./e3n-recording-pull.js";
import { registerRecording, type RegisterConfig } from "./recordings-register.js";
import { e3nAutorecordEnabled, type E3nAutorecordEnv } from "./e3n-autorecord.js";
import { regionForBinding } from "./region-registry.js";

/** Bound on how many known live inputs the sweep examines per tick — bounds worst-case tick cost as the
 *  account's input count grows (mirrors `stream-bridge-poll.ts`'s MAX_INPUTS_PER_TICK). */
export const MAX_SWEEP_INPUTS_PER_TICK = 100;

/** KV prefix for the local dedupe marker (`e3n-registered:{videoUid}` → "1"). Distinct from every other
 *  prefix on RT_MEETING_ORG so it never collides. */
export const E3N_REGISTERED_PREFIX = "e3n-registered:";
/** TTL for the dedupe marker — long enough that no realistic re-sweep window outlives it, short enough the
 *  KV namespace doesn't grow unbounded across the account's lifetime. */
export const E3N_REGISTERED_TTL_SECONDS = 60 * 60 *24 * 90; // 90d

/** The residency-consistent placement E3n recordings land in — the SAME `RT_RECORDINGS_ENAM` jurisdiction
 *  pair the proven RT-P2.5 residency path (`rtk-webhook.ts` + `residency-sink.ts`) uses, DERIVED from the
 *  region-registry SSOT (never a hand-kept literal — `registries-consolidated`) so a built register() call
 *  is guaranteed gateway-allowlisted (never `residency_bucket_mismatch`). E3n has no per-session
 *  `request.cf.continent` to derive a zone from (CF Stream inputs are pushed to, not joined), so it uses
 *  this single fixed placement for W1 (single-tenant, single-region) rather than inventing one. */
const E3N_RECORDING_REGION = regionForBinding("RT_RECORDINGS_ENAM");
export const E3N_RECORDING_ZONE = E3N_RECORDING_REGION?.zone ?? "us-east";
export const E3N_RECORDING_BUCKET_NAME = E3N_RECORDING_REGION?.bucketName ?? "wave-recordings-enam";

export interface E3nSweepResult {
  scanned: number;
  completed: number;
  alreadyRegistered: number;
  registered: number;
  pullPending: number;
  pullFailed: number;
  registerFailed: number;
  missingOrg: number;
}

/** Injected seam so the whole sweep unit-tests with no real network/KV/R2 (mirrors PollDeps). */
export interface E3nSweepDeps {
  /** Every live input we have a forward org binding for (KV list on `stream-input-org:`). */
  listLiveInputs(): Promise<{ uid: string }[]>;
  /** Re-resolve a live input's org FRESH at pull time (defends a TTL-expired/deleted binding mid-sweep —
   *  never pulls/registers without a real org). Null → the input is skipped this tick (missingOrg++). */
  resolveOrg(uid: string): Promise<string | null>;
  /** List CF's videos for one live input. Null → CF call failed; the input is skipped, retried next tick. */
  listVideosForInput(uid: string): Promise<CfVideoSummary[] | null>;
  /** True iff this video is already durably registered (local dedupe marker). */
  isRegistered(videoUid: string): Promise<boolean>;
  /** Mark a video registered (called ONLY after a successful register()). */
  markRegistered(videoUid: string): Promise<void>;
  /** B1: provision/pull the download into R2. `null` → not yet ready or a pull failure (fail-safe: retry
   *  next tick, distinguished only in logs — both are equally "not durable yet" to the caller). */
  pullToR2(video: CfVideoSummary, org: string): Promise<{ r2Key: string; bucket: string } | null>;
  /** Register the durable R2 object with the gateway. */
  register(input: { org: string; r2Key: string; bucket: string; zone: string }): Promise<{ ok: boolean }>;
  log?(msg: string, fields: Record<string, unknown>): void;
}

/**
 * One cron tick. For each known live input, list its CF videos, and for each COMPLETED one not already
 * registered: pull bytes → register → mark. Never throws (every step is caught by the caller's own
 * try/catch-equivalent null-return contract) — a single input's failure never aborts the rest of the tick.
 */
export async function sweepE3nRecordings(deps: E3nSweepDeps): Promise<E3nSweepResult> {
  const out: E3nSweepResult = {
    scanned: 0,
    completed: 0,
    alreadyRegistered: 0,
    registered: 0,
    pullPending: 0,
    pullFailed: 0,
    registerFailed: 0,
    missingOrg: 0,
  };

  const inputs = (await deps.listLiveInputs()).slice(0, MAX_SWEEP_INPUTS_PER_TICK);
  for (const { uid } of inputs) {
    out.scanned++;
    const videos = await deps.listVideosForInput(uid).catch(() => null);
    if (!videos) {
      deps.log?.("e3n-sweep-list-videos-failed", { uid });
      continue;
    }

    for (const video of videos) {
      if (!isCompletedRecording(video)) continue;
      out.completed++;

      const alreadyRegistered = await deps.isRegistered(video.uid).catch(() => false);
      if (alreadyRegistered) {
        out.alreadyRegistered++;
        continue;
      }

      const org = await deps.resolveOrg(uid).catch(() => null);
      if (!org) {
        out.missingOrg++;
        deps.log?.("e3n-sweep-missing-org", { uid, videoUid: video.uid });
        continue;
      }

      const pulled = await deps.pullToR2(video, org).catch(() => null);
      if (!pulled) {
        // Fail-safe: not marked registered, so the NEXT tick retries from scratch. Both "CF still muxing
        // the download" and "a real pull error" land here — both mean "not durable yet".
        out.pullPending++;
        deps.log?.("e3n-sweep-pull-not-ready", { uid, videoUid: video.uid });
        continue;
      }

      const result = await deps
        .register({ org, r2Key: pulled.r2Key, bucket: pulled.bucket, zone: E3N_RECORDING_ZONE })
        .catch(() => ({ ok: false }));
      if (!result.ok) {
        // Bytes are durable in R2 (deterministic key — a retry overwrites, not duplicates), but the register
        // call itself failed. Do NOT mark registered → the next tick retries the register (idempotent both
        // via the deterministic key and via the gateway's own dedupe on the recording).
        out.registerFailed++;
        deps.log?.("e3n-sweep-register-failed", { uid, videoUid: video.uid, org });
        continue;
      }

      await deps.markRegistered(video.uid).catch((err) =>
        deps.log?.("e3n-sweep-mark-registered-failed", { uid, videoUid: video.uid, error: String(err) }),
      );
      out.registered++;
      deps.log?.("e3n-sweep-registered", { uid, videoUid: video.uid, org, r2Key: pulled.r2Key });
    }
  }

  deps.log?.("e3n-sweep-tick", { ...out });
  return out;
}

/** Env fields the live sweep reads (structurally compatible with the worker's merged `Env` — same pattern
 *  as `PollRuntimeEnv`/`WhepSourcesEnv`: a focused interface, cast/passed from `scheduled.ts`). */
export interface E3nSweepRuntimeEnv extends E3nAutorecordEnv {
  CF_ACCOUNT_ID?: string;
  CF_STREAM_API_TOKEN?: string;
  CLOUDFLARE_STREAM_API_TOKEN?: string;
  RT_MEETING_ORG?: KVNamespace;
  /** The residency bucket E3n recordings land in (see `E3N_RECORDING_ZONE`) — reused, already
   *  gateway-allowlisted (proven live by the RT-P2.5 residency register path). */
  RT_RECORDINGS_ENAM?: R2Bucket;
  WAVE_GATEWAY_ORIGIN?: string;
  GATEWAY_BASE_URL?: string;
  WAVE_SERVICE_TOKEN?: string;
}

function resolveCfStreamToken(env: E3nSweepRuntimeEnv): string | undefined {
  return env.CF_STREAM_API_TOKEN || env.CLOUDFLARE_STREAM_API_TOKEN;
}

/** Build the live deps (real KV + CF Stream API + R2 + gateway register). Returns null when the sweep is
 *  unconfigured (flag off, or a required binding/credential absent) — the caller must treat null as INERT,
 *  never a half-working sweep. */
export function liveE3nSweepDeps(
  env: E3nSweepRuntimeEnv,
  fetchFn: typeof fetch = fetch,
): E3nSweepDeps | null {
  if (!e3nAutorecordEnabled(env)) return null;
  const kv = env.RT_MEETING_ORG;
  const accountId = env.CF_ACCOUNT_ID;
  const apiToken = resolveCfStreamToken(env);
  const bucket = env.RT_RECORDINGS_ENAM;
  if (!kv || !accountId || !apiToken || !bucket) return null;

  const log = (msg: string, fields: Record<string, unknown>) => console.log(JSON.stringify({ msg, ...fields }));
  const registerCfg: RegisterConfig = {
    gatewayOrigin: env.WAVE_GATEWAY_ORIGIN || env.GATEWAY_BASE_URL,
    serviceToken: env.WAVE_SERVICE_TOKEN,
  };

  return {
    async listLiveInputs() {
      const listed = await kv.list({ prefix: STREAM_INPUT_ORG_PREFIX, limit: MAX_SWEEP_INPUTS_PER_TICK });
      return listed.keys.map((k) => ({ uid: k.name.slice(STREAM_INPUT_ORG_PREFIX.length) }));
    },
    async resolveOrg(uid) {
      return kv.get(`${STREAM_INPUT_ORG_PREFIX}${uid}`);
    },
    listVideosForInput: (uid) => listCfVideosForLiveInput(fetchFn, accountId, apiToken, uid),
    async isRegistered(videoUid) {
      return (await kv.get(`${E3N_REGISTERED_PREFIX}${videoUid}`)) !== null;
    },
    async markRegistered(videoUid) {
      await kv.put(`${E3N_REGISTERED_PREFIX}${videoUid}`, "1", { expirationTtl: E3N_REGISTERED_TTL_SECONDS });
    },
    async pullToR2(video, org) {
      const dl = await requestCfDownloadUrl(fetchFn, accountId, apiToken, video.uid);
      if (!dl || !dl.ready || !dl.url) return null;
      const key = e3nRecordingKey(org, video.uid);
      const pulled = await pullCfRecordingBytes(fetchFn, dl.url, bucket, key);
      if (!pulled) return null;
      return { r2Key: key, bucket: E3N_RECORDING_BUCKET_NAME };
    },
    async register(input) {
      const r = await registerRecording(input, registerCfg, log, fetchFn);
      return { ok: r.ok };
    },
    log,
  };
}

/** Cron delegate for scheduled(): INERT unless `E3N_AUTORECORD_ENABLED` AND every required binding is
 *  present. Every exit path is LOUD (mirrors `scheduledStreamPoll`'s inert-is-observable discipline). */
export function scheduledE3nRecordingSweep(
  env: E3nSweepRuntimeEnv,
  ctx: { waitUntil(p: Promise<unknown>): void },
  fetchFn: typeof fetch = fetch,
): void {
  const log = (msg: string, fields: Record<string, unknown>) => console.log(JSON.stringify({ msg, ...fields }));
  const deps = liveE3nSweepDeps(env, fetchFn);
  if (!deps) {
    log("e3n-sweep-inert", { enabled: e3nAutorecordEnabled(env) });
    return;
  }
  ctx.waitUntil(sweepE3nRecordings(deps).catch((err) => log("e3n-sweep-tick-failed", { error: String(err) })));
}
