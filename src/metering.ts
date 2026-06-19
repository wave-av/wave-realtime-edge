// P5.3 — realtime metering tap (participant-minutes + overage-only egress).
//
// Per the P5 design (§3.2): each participant accrues per-minute usage for the time they are in a room,
// split into two already-priced INERT meters — `wave_realtime_video_minutes` (if they published a VIDEO
// track) and `wave_realtime_audio_minutes` (if they published an AUDIO track). At a participant's leave
// (or session teardown) the Room DO computes the connected duration and flushes the usage to the WAVE
// gateway's server-to-server ingest (`POST /v1/internal/usage`, `meter_value` for fractional minutes,
// Bearer WAVE_SERVICE_TOKEN), idempotent on a stable per-(participant,session) `event_id`.
//
// WHY /v1/internal/usage AND NOT the x-wave-meter RESPONSE-HEADER pattern (design §3.2 names "header-emit"):
// the header pattern stamps a meter onto a CUSTOMER HTTP RESPONSE flowing back through the gateway. A
// participant LEAVE / session teardown is a SERVER-INTERNAL event inside the Room DO — there is no
// customer response in flight to stamp. So the emission mechanism that actually fits leave is the same
// server-to-server `meter_value` ingest the storage-meter cron and the MoQ relay use (gateway src/usage.ts
// handleUsageIngest). This is metering-governed (through the gateway) and supports the fractional minutes
// the per-participant-minute meters need; the §3.2 "header" wording describes the spoke→gateway direction,
// not a literal response header on an out-of-band teardown. Documented so the choice is explicit.
//
// EGRESS IS OVERAGE-ONLY (design §3.2 + §4, the catalog COGS audit's one anti-double-bill invariant):
// downstream bandwidth is ALREADY inside the per-participant-minute COGS, and CF Realtime gives 1 TB/mo
// free → emitting `wave_sfu_egress_gb` in parallel with the minutes would DOUBLE-COUNT. For P5.3 egress is
// a non-emitting overage hook: it bills $0 (returns null) unless real measured egress exceeds an included
// allotment, and egress accounting fails CLOSED to $0 (never estimate-and-overcharge, design §4). Actual
// egress measurement (CF Realtime usage) is P5.4/P5.5; this leaves the hook with a clear emit boundary.
//
// SAFETY: a metering-emit failure must NEVER drop media or break the session (design §4) — the emit is
// fire-and-forget + fail-open (mirrors wave-moq-edge usage-emit.ts). Pure body-builders are split from the
// I/O so every accounting + honesty path is unit-testable with no network.

/** Meter event names — VERBATIM from the catalog (priced, INERT). Do not rename. */
export const METER_VIDEO_MINUTES = "wave_realtime_video_minutes";
export const METER_AUDIO_MINUTES = "wave_realtime_audio_minutes";
export const METER_EGRESS_GB = "wave_sfu_egress_gb";

/**
 * Included egress allotment per participant-session, in GB. Egress under this is $0 (it is already inside
 * the per-minute COGS — design §3.2). Only the OVERAGE beyond this is billable. Set to Infinity for P5.3:
 * with CF Realtime's free tier and the per-minute meter carrying normal bandwidth, normal use bills NO
 * egress. A finite allotment (abuse/outlier protection) is a Jake-named knob, not a P5.3 default.
 */
export const EGRESS_INCLUDED_GB = Infinity;

/** The subset of env this tap reads. Both optional → the emit is INERT until an operator provisions both. */
export interface MeterEmitEnv {
  /** Gateway origin, e.g. https://api.wave.online (var; not a secret). */
  GATEWAY_BASE_URL?: string;
  /** Internal service-to-service bearer for /v1/internal/usage (secret; deploy-time, Jake-named binding). */
  WAVE_SERVICE_TOKEN?: string;
}

/**
 * A snapshot of ONE participant's session, captured at leave/teardown (before the participant is dropped
 * from the Room DO). `joinedAt`/`leftAt` are epoch ms; `publishedAudio`/`publishedVideo` record whether the
 * participant ever published a track of that kind (per design §3.2: a participant who published a video
 * track accrues video-minutes; one who published audio accrues audio-minutes — audio-only OR alongside
 * video both accrue audio). `egressBytes` is the real measured downstream egress for this session when
 * available (P5.4+); undefined → unmeasured → $0 egress (fail-closed, design §4).
 */
export interface ParticipantSessionUsage {
  org: string;
  room: string;
  participantId: string;
  sessionId: string;
  joinedAt: number;
  leftAt: number;
  publishedAudio: boolean;
  publishedVideo: boolean;
  egressBytes?: number;
}

/** One meter line to ingest: a meter name + a fractional value + a stable idempotency key. */
export interface MeterLine {
  meter: string;
  /** Fractional value (minutes for the per-minute meters, GB for egress). Never truncated. */
  meter_value: number;
  /** Idempotent per (participant, session, meter) — a retried teardown is de-duped by the gateway. */
  event_id: string;
}

