// transcript-route.ts — the voice-agent transcript retrieval surface (read + list), a leaf module so
// route-dispatch.ts stays under the file-size gate. GET /v1/realtime/agents/transcripts/:org[/:room/:session]
// reads the transcript JSON the AgentSessionDO persists to RT_RECORDINGS (`transcript:{org}:{room}:{session}.json`
// via the history + finalize intents). Same gateway-gate auth as the other gated realtime routes.
import { type Env, gatewayGate, SAFE_SEGMENT } from "./dispatch-helpers";

/** /v1/realtime/agents/transcripts/:org (list) and …/:org/:room/:session (read one). */
const TRANSCRIPTS_ROUTE = /^v1\/realtime\/agents\/transcripts\/([^/]+)(?:\/([^/]+)\/([^/]+))?$/;

/**
 * Handle GET /v1/realtime/agents/transcripts/*. Returns a Response when the path matches (incl. auth/gate
 * rejections), or null when it does not match (the router falls through). Never throws.
 */
export async function maybeHandleTranscriptRead(request: Request, url: URL, env: Env): Promise<Response | null> {
  if (request.method !== "GET") return null;
  const m = url.pathname.replace(/^\/+/, "").match(TRANSCRIPTS_ROUTE);
  if (!m) return null;
  const [, org, room, session] = m;
  if (!SAFE_SEGMENT.test(org) || (room && !SAFE_SEGMENT.test(room)) || (session && !SAFE_SEGMENT.test(session))) {
    return Response.json({ error: "BAD_REQUEST", message: "invalid transcript path" }, { status: 400 });
  }
  // AUTH — gateway-trust (x-wave-internal / capability token), same as the recording-ingest + recorder routes.
  const denied = gatewayGate(request, env.WAVE_INTERNAL_SECRET);
  if (denied) return denied;
  if (!env.RT_RECORDINGS) {
    return Response.json({ error: "TRANSCRIPT_UNAVAILABLE", message: "transcript store not configured" }, { status: 503 });
  }
  if (room && session) {
    const obj = await env.RT_RECORDINGS.get(`transcript:${org}:${room}:${session}.json`);
    if (!obj) return Response.json({ error: "NOT_FOUND", message: "no transcript for that session" }, { status: 404 });
    return new Response(await obj.text(), { status: 200, headers: { "content-type": "application/json" } });
  }
  const listed = await env.RT_RECORDINGS.list({ prefix: `transcript:${org}:`, limit: 100 });
  return Response.json({ org, count: listed.objects.length, transcripts: listed.objects.map((o) => o.key) }, { status: 200 });
}
