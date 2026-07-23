/**
 * W1 O3 (wre#289) — external egress DESTINATION management: the security foundation the external-RTMP/SRT
 * restream legs (O1/O2) will consume next. A "destination" is an org-owned `{id, kind, url, streamKey?,
 * passphrase?}` record the eventual restream arm dials INTO (an external RTMP/SRT ingest — Twitch/YouTube/a
 * customer's own media server/etc), distinct from the CF Stream Live SOURCES `whep-sources.ts` manages (this
 * codebase's other org-scoped provisioning surface, which this module mirrors for auth/KV/route shape).
 *
 * FOUR VERBS on `/v1/egress/destinations[/{id}]`:
 *   • POST   /v1/egress/destinations       — create. Body `{kind:'rtmp'|'srt', url, streamKey?, passphrase?}`.
 *       `url` is REJECTED unless it clears the SSRF guard (`ssrf-guard.ts`, #17) for its kind. `streamKey`/
 *       `passphrase` are encrypted at rest (`dest-key-crypto.ts`, #18) before ANY KV write. Returns
 *       `201 {destination}` — REDACTED (no plaintext/ciphertext key material ever leaves this module in a
 *       response).
 *   • GET    /v1/egress/destinations       — list the caller org's destinations (org-scoped, redacted).
 *   • GET    /v1/egress/destinations/{id}  — fetch one (org-scoped, redacted). Absent → 404. Foreign org → 403.
 *   • DELETE /v1/egress/destinations/{id}  — teardown. Mirrors #310 (whep-sources DELETE) EXACTLY: absent → 200
 *       idempotent (a retry/redelivery must never fail here), foreign org → 403, otherwise both KV keys cleaned.
 *
 * AUTH + org are enforced UPSTREAM by the worker dispatch (gatewayGate + `x-wave-org`), identical to
 * whep-sources/whip/whep. This module never trusts an org from the body. Gated INERT behind
 * `EGRESS_DEST_MGMT_ENABLED` (own flag, default OFF — a SIBLING of `INGRESS_ROUTER_ENABLED`, not a reuse of it:
 * this is new destination-CRUD + crypto surface, so it ships INERT and gets its own Jake-named ◆ arm, not a free
 * ride on a flag some other route already armed).
 *
 * NOT DONE HERE: `egress-arm.ts` is not modified. `resolveDestinationForArm` below is exported for O1/O2 to call
 * once they build the actual restream dial — it decrypts the stored key material but explicitly does NOT
 * re-validate SSRF (that's the caller's job, documented on the function itself, because only the caller knows
 * the exact moment it's about to open the socket).
 */
import { validateDestinationUrl, type DestKind } from "./ssrf-guard.js";
import { decryptField, encryptField, getAesKey, REDACTED_MARKER, type EncryptedField } from "./dest-key-crypto.js";
import type { StreamInputKv } from "./cf-stream-live-client.js";
import type { DestKeyCryptoEnv } from "./dest-key-crypto.js";

const DESTINATIONS_PATH = "/v1/egress/destinations";
const DEST_ID = /^[a-f0-9-]{8,64}$/i;

/** KV key prefixes. `egress-dest:{org}:{id}` is the forward record; `egress-dest-index:{org}` is the reverse
 *  list of ids the org owns (mirrors `stream-input-org:`/`org-stream-inputs:` in cf-stream-live-client.ts /
 *  stream-bridge.ts — same forward+reverse-index KV shape, new prefixes so they never collide with WHEP's). */
export const DEST_RECORD_PREFIX = "egress-dest:";
export const DEST_ORG_INDEX_PREFIX = "egress-dest-index:";

function recordKey(org: string, id: string): string {
  return `${DEST_RECORD_PREFIX}${org}:${id}`;
}
function indexKey(org: string): string {
  return `${DEST_ORG_INDEX_PREFIX}${org}`;
}

/** The persisted shape — NEVER returned directly from a route (see `redactDestination`). Only ciphertext+iv for
 *  the two sensitive fields ever reaches KV. */
export interface EgressDestinationRecord {
  id: string;
  org: string;
  kind: DestKind;
  url: string;
  streamKeyEnc?: EncryptedField;
  passphraseEnc?: EncryptedField;
  createdAt: number;
}

