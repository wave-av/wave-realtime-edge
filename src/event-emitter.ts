// LK-rip #46 — WAVE-native SFU room/session event EMITTER (flag-gated, DORMANT by default).
//
// The WSC-side INGEST already merged (PR #4985: POST /api/v1/argus/webhooks/wave-realtime — HMAC-SHA256
// `wave-signature`, Zod envelope, maps WAVE events → canonical Argus vocabulary, fans into Inngest as
// vendor='wave', and on `session.ended` meters wave_realtime_{video,audio}_minutes to the gateway). This
// file is the missing other half: the wave-realtime-edge SFU emitting those room/session lifecycle events.
//
// Today the SFU emits ONLY the leave-time participant-minutes meter (metering.ts → /v1/internal/usage) and
// NOTHING to Argus. This adds the observability fan-in the LiveKit webhook currently carries — the gap that
// gates retiring the LiveKit webhook + its livekit-server-sdk import (cutover #48).
//
// CONTRACT (verbatim from PR #4985 body — implement to THIS exactly):
//   • Transport: POST JSON to https://app.wave.online/api/v1/argus/webhooks/wave-realtime
//   • Auth:      header `wave-signature: <hex hmac-sha256(rawBody, WAVE_REALTIME_WEBHOOK_SECRET)>`
//   • Events:    room.started | room.finished | participant.joined | participant.left |
//                track.published | track.unpublished | recording.finished | session.ended
//   • Billing:   session.ended carries `session_minutes:{video,audio}` + `org_id` → the ingest meters it.
//
// DORMANT BY DEFAULT (config-no-silent-noop): the emit fires ONLY when WAVE_REALTIME_EVENTS_EMIT="1" AND
// the shared secret WAVE_REALTIME_WEBHOOK_SECRET is provisioned. Until the cutover (Jake-named crossing:
// set the flag + mint the secret both sides), every emit is an inert no-op — NO network, NO behavior change.
//
// SAFETY (mirrors metering.ts §4 media-safety): an event-emit failure must NEVER drop media or break a
// session. Every emit is fire-and-forget + fail-open (call via state.waitUntil); a throw/non-2xx is logged
// loud (observability only, no secret/PII) and swallowed. Pure body-builders + signing are split from the
// I/O so the event shape, HMAC, flag-gating, and session_minutes math are all unit-testable with no network.
//
// session.ended SEMANTICS — emitted PER PARTICIPANT LEAVE (not per room-close): the existing meter model
// (metering.ts) already accrues participant-minutes at leave, and the ingest meters session.ended idempotently
// per (room,participant,session). Emitting session.ended at each leave with that participant's accrued
// session_minutes mirrors the existing /v1/internal/usage tap one-for-one — so the WAVE-native Argus billing
// path and the direct meter tap agree, and the ingest's gateway dedupe (event_id) prevents any double-count.

import type { ParticipantSessionUsage } from "./metering.js";
import { connectedMinutes } from "./metering.js";
import type { TrackKind } from "./room.js";

/** The canonical WAVE SFU lifecycle event names — VERBATIM from the #4985 ingest schema. Do not rename. */
export type WaveSfuEventName =
  | "room.started"
  | "room.finished"
  | "participant.joined"
  | "participant.left"
  | "track.published"
  | "track.unpublished"
  | "recording.finished"
  | "session.ended";

/** The #4985 session_minutes billing field — ONLY present on session.ended; drives gateway metering. */
export interface SessionMinutes {
  video: number;
  audio: number;
}

/**
 * The #4985 event envelope. `org_id` is REQUIRED for any billable event (the ingest meters session.ended
 * by org_id). Optional sub-objects are present only for the events that carry them (room on all; participant
 * on join/left/session.ended; track on track.*; recording on recording.finished; session_minutes ONLY on
 * session.ended). `idempotency_key` is optional — the route derives one when absent, but we always send a
 * stable one so retries (fire-and-forget) can't double-count.
 */
