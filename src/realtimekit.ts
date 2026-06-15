// CF-3.1.2 — RealtimeKit (Cloudflare Realtime) server client.
//
// Contract VERIFIED live against the account 2026-06-14:
//   POST /accounts/{acc}/realtime/kit/{app}/meetings            → 201 {success, data:{id,status,...}}
//   POST .../meetings/{id}/participants {name,preset_name,...}   → 200 {success, data:{token,id,...}}
// NB: RealtimeKit uses a `data` envelope (ex-Dyte API), NOT the standard Cloudflare `result`.
//
// Auth is the ACCOUNT API token (a wrangler secret). The token is never logged and never
// returned to the client — only the per-participant join `token` is surfaced.

const CF_API = "https://api.cloudflare.com/client/v4"; // fixed host — no request-derived URLs (SSRF-safe)
const DEFAULT_PRESET = "group_call_participant";
const HEX32 = /^[0-9a-f]{32}$/i;
const UUIDISH = /^[0-9a-z-]{16,64}$/i; // CF app/meeting ids are uuid-shaped; guard before interpolating

export interface RtkConfig {
  accountId: string;
  appId: string;
  token: string;
}
export interface JoinRequest {
  title?: string;
  name: string;
  presetName?: string;
  customParticipantId?: string;
}
export interface JoinResult {
  meetingId: string;
  token: string;
  appId: string;
}

/** Typed boundary error → mapped to a normalized {error,message} envelope + HTTP status by the worker. */
export class RtkError extends Error {
  constructor(public code: string, message: string, public status = 502) {
    super(message);
    this.name = "RtkError";
  }
}

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

async function rtkPost(cfg: RtkConfig, path: string, body: unknown, fetchImpl: FetchLike): Promise<Record<string, unknown>> {
  const res = await fetchImpl(`${CF_API}/accounts/${cfg.accountId}/realtime/kit/${cfg.appId}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${cfg.token}` },
    body: JSON.stringify(body),
  });
  type RtkResp = { success?: boolean; data?: Record<string, unknown> };
  let json: RtkResp | null = null;
  try {
    json = (await res.json()) as RtkResp;
  } catch {
    json = null; // non-JSON upstream
  }
  if (!res.ok || !json?.success || !json.data) {
    // Observability (no secrets, no body): status + first upstream error code, for debugging.
    const code = json && Array.isArray((json as { errors?: { code?: unknown }[] }).errors)
      ? (json as { errors?: { code?: unknown }[] }).errors?.[0]?.code
      : undefined;
    console.warn(`rtk-upstream path=${path} status=${res.status} ok=${res.ok} success=${json?.success} err=${code}`);
    // Never leak the upstream body or our token — just a stable code + status.
    throw new RtkError("REALTIME_UPSTREAM", `RealtimeKit ${path} returned ${res.status}`, 502);
  }
  return json.data;
}

/**
 * Create (or open) a meeting and mint a participant join token. Pure w.r.t. injected `fetchImpl`
 * so it unit-tests with no network. Throws RtkError at every failure boundary.
 */
export async function join(cfg: RtkConfig, req: JoinRequest, fetchImpl: FetchLike = fetch): Promise<JoinResult> {
  if (!HEX32.test(cfg.accountId || "") || !UUIDISH.test(cfg.appId || "") || !cfg.token) {
    throw new RtkError("REALTIME_NOT_CONFIGURED", "realtime-edge is not configured (account/app/token)", 503);
  }
  if (!req || typeof req.name !== "string" || !req.name.trim()) {
    throw new RtkError("BAD_REQUEST", "`name` (participant display name) is required", 400);
  }

  const meeting = await rtkPost(cfg, "/meetings", { title: req.title ?? "wave-meeting" }, fetchImpl);
  const meetingId = String(meeting.id ?? "");
  if (!UUIDISH.test(meetingId)) throw new RtkError("REALTIME_UPSTREAM", "meeting id missing/invalid", 502);

  // custom_participant_id is REQUIRED by RealtimeKit (400 "Custom participant ID is required" without
  // it). Default to a fresh UUID so a caller that only passes a display name still joins.
  const customParticipantId = req.customParticipantId ?? crypto.randomUUID();
  const participant = await rtkPost(
    cfg,
    `/meetings/${meetingId}/participants`,
    { name: req.name, preset_name: req.presetName ?? DEFAULT_PRESET, custom_participant_id: customParticipantId },
    fetchImpl,
  );
  const token = String(participant.token ?? "");
  if (!token) throw new RtkError("REALTIME_UPSTREAM", "participant token missing", 502);

  return { meetingId, token, appId: cfg.appId };
}