/** The gateway `/v1/internal/usage` envelope (matches gateway src/usage.ts handleUsageIngest meter_value). */
export interface UsageEnvelope {
  org: string;
  usage: MeterLine;
}

/** Connected duration in fractional MINUTES (seconds → minutes, NOT truncated — design §4 fractional rule). */
export function connectedMinutes(joinedAt: number, leftAt: number): number {
  const ms = leftAt - joinedAt;
  if (!(ms > 0)) return 0; // clock skew / zero-length / inverted → no billable time (never negative)
  return ms / 60_000;
}

/**
 * Billable egress GB beyond the included allotment (OVERAGE-ONLY). Returns 0 when egress is within the
 * allotment (the normal case — bandwidth is inside the per-minute COGS) or when egress is unmeasured
 * (fail-closed to $0, design §4 — never estimate-and-overcharge). The one place egress can ever bill.
 */
export function egressOverageGb(
  egressBytes: number | undefined,
  includedGb: number = EGRESS_INCLUDED_GB,
): number {
  if (egressBytes == null || !(egressBytes > 0)) return 0; // unmeasured / none → $0 (fail-closed)
  const gb = egressBytes / 1e9;
  const overage = gb - includedGb;
  return overage > 0 ? overage : 0; // never negative; under-allotment → $0
}

/**
 * Build the meter lines for one participant session — PURE (no I/O), so all accounting + the overage rule
 * are unit-testable. Returns one MeterLine per meter that has a non-zero value:
 *   • wave_realtime_video_minutes — only if the participant published video AND was connected > 0
 *   • wave_realtime_audio_minutes — only if the participant published audio AND was connected > 0
 *   • wave_sfu_egress_gb          — ONLY the overage beyond the included allotment (≈never for normal use)
 * A participant who published NOTHING (pure viewer) accrues NO per-minute meters here — minutes are
 * publish-gated per design §3.2's "if publishing" framing. event_id is stable per (participant,session,meter).
 */
export function buildMeterLines(
  u: ParticipantSessionUsage,
  includedGb: number = EGRESS_INCLUDED_GB,
): MeterLine[] {
  const lines: MeterLine[] = [];
  const minutes = connectedMinutes(u.joinedAt, u.leftAt);
  const key = (meter: string) => `${u.room}:${u.participantId}:${u.sessionId}:${meter}`;

  if (minutes > 0 && u.publishedVideo) {
    lines.push({ meter: METER_VIDEO_MINUTES, meter_value: minutes, event_id: key(METER_VIDEO_MINUTES) });
  }
  if (minutes > 0 && u.publishedAudio) {
    lines.push({ meter: METER_AUDIO_MINUTES, meter_value: minutes, event_id: key(METER_AUDIO_MINUTES) });
  }

  // Egress is OVERAGE-ONLY — never emitted in parallel with the per-minute meters for normal use.
  const overage = egressOverageGb(u.egressBytes, includedGb);
  if (overage > 0) {
    lines.push({ meter: METER_EGRESS_GB, meter_value: overage, event_id: key(METER_EGRESS_GB) });
  }

  return lines;
}

/** True only when an operator has provisioned BOTH the gateway URL and the service token (else INERT). */
export function isEmitProvisioned(env: MeterEmitEnv): boolean {
  return Boolean(env.GATEWAY_BASE_URL && env.WAVE_SERVICE_TOKEN);
}

/**
 * Flush one participant session's realtime usage to the gateway. Fire-and-forget friendly (call via
 * ctx.waitUntil / state.waitUntil); NEVER throws and NEVER drops media (design §4). No-op (and no network)
 * when the emit is not provisioned or there is nothing billable. Each meter line is POSTed independently so
 * one meter's failure can't suppress another; failures are logged loud (config-no-silent-noop) but swallowed.
 */
export async function emitParticipantUsage(
  env: MeterEmitEnv,
  u: ParticipantSessionUsage,
  includedGb: number = EGRESS_INCLUDED_GB,
  fetchFn: typeof fetch = fetch,
): Promise<void> {
  if (!isEmitProvisioned(env)) return; // INERT until operator provisions URL + token
  const lines = buildMeterLines(u, includedGb);
  if (lines.length === 0) return; // nothing billable (e.g. pure viewer, zero duration)

  const base = (env.GATEWAY_BASE_URL as string).replace(/\/+$/, "");
  const token = env.WAVE_SERVICE_TOKEN as string;

  for (const usage of lines) {
    const body: UsageEnvelope = { org: u.org, usage };
    try {
      const res = await fetchFn(`${base}/v1/internal/usage`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        // Loud, but never blocking — observability only, no secret/PII in the line.
        console.warn(`realtime-meter emit failed meter=${usage.meter} status=${res.status} org=${u.org}`);
      }
    } catch (e) {
      // Fail-open: a usage emit must NEVER affect the live realtime session (design §4 media-safety).
      console.warn(`realtime-meter emit error meter=${usage.meter} org=${u.org}: ${(e as Error)?.message ?? e}`);
    }
  }
}