export interface WaveSfuEvent {
  event: WaveSfuEventName;
  /** ISO-8601 emit time. */
  occurred_at: string;
  /** REQUIRED for any billable event (org-scoped metering). */
  org_id: string;
  room: { id: string; name?: string };
  participant?: { id: string; identity?: string };
  track?: { id: string; kind: TrackKind | "data" };
  recording?: { id: string; bytes: number };
  /** ONLY on session.ended — accrued per-tier minutes that drive gateway metering. */
  session_minutes?: SessionMinutes;
  /** Stable idempotency key so a retried fire-and-forget emit is de-duped by the ingest. */
  idempotency_key: string;
}

/** The subset of env this emitter reads. Both required → the emit stays INERT until an operator provisions both. */
export interface EventEmitEnv {
  /** "1" arms the emitter. Absent/anything-else → fully inert (DORMANT until the Jake-named cutover). */
  WAVE_REALTIME_EVENTS_EMIT?: string;
  /** Shared HMAC secret (Doppler-provisioned BOTH sides). Absent → inert (no secret → cannot sign). */
  WAVE_REALTIME_WEBHOOK_SECRET?: string;
  /** WSC ingest URL. Defaults to the prod contract URL when unset (var, not a secret). */
  WSC_EVENTS_URL?: string;
}

/** The contract's prod ingest URL (PR #4985). Overridable via WSC_EVENTS_URL (e.g. staging). */
export const DEFAULT_WSC_EVENTS_URL = "https://app.wave.online/api/v1/argus/webhooks/wave-realtime";

/** True only when an operator has ARMED the flag AND provisioned the shared secret (else INERT). */
export function isEmitArmed(env: EventEmitEnv): boolean {
  return env.WAVE_REALTIME_EVENTS_EMIT === "1" && Boolean(env.WAVE_REALTIME_WEBHOOK_SECRET);
}

/**
 * Per-tier session minutes for a participant at leave (PURE). Mirrors metering.ts buildMeterLines's
 * publish-gating: a tier accrues minutes ONLY if the participant published that kind (design §3.2). A pure
 * viewer (published nothing) → {video:0, audio:0}. Fractional, never truncated, never negative.
 */
export function sessionMinutesFor(u: ParticipantSessionUsage): SessionMinutes {
  const minutes = connectedMinutes(u.joinedAt, u.leftAt);
  return {
    video: minutes > 0 && u.publishedVideo ? minutes : 0,
    audio: minutes > 0 && u.publishedAudio ? minutes : 0,
  };
}

/** Hex-encode bytes (lowercase) — the #4985 signature is hex hmac-sha256. */
function toHex(buf: ArrayBuffer): string {
  const b = new Uint8Array(buf);
  let out = "";
  for (let i = 0; i < b.length; i++) out += b[i].toString(16).padStart(2, "0");
  return out;
}

/**
 * Compute the #4985 `wave-signature`: hex HMAC-SHA256 of the RAW request body with the shared secret.
 * Uses WebCrypto (available in Workers + test runtime). Async (subtle.* is async). The body MUST be the
 * exact bytes sent so the ingest's recomputation matches (sign-then-send the SAME string).
 */
export async function signBody(rawBody: string, secret: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(rawBody));
  return toHex(sig);
}

/**
 * POST one already-built event to the WSC ingest, signed. Fire-and-forget friendly (call via
 * state.waitUntil); NEVER throws (fail-open — an event emit must never affect the live session). No-op (and
 * NO network) when the emit is not armed. Loud-logs a non-2xx / error for observability (no secret/PII).
 */