/** The response shape — plaintext/ciphertext key material replaced with `REDACTED_MARKER`; the field is simply
 *  omitted when the destination was created without it (so a GET can't be used to probe "does this destination
 *  have a key configured" any more precisely than a boolean-ish presence, matching create-time input shape). */
export interface RedactedDestination {
  id: string;
  org: string;
  kind: DestKind;
  url: string;
  streamKey?: string;
  passphrase?: string;
  createdAt: number;
}

/** Redact a stored record for ANY response (list/get/create). The only function in this module allowed to
 *  touch a record's key-material fields on the way OUT. */
export function redactDestination(rec: EgressDestinationRecord): RedactedDestination {
  return {
    id: rec.id,
    org: rec.org,
    kind: rec.kind,
    url: rec.url,
    ...(rec.streamKeyEnc ? { streamKey: REDACTED_MARKER } : {}),
    ...(rec.passphraseEnc ? { passphrase: REDACTED_MARKER } : {}),
    createdAt: rec.createdAt,
  };
}

export interface EgressDestinationsEnv extends DestKeyCryptoEnv {
  EGRESS_DEST_MGMT_ENABLED?: string | boolean;
  /** Reuses the RT_MEETING_ORG KV namespace (same binding whep-sources/stream-bridge already use) — one KV
   *  namespace for org-scoped control-plane state, distinct key prefixes per surface. */
  RT_MEETING_ORG?: StreamInputKv;
}

/** Strict true/"1"/"true" predicate, matching every other flag in this codebase (`ingressRouterEnabled`,
 *  `egressRouterEnabled`, `mediaTapEnabled`). */
export function egressDestMgmtEnabled(env: EgressDestinationsEnv): boolean {
  const v = env.EGRESS_DEST_MGMT_ENABLED;
  return v === true || v === "1" || v === "true";
}

function jsonError(code: string, message: string, status: number): Response {
  return Response.json({ error: code, message }, { status });
}

function matchIdPath(pathname: string): string | null {
  const prefix = `${DESTINATIONS_PATH}/`;
  if (!pathname.startsWith(prefix)) return null;
  return pathname.slice(prefix.length);
}

async function readIndex(kv: StreamInputKv, org: string): Promise<string[]> {
  const raw = await kv.get(indexKey(org));
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return []; // corrupt index → tolerate, treat as empty (never throw on a read)
  }
}

async function writeIndex(kv: StreamInputKv, org: string, ids: string[]): Promise<void> {
  await kv.put(indexKey(org), JSON.stringify(ids));
}

interface ParsedCreateBody {
  kind: DestKind;
  url: string;
  streamKey?: string;
  passphrase?: string;
}

function parseCreateBody(body: unknown): { body: ParsedCreateBody } | { error: string } {
  if (!body || typeof body !== "object") return { error: "body must be a JSON object" };
  const b = body as Record<string, unknown>;
  if (b.kind !== "rtmp" && b.kind !== "srt") return { error: "kind must be 'rtmp' or 'srt'" };
  if (typeof b.url !== "string" || !b.url) return { error: "url is required (string)" };
  if (b.streamKey !== undefined && typeof b.streamKey !== "string") return { error: "streamKey must be a string" };
  if (b.passphrase !== undefined && typeof b.passphrase !== "string") return { error: "passphrase must be a string" };
  return {
    body: {
      kind: b.kind,
      url: b.url,
      ...(typeof b.streamKey === "string" ? { streamKey: b.streamKey } : {}),
      ...(typeof b.passphrase === "string" ? { passphrase: b.passphrase } : {}),
    },
  };
}

export interface EgressDestinationsDeps {
  /** Injected for SSRF-guard hostname resolution + AES key material in tests. */
  resolveHost?: (hostname: string) => Promise<string[]>;
  fetchFn?: typeof fetch;
  now?: () => number;
}

