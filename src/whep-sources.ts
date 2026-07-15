/**
 * WHEP-A (whep-live-egress-golive epic) — the source PROVISION + DISCOVERY surface, symmetric with the WHIP
 * publish mint. Two verbs on ONE path, `/v1/whep/sources`:
 *
 *   • POST /v1/whep/sources  — provision a CF Stream Live source for the caller's org. Body:
 *       `{ sourceKind, room, sourceUrl?, maxCostRank? }`. Routes through the authoritative `ingressRoute`; only a
 *       `cfStreamLive` verdict provisions here (whip → SFU via /v1/whip; container plane deferred). Returns
 *       `201 { uid, endpoints }` — the `uid` is the WHEP `?resource=` key, `endpoints` the RTMPS/SRT push targets.
 *   • GET  /v1/whep/sources  — list the caller org's live sources `{ sources: [{uid, room, createdAt}] }` from the
 *       reverse KV index (org-scoped; a viewer only ever sees their OWN org's sources — tenant isolation §9.6).
 *
 * AUTH + org are enforced UPSTREAM by the worker dispatch (gatewayGate + `x-wave-org`), identical to the WHIP/WHEP
 * blocks; `org` arrives already validated. This module never trusts an org from the body. Gated INERT behind
 * `INGRESS_ROUTER_ENABLED` at the dispatch site — when off, the block is skipped and `/v1/whep/sources` 501s.
 */
import {
  CfStreamLiveIngestBackend,
  ingressRouterEnabled,
  type CfStreamLiveIngestEnv,
} from "./ingress-cf-stream-live.js";
import type { IngestJob, IngestSourceKind } from "./ingress-router.js";
import { INGEST_SOURCE_KINDS } from "./ingress-router.js";
import {
  CfStreamLiveClientImpl,
  readOrgStreamInputs,
  type StreamInputKv,
} from "./cf-stream-live-client.js";

/** Env fields this handler reads. Extends the backend's flag/creds env with the account id + KV binding the
 *  concrete adapter needs. All are `wrangler secret`/`--var` populated (Doppler `wave/prd`) — never in source. */
export interface WhepSourcesEnv extends CfStreamLiveIngestEnv {
  /** CF Stream account id (the account live inputs live on — `c23f0a`). Injected at deploy (`CF_ACCOUNT_ID`). */
  CF_ACCOUNT_ID?: string;
  CLOUDFLARE_ACCOUNT_ID?: string; // Doppler-populated alias
  CLOUDFLARE_STREAM_API_TOKEN?: string; // accepted alias of CF_STREAM_API_TOKEN
  /** Reused KV namespace (forward `stream-input-org:` + reverse `org-stream-inputs:`). */
  RT_MEETING_ORG?: StreamInputKv;
}

const SOURCES_PATH = "/v1/whep/sources";

/** Resolve the CF account id + Stream API token from env (accepting the Doppler `CLOUDFLARE_*` aliases). Null when
 *  either is absent — provisioning then fails LOUD (503), never silently. */
function resolveCfCreds(env: WhepSourcesEnv): { accountId: string; apiToken: string } | null {
  const accountId = env.CF_ACCOUNT_ID || env.CLOUDFLARE_ACCOUNT_ID || "";
  const apiToken = env.CF_STREAM_API_TOKEN || env.CLOUDFLARE_STREAM_API_TOKEN || "";
  if (!accountId || !apiToken) return null;
  return { accountId, apiToken };
}

/** Typed JSON error envelope (mirrors whep.ts / the spoke contract). */
function jsonError(code: string, message: string, status: number): Response {
  return Response.json({ error: code, message }, { status });
}

/** Parse + shape-validate the provision body into an `IngestJob`. Returns a reason string on bad input (→ 400).
 *  Only whitelisted `sourceKind`s + a room are accepted here; deep validation is `validateIngestJob` in the router. */