export async function emitEvent(
  env: EventEmitEnv,
  event: WaveSfuEvent,
  fetchFn: typeof fetch = fetch,
): Promise<void> {
  if (!isEmitArmed(env)) return; // DORMANT until armed + secret provisioned
  const url = env.WSC_EVENTS_URL || DEFAULT_WSC_EVENTS_URL;
  const rawBody = JSON.stringify(event);
  try {
    const signature = await signBody(rawBody, env.WAVE_REALTIME_WEBHOOK_SECRET as string);
    const res = await fetchFn(url, {
      method: "POST",
      headers: { "content-type": "application/json", "wave-signature": signature },
      body: rawBody,
    });
    if (!res.ok) {
      // Loud, never blocking — observability only, no secret/PII in the line.
      console.warn(`wave-sfu-event emit failed event=${event.event} status=${res.status} org=${event.org_id}`);
    }
  } catch (e) {
    // Fail-open: an event emit must NEVER affect the live realtime session (media-safety > observability).
    console.warn(`wave-sfu-event emit error event=${event.event} org=${event.org_id}: ${(e as Error)?.message ?? e}`);
  }
}

/** Common envelope fields for a room-scoped event (occurred_at stamped now; org_id required). */
interface RoomScope {
  org: string;
  room: string;
}

/** ── PURE event builders — one per lifecycle transition. Stable idempotency_key per (room,subject,event). ── */

export function buildRoomStarted(s: RoomScope, now: number = Date.now()): WaveSfuEvent {
  return {
    event: "room.started",
    occurred_at: new Date(now).toISOString(),
    org_id: s.org,
    room: { id: s.room },
    idempotency_key: `${s.room}:room.started`,
  };
}

export function buildRoomFinished(s: RoomScope, now: number = Date.now()): WaveSfuEvent {
  return {
    event: "room.finished",
    occurred_at: new Date(now).toISOString(),
    org_id: s.org,
    room: { id: s.room },
    idempotency_key: `${s.room}:room.finished`,
  };
}

export function buildParticipantJoined(s: RoomScope, participantId: string, now: number = Date.now()): WaveSfuEvent {
  return {
    event: "participant.joined",
    occurred_at: new Date(now).toISOString(),
    org_id: s.org,
    room: { id: s.room },
    participant: { id: participantId },
    idempotency_key: `${s.room}:${participantId}:participant.joined`,
  };
}

export function buildTrackPublished(
  s: RoomScope,
  participantId: string,
  track: { name: string; kind: TrackKind },
  now: number = Date.now(),
): WaveSfuEvent {
  return {
    event: "track.published",
    occurred_at: new Date(now).toISOString(),
    org_id: s.org,
    room: { id: s.room },
    participant: { id: participantId },
    track: { id: track.name, kind: track.kind },
    idempotency_key: `${s.room}:${participantId}:${track.name}:track.published`,
  };
}

/** participant.left — emitted at leave (alongside session.ended). occurred_at = leftAt for accuracy. */
export function buildParticipantLeft(u: ParticipantSessionUsage): WaveSfuEvent {
  return {
    event: "participant.left",
    occurred_at: new Date(u.leftAt).toISOString(),
    org_id: u.org,
    room: { id: u.room },
    participant: { id: u.participantId },
    idempotency_key: `${u.room}:${u.participantId}:${u.sessionId}:participant.left`,
  };
}

/**
 * session.ended — the BILLABLE event. Carries org_id + accrued session_minutes (the ingest meters
 * wave_realtime_{video,audio}_minutes off this). One per (room,participant,session) — idempotent on the
 * gateway. occurred_at = leftAt (the session's true end), not emit time, so the row is accurate on retry.
 */
export function buildSessionEnded(u: ParticipantSessionUsage): WaveSfuEvent {
  return {
    event: "session.ended",
    occurred_at: new Date(u.leftAt).toISOString(),
    org_id: u.org,
    room: { id: u.room },
    participant: { id: u.participantId },
    session_minutes: sessionMinutesFor(u),
    idempotency_key: `${u.room}:${u.participantId}:${u.sessionId}:session.ended`,
  };
}
