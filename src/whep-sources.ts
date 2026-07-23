/**
 * WHEP-A (whep-live-egress-golive epic) — the source PROVISION + DISCOVERY + TEARDOWN surface, symmetric with the
 * WHIP publish mint. Three verbs on `/v1/whep/sources[/{uid}]`:
 *
 *   • POST /v1/whep/sources  — provision a CF Stream Live source for the caller's org. Body:
 *       `{ sourceKind, room, sourceUrl?, maxCostRank? }`. Routes through the authoritative `ingressRoute`; only a
 *       `cfStreamLive` verdict provisions here (whip → SFU via /v1/whip; container plane deferred). Returns
 *       `201 { uid, endpoints }` — the `uid` is the WHEP `?resource=` key, `endpoints` the RTMPS/SRT push targets.
 *   • GET  /v1/whep/sources  — list the caller org's live sources `{ sources: [{uid, room, createdAt}] }` from the
 *       reverse KV index (org-scoped; a viewer only ever sees their OWN org's sources — tenant isolation §9.6).
 *   • DELETE /v1/whep/sources/{uid} — teardown (W1 slice-1's teardown half; consumed by wave-zoom
 *       livestream-teardown). OWNERSHIP-checked against the forward KV binding: absent → idempotent 200 (already
 *       gone), foreign org → 403. Best-effort deletes the CF Stream Live input (fail-open on the CF call — a
 *       webhook/job retry must never 500 on this), then cleans BOTH KV keys. Returns `200 {ok:true, uid}`.
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
  ORG_STREAM_INPUTS_PREFIX,
  readOrgStreamInputs,
  type OrgStreamInputEntry,
  type StreamInputKv,
} from "./cf-stream-live-client.js";
import { STREAM_INPUT_ORG_PREFIX } from "./stream-bridge.js";

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

/** Match `/v1/whep/sources/{uid}` and return the (possibly empty) uid segment; `null` when the path isn't a
 *  teardown path at all (so the caller can fall back to the bare-path GET/POST handling / null fall-through). */
function matchTeardownPath(pathname: string): string | null {
  const prefix = `${SOURCES_PATH}/`;
  if (!pathname.startsWith(prefix)) return null;
  return decodeURIComponent(pathname.slice(prefix.length));
}

/** Remove ONE uid from an org's reverse index (read-modify-write), tolerating an absent/corrupt index (no-op). */
async function removeFromReverseIndex(kv: StreamInputKv, org: string, uid: string): Promise<void> {
  const existing = await readOrgStreamInputs(kv, org);
  const next: OrgStreamInputEntry[] = existing.filter((e) => e.uid !== uid);
  if (next.length === existing.length) return; // uid wasn't present — nothing to write
  await kv.put(`${ORG_STREAM_INPUTS_PREFIX}${org}`, JSON.stringify(next));
}

/**
 * DELETE `/v1/whep/sources/{uid}` — teardown. Ownership-checked against the forward KV binding; absent → treated
 * as already-gone (idempotent 200, no error — a retry/redelivery must never fail here). Foreign org → 403. The CF
 * Stream Live delete is best-effort/fail-open (`bestEffortDeleteInput` never throws) so a CF outage can't block
 * KV cleanup or turn a retry into a 500.
 */