function parseProvisionBody(body: unknown): { job: IngestJob } | { error: string } {
  if (!body || typeof body !== "object") return { error: "body must be a JSON object" };
  const b = body as Record<string, unknown>;
  const sourceKind = b.sourceKind;
  if (typeof sourceKind !== "string" || !(INGEST_SOURCE_KINDS as readonly string[]).includes(sourceKind)) {
    return { error: `sourceKind must be one of ${INGEST_SOURCE_KINDS.join("|")}` };
  }
  if (typeof b.room !== "string") return { error: "room is required (safe segment)" };
  const job: IngestJob = {
    sourceKind: sourceKind as IngestSourceKind,
    room: b.room,
    ...(typeof b.sourceUrl === "string" ? { sourceUrl: b.sourceUrl } : {}),
    ...(typeof b.maxCostRank === "number" ? { maxCostRank: b.maxCostRank } : {}),
  };
  return { job };
}

/**
 * Handle `/v1/whep/sources`. Returns a Response for a recognized method, or `null` for an unrecognized method/path
 * so the caller falls through to the 501 catch-all (same null-fallthrough contract as handleWhip/handleWhep).
 * `org` is the gateway-stamped, already-validated caller org.
 */
/** Injectable seam for tests — the CF `fetch` + clock the provision path's client uses. Omitted in production
 *  (defaults to the real `fetch`/`Date.now`), so the dispatch site calls `handleWhepSources(req, env, org)`. */
export interface WhepSourcesDeps {
  fetchFn?: typeof fetch;
  now?: () => number;
}

export async function handleWhepSources(
  request: Request,
  env: WhepSourcesEnv,
  org: string,
  deps: WhepSourcesDeps = {},
): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname !== SOURCES_PATH) return null;

  const kv = env.RT_MEETING_ORG;
  if (!kv) {
    // config-no-silent-noop: a missing KV binding is a misconfiguration, not a silent empty.
    return jsonError("WHEP_SOURCES_NOT_CONFIGURED", "RT_MEETING_ORG KV binding is not configured", 503);
  }

  // ── GET: discover this org's live sources (no CF creds needed — pure KV read) ──
  if (request.method === "GET") {
    const sources = await readOrgStreamInputs(kv, org);
    return Response.json({ sources }, { status: 200 });
  }

  // ── POST: provision a new CF Stream Live source for this org ──
  if (request.method === "POST") {
    const creds = resolveCfCreds(env);
    if (!creds) {
      return jsonError("WHEP_SOURCES_NOT_CONFIGURED", "CF Stream account id / API token are not configured", 503);
    }
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return jsonError("WHEP_BAD_REQUEST", "request body must be valid JSON", 400);
    }
    const parsed = parseProvisionBody(body);
    if ("error" in parsed) return jsonError("WHEP_BAD_REQUEST", parsed.error, 400);

    const client = new CfStreamLiveClientImpl({
      accountId: creds.accountId,
      apiToken: creds.apiToken,
      kv,
      fetchFn: deps.fetchFn,
      now: deps.now,
    });
    const backend = new CfStreamLiveIngestBackend(client);
    const outcome = await backend.provision(parsed.job, { org });

    switch (outcome.status) {
      case "provisioned": {
        const r = outcome.result;
        if (r.ok) {
          return Response.json({ uid: r.input.uid, endpoints: r.input.endpoints }, { status: 201 });
        }
        // CF create-input / KV bind failure — surfaced with the origin's stable status + reason.
        return jsonError("WHEP_SOURCE_PROVISION_FAILED", r.reason, r.status >= 400 && r.status < 600 ? r.status : 502);
      }
      case "deferred":
        // Routed to another plane (whip → SFU via /v1/whip; container bridge via /v1/ingest). Not this surface.
        return jsonError(
          "WHEP_WRONG_PLANE",
          `sourceKind routes to '${outcome.backend}', not CF Stream Live — use the matching ingest surface`,
          409,
        );
      case "unroutable":
        return jsonError("WHEP_BAD_REQUEST", outcome.reason, 400);
    }
  }

  // Unrecognized method on a recognized path → 405 (not a fall-through; the path IS ours).
  return jsonError("WHEP_METHOD_NOT_ALLOWED", "POST to provision or GET to list sources", 405);
}

export { SOURCES_PATH, ingressRouterEnabled };