async function createDestination(
  kv: StreamInputKv,
  env: EgressDestinationsEnv,
  org: string,
  request: Request,
  deps: EgressDestinationsDeps,
): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonError("DEST_BAD_REQUEST", "request body must be valid JSON", 400);
  }
  const parsed = parseCreateBody(body);
  if ("error" in parsed) return jsonError("DEST_BAD_REQUEST", parsed.error, 400);
  const { kind, url, streamKey, passphrase } = parsed.body;

  // #17 SSRF guard — deny-by-default, DNS-rebind-safe (resolves + checks the resolved IP, not just the string).
  const verdict = await validateDestinationUrl(kind, url, { resolveHost: deps.resolveHost, fetchFn: deps.fetchFn });
  if (!verdict.ok) {
    return jsonError("DEST_URL_REJECTED", `destination url rejected: ${verdict.reason}`, 400);
  }

  let aesKey: CryptoKey;
  try {
    aesKey = await getAesKey(env);
  } catch (e) {
    // no-silent-failure: an unconfigured/malformed encryption key must 503, never silently store plaintext.
    console.error(`egress-destinations create: encryption key unavailable org=${org}: ${(e as Error)?.message}`);
    return jsonError("DEST_KEY_CRYPTO_NOT_CONFIGURED", "destination key encryption is not configured", 503);
  }

  const id = crypto.randomUUID();
  const now = deps.now ? deps.now() : Date.now();
  const record: EgressDestinationRecord = {
    id,
    org,
    kind,
    url,
    ...(streamKey !== undefined ? { streamKeyEnc: await encryptField(aesKey, streamKey) } : {}),
    ...(passphrase !== undefined ? { passphraseEnc: await encryptField(aesKey, passphrase) } : {}),
    createdAt: now,
  };

  await kv.put(recordKey(org, id), JSON.stringify(record));
  const ids = await readIndex(kv, org);
  if (!ids.includes(id)) await writeIndex(kv, org, [...ids, id]);

  return Response.json({ destination: redactDestination(record) }, { status: 201 });
}

async function listDestinations(kv: StreamInputKv, org: string): Promise<Response> {
  const ids = await readIndex(kv, org);
  const records = await Promise.all(ids.map((id) => kv.get(recordKey(org, id))));
  const destinations = records
    .filter((r): r is string => r !== null)
    .map((r) => redactDestination(JSON.parse(r) as EgressDestinationRecord));
  return Response.json({ destinations }, { status: 200 });
}

async function getDestination(kv: StreamInputKv, org: string, id: string): Promise<Response> {
  const raw = await kv.get(recordKey(org, id));
  if (raw === null) return jsonError("DEST_NOT_FOUND", "destination not found", 404);
  const record = JSON.parse(raw) as EgressDestinationRecord;
  if (record.org !== org) return jsonError("DEST_FORBIDDEN", "destination belongs to a different org", 403);
  return Response.json({ destination: redactDestination(record) }, { status: 200 });
}

/** Mirrors #310 (whep-sources teardown) EXACTLY: absent → idempotent 200 (retry-safe), foreign org → 403,
 *  otherwise remove the forward record + prune the reverse index. */
async function deleteDestination(kv: StreamInputKv, org: string, id: string): Promise<Response> {
  const raw = await kv.get(recordKey(org, id));
  if (raw === null) return Response.json({ ok: true, id }, { status: 200 });
  const record = JSON.parse(raw) as EgressDestinationRecord;
  if (record.org !== org) return jsonError("DEST_FORBIDDEN", "destination belongs to a different org", 403);

  await kv.delete(recordKey(org, id));
  const ids = await readIndex(kv, org);
  const next = ids.filter((x) => x !== id);
  if (next.length !== ids.length) await writeIndex(kv, org, next);

  return Response.json({ ok: true, id }, { status: 200 });
}

/**
 * Handle `/v1/egress/destinations[/{id}]`. Returns a Response for a recognized method/path, or `null` so the
 * caller falls through to the 501 catch-all (same null-fallthrough contract as handleWhip/handleWhep/
 * handleWhepSources). `org` is the gateway-stamped, already-validated caller org.
 */