// ── TURN / ICE credentials (CF-3) ──────────────────────────────────────────────────────────────────
// A WebRTC client that does its OWN peer connection (raw SFU / WHIP-WHEP, or any custom RTCPeerConnection)
// needs short-lived ICE servers to traverse NAT. CF mints them on a SEPARATE host from the REST API:
//   POST https://rtc.live.cloudflare.com/v1/turn/keys/{keyId}/credentials/generate  {ttl}
//     → 201 { iceServers: { urls:[stun:…, turn:…, turns:…], username, credential } }   (contract verified live)
// The TURN api TOKEN is an account secret; only the EPHEMERAL username/credential (time-bounded by ttl) are
// ever returned to the client — never the token. Fixed host literal (SSRF-safe); keyId is HEX32-validated
// before interpolation; ttl is clamped to a bounded integer.
const TURN_API = "https://rtc.live.cloudflare.com/v1/turn/keys"; // fixed host — no request-derived URLs (SSRF-safe)
const TURN_TTL_DEFAULT = 86400; // 24h — a sensible session lifetime when the caller doesn't ask
const TURN_TTL_MIN = 60;        // floor: a credential shorter than a minute is useless
const TURN_TTL_MAX = 86400;     // ceiling: cap how long a single minted credential stays valid

export interface TurnConfig {
  keyId: string;
  token: string;
}
export interface IceServers {
  urls: string[];
  username: string;
  credential: string;
}
export interface TurnResult {
  iceServers: IceServers;
  ttl: number;
}

/** Clamp a (possibly client-supplied, possibly garbage) ttl to a bounded integer in [MIN, MAX]. */
export function clampTurnTtl(v: unknown): number {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  if (!Number.isFinite(n)) return TURN_TTL_DEFAULT;
  return Math.min(TURN_TTL_MAX, Math.max(TURN_TTL_MIN, Math.floor(n)));
}

/**
 * Mint short-lived TURN/ICE credentials. Pure w.r.t. injected `fetchImpl` (unit-tests with no network).
 * FAIL-CLOSED on an unconfigured key (503). Returns ONLY the ephemeral iceServers — never the api token.
 */
export async function turn(cfg: TurnConfig, ttlSeconds: unknown, fetchImpl: FetchLike = fetch): Promise<TurnResult> {
  if (!HEX32.test(cfg.keyId || "") || !cfg.token) {
    throw new RtkError("REALTIME_NOT_CONFIGURED", "realtime-edge TURN is not configured (key id/token)", 503);
  }
  const ttl = clampTurnTtl(ttlSeconds);
  const res = await fetchImpl(`${TURN_API}/${cfg.keyId}/credentials/generate`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${cfg.token}` },
    body: JSON.stringify({ ttl }),
  });
  let json: { iceServers?: Partial<IceServers> } | null = null;
  try {
    json = (await res.json()) as { iceServers?: Partial<IceServers> };
  } catch {
    json = null; // non-JSON upstream
  }
  const ice = json?.iceServers;
  if (!res.ok || !ice || !Array.isArray(ice.urls) || !ice.username || !ice.credential) {
    // Observability only — never the token or the upstream body.
    console.warn(`turn-upstream status=${res.status} ok=${res.ok} hasIce=${!!ice}`);
    throw new RtkError("REALTIME_UPSTREAM", `TURN credentials/generate returned ${res.status}`, 502);
  }
  return { iceServers: { urls: ice.urls, username: ice.username, credential: ice.credential }, ttl };
}