async function teardownSource(
  kv: StreamInputKv,
  env: WhepSourcesEnv,
  org: string,
  uid: string,
  deps: WhepSourcesDeps,
): Promise<Response> {
  const ownerKey = `${STREAM_INPUT_ORG_PREFIX}${uid}`;
  const owner = await kv.get(ownerKey);
  if (owner === null) {
    // Already gone (never existed / already torn down) — idempotent success, not an error.
    return Response.json({ ok: true, uid }, { status: 200 });
  }
  if (owner !== org) {
    return jsonError("WHEP_SOURCE_FORBIDDEN", "source belongs to a different org", 403);
  }

  const creds = resolveCfCreds(env);
  if (creds) {
    const fetchFn = deps.fetchFn ?? fetch.bind(globalThis);
    await CfStreamLiveClientImpl.bestEffortDeleteInput(fetchFn, creds.accountId, creds.apiToken, uid).catch((e) => {
      // bestEffortDeleteInput itself never throws, but guard the call site too — KV cleanup must proceed either way.
      console.warn(`whep-sources teardown bestEffortDeleteInput threw org=${org} uid=${uid}: ${(e as Error)?.message ?? e}`);
    });
  } else {
    console.warn(`whep-sources teardown SKIPPED CF delete (no creds configured) org=${org} uid=${uid} — KV still cleaned`);
  }

  await kv.delete(ownerKey);
  await removeFromReverseIndex(kv, org, uid);

  return Response.json({ ok: true, uid }, { status: 200 });
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
  const teardownUid = matchTeardownPath(url.pathname);
  if (url.pathname !== SOURCES_PATH && teardownUid === null) return null;

  const kv = env.RT_MEETING_ORG;
  if (!kv) {
    // config-no-silent-noop: a missing KV binding is a misconfiguration, not a silent empty.
    return jsonError("WHEP_SOURCES_NOT_CONFIGURED", "RT_MEETING_ORG KV binding is not configured", 503);
  }

  // ── DELETE /v1/whep/sources/{uid}: teardown (W1 slice-1's teardown half) ──
  if (teardownUid !== null) {
    if (request.method !== "DELETE") {
      return jsonError("WHEP_METHOD_NOT_ALLOWED", "DELETE to teardown a source", 405);
    }
    if (!teardownUid) {
      return jsonError("WHEP_BAD_REQUEST", "uid is required in the path", 400);
    }
    return teardownSource(kv, env, org, teardownUid, deps);
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
    let outcome: Awaited<ReturnType<typeof backend.provision>>;
    try {
      outcome = await backend.provision(parsed.job, { org });
    } catch (e) {
      // no-silent-failure: a THROWN provision (e.g. malformed cred → fetch TypeError) must be observable,
      // not a bare 502. Log the actionable reason (never the secret values — lengths only).
      console.error(
        `whep-sources provision THREW org=${org} kind=${parsed.job.sourceKind} acctLen=${creds.accountId.length} tokLen=${creds.apiToken.length}: ${(e as Error)?.stack ?? String(e)}`,
      );
      return jsonError("WHEP_SOURCE_PROVISION_FAILED", `provision error: ${(e as Error)?.message ?? String(e)}`, 502);
    }

    switch (outcome.status) {
      case "provisioned": {
        const r = outcome.result;
        if (r.ok) {
          return Response.json({ uid: r.input.uid, endpoints: r.input.endpoints }, { status: 201 });
        }
        // CF create-input / KV bind failure — surfaced with the origin's stable status + reason.
        console.error(
          `whep-sources provision FAILED org=${org} kind=${parsed.job.sourceKind} acctLen=${creds.accountId.length} tokLen=${creds.apiToken.length} status=${r.status}: ${r.reason}`,
        );
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

/**
 * Dispatch wrapper mirroring `maybeHandleIngestBridge` / `maybeHandleStreamBridge`: keeps the route-dispatch
 * hot path a one-liner (file-size-two-tier-gate) and co-locates the flag + gateway-trust + org gating with the
 * handler it guards. Returns null (fall-through) when the path isn't `/v1/whep/sources[/{uid}]` or the router is
 * INERT.
 */
export async function maybeHandleWhepSources(
  request: Request,
  env: WhepSourcesEnv & { WAVE_INTERNAL_SECRET?: string },
  gatewayGate: (request: Request, secret: string | undefined) => Response | null,
  safeOrg: RegExp,
): Promise<Response | null> {
  const url = new URL(request.url);
  const isSourcesPath = url.pathname === SOURCES_PATH || matchTeardownPath(url.pathname) !== null;
  if (!isSourcesPath || !ingressRouterEnabled(env)) return null;
  const denied = gatewayGate(request, env.WAVE_INTERNAL_SECRET);
  if (denied) return denied;
  const org = request.headers.get("x-wave-org") ?? "";
  if (!safeOrg.test(org)) {
    return Response.json(
      { error: "BAD_REQUEST", message: "missing or malformed org context (x-wave-org) — stamped by the gateway" },
      { status: 400 },
    );
  }
  return handleWhepSources(request, env, org);
}

export { SOURCES_PATH, ingressRouterEnabled };