export async function handleEgressDestinations(
  request: Request,
  env: EgressDestinationsEnv,
  org: string,
  deps: EgressDestinationsDeps = {},
): Promise<Response | null> {
  const url = new URL(request.url);
  const rawId = matchIdPath(url.pathname);
  if (url.pathname !== DESTINATIONS_PATH && rawId === null) return null;

  const kv = env.RT_MEETING_ORG;
  if (!kv) {
    return jsonError("DEST_NOT_CONFIGURED", "RT_MEETING_ORG KV binding is not configured", 503);
  }

  if (rawId !== null) {
    let id: string;
    try {
      id = decodeURIComponent(rawId);
    } catch {
      return jsonError("DEST_BAD_REQUEST", "id path segment is not valid percent-encoding", 400);
    }
    if (!id || !DEST_ID.test(id)) return jsonError("DEST_BAD_REQUEST", "id must be a valid destination id", 400);

    if (request.method === "GET") return getDestination(kv, org, id);
    if (request.method === "DELETE") return deleteDestination(kv, org, id);
    return jsonError("DEST_METHOD_NOT_ALLOWED", "GET or DELETE a specific destination", 405);
  }

  if (request.method === "POST") return createDestination(kv, env, org, request, deps);
  if (request.method === "GET") return listDestinations(kv, org);
  return jsonError("DEST_METHOD_NOT_ALLOWED", "POST to create or GET to list destinations", 405);
}

/**
 * Dispatch wrapper mirroring `maybeHandleWhepSources`: co-locates the flag + gateway-trust + org gating with
 * the handler it guards. Returns null (fall-through) when the path isn't `/v1/egress/destinations[/{id}]` or
 * the surface is INERT.
 */
export async function maybeHandleEgressDestinations(
  request: Request,
  env: EgressDestinationsEnv & { WAVE_INTERNAL_SECRET?: string },
  gatewayGate: (request: Request, secret: string | undefined) => Response | null,
  safeOrg: RegExp,
): Promise<Response | null> {
  const url = new URL(request.url);
  const isDestPath = url.pathname === DESTINATIONS_PATH || matchIdPath(url.pathname) !== null;
  if (!isDestPath || !egressDestMgmtEnabled(env)) return null;
  const denied = gatewayGate(request, env.WAVE_INTERNAL_SECRET);
  if (denied) return denied;
  const org = request.headers.get("x-wave-org") ?? "";
  if (!safeOrg.test(org)) {
    return Response.json(
      { error: "BAD_REQUEST", message: "missing or malformed org context (x-wave-org) — stamped by the gateway" },
      { status: 400 },
    );
  }
  return handleEgressDestinations(request, env, org);
}

/**
 * Resolve a DECRYPTED destination for the egress-ARM path (O1/O2, not built yet). Returns null when the
 * destination is absent OR belongs to a different org (same fail-closed shape as the HTTP GET, minus the
 * response envelope — the arm path decides its own error handling).
 *
 * SSRF RE-CHECK IS THE CALLER'S RESPONSIBILITY. This function does NOT call `validateDestinationUrl` again —
 * only the caller knows the exact moment it is about to open the socket, and DNS can rebind between this
 * resolve and that connect. O1/O2's arm implementation MUST re-run `validateDestinationUrl(kind, url)`
 * immediately before dialing and refuse to connect on a reject, even though this same url passed at create time.
 */
export async function resolveDestinationForArm(
  env: EgressDestinationsEnv,
  org: string,
  destId: string,
): Promise<{ kind: DestKind; url: string; streamKey?: string; passphrase?: string } | null> {
  const kv = env.RT_MEETING_ORG;
  if (!kv) return null;
  const raw = await kv.get(recordKey(org, destId));
  if (raw === null) return null;
  const record = JSON.parse(raw) as EgressDestinationRecord;
  if (record.org !== org) return null;

  const aesKey = await getAesKey(env); // throws (fail-closed) if the encryption key is unconfigured
  return {
    kind: record.kind,
    url: record.url,
    ...(record.streamKeyEnc ? { streamKey: await decryptField(aesKey, record.streamKeyEnc) } : {}),
    ...(record.passphraseEnc ? { passphrase: await decryptField(aesKey, record.passphraseEnc) } : {}),
  };
}

export { DESTINATIONS_PATH };
