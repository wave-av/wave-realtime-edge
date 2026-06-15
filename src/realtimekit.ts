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
