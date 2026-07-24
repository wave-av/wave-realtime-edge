/**
 * WHEP-A (whep-live-egress-golive epic) — the CONCRETE `CfStreamLiveClient` adapter: the "ARM slice" the
 * ingest backend (`ingress-cf-stream-live.ts`) deferred. This is the ONLY new I/O in Phase A — a real
 * Cloudflare Stream Live `POST /accounts/{acct}/stream/live_inputs` call plus the two KV writes the WHEP
 * egress path depends on. The backend stays a pure decision engine over the injected `CfStreamLiveClient`
 * interface; nothing here changes that seam.
 *
 * WHAT IT DOES, ATOMICALLY (contract §3, tenant isolation §9.6):
 *   1. Creates a CF Stream Live input (recording off) on the Stream account (`c23f0a`). CF issues RTMPS + SRT
 *      push endpoints (and a WHIP `webRTC.url`) the caller feeds; the `uid` it returns is the WHEP `?resource=`
 *      key and the dispatch key everything downstream is keyed on.
 *   2. Writes the FORWARD org binding `stream-input-org:{uid} = {org}` (a BARE org string — exactly what
 *      `whep.ts:resolveInputOrgMatch` and `stream-bridge.ts:resolveOrg` read). Without it the WHEP subscribe
 *      fail-closes 404 and the stream-bridge receiver drops the input — so it is written here, at provision.
 *   3. Writes the REVERSE per-org index `org-stream-inputs:{org} += {uid, room, createdAt}` so a viewer can
 *      DISCOVER what their org can watch (`GET /v1/whep/sources`, WHEP-C). New for this epic.
 *
 * COMPENSATION (saga-compensation-for-distributed-mutations): the CF input is created FIRST, then the KV
 * bindings. If the required FORWARD write fails, the just-created CF input would be an un-bridgeable orphan —
 * so we best-effort DELETE it and return a typed `{ok:false}`, never a half-provisioned success.
 *
 * PURE-SEAM + INJECTED: `fetch`, KV, and clock are injected, so the whole adapter is unit-tested with a fake
 * CF `fetch` + a fake KV and NO real network/CF-API/KV code runs in test.
 */
import type {
  CfStreamLiveClient,
  CfStreamLiveEndpoint,
  CfStreamLiveIngestRequest,
  CfStreamLiveResult,
} from "./ingress-cf-stream-live.js";

/** The minimal KV surface the adapter reads/writes (forward org binding + reverse per-org index). Structurally
 *  satisfied by a Workers `KVNamespace` (the bound `RT_MEETING_ORG`). */
export interface StreamInputKv {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, opts?: { expirationTtl?: number }): Promise<void>;
  delete(key: string): Promise<void>;
}

/** Reverse-index KV key prefix: `org → [its live-input uids]`, powering org-scoped source discovery. Distinct
 *  from `stream-input-org:` (the forward uid→org map) so the two never collide. */
export const ORG_STREAM_INPUTS_PREFIX = "org-stream-inputs:";
/** Forward org-binding prefix — re-declared from stream-bridge's SSOT via import below (never hand-duplicated). */
import { STREAM_INPUT_ORG_PREFIX } from "./stream-bridge.js";

/** One entry in the reverse per-org index. */
export interface OrgStreamInputEntry {
  readonly uid: string;
  readonly room: string;
  readonly createdAt: number;
}

/** Bound on how many recent inputs the reverse index keeps per org (newest-first). Keeps the KV value small and
 *  the discovery list bounded; a reconcile sweep (follow-up) prunes inputs CF has already reaped. */
export const ORG_INDEX_MAX_ENTRIES = 100;

/** Injected config for the live adapter. `accountId`/`apiToken` target the CF Stream account (`c23f0a`); `kv` is
 *  the bound `RT_MEETING_ORG`. `fetchFn`/`now`/`ttlSeconds` are injectable for tests + lifecycle tuning. */
export interface CfStreamLiveClientConfig {
  readonly accountId: string;
  readonly apiToken: string;
  readonly kv: StreamInputKv;
  readonly fetchFn?: typeof fetch;
  readonly now?: () => number;
  /** KV TTL (seconds) for both bindings. Matches the 14-day window other RT_MEETING_ORG writes use. */
  readonly ttlSeconds?: number;
  /** E3n (wre#290) auto-record flag, resolved by the caller from `E3N_AUTORECORD_ENABLED`. Absent/false → the
   *  input is created with `recording:{mode:"off"}` (today's byte-identical behavior). True → `"automatic"`, so
   *  CF Stream records every broadcast on this input for the completion-sweep (`e3n-recording-sweep.ts`) to
   *  correlate and register as VOD. This is the ONLY behavioral flip E3n makes here — no new I/O either way. */
  readonly autoRecordEnabled?: boolean;
}

const CF_API_BASE = "https://api.cloudflare.com/client/v4";
const DEFAULT_TTL_SECONDS = 60 * 60 * 24 * 14; // 14d — parity with route-dispatch RT_MEETING_ORG writes
/** A CF Stream live-input uid is 32 lowercase hex — the SAME shape WHEP validates as `?resource=`. Exported so
 *  callers (whep-sources.ts teardown) can pre-validate a path-derived uid against the SAME shape before use. */
export const LIVE_INPUT_UID = /^[0-9a-f]{32}$/;

/** Shape of the CF create-live-input reply we consume (grounded against the live API 2026-07-15). */
interface CfCreateInputResult {
  uid?: string;
  rtmps?: { url?: string; streamKey?: string };
  srt?: { url?: string; streamId?: string; passphrase?: string };
  webRTC?: { url?: string };
}
interface CfEnvelope {
  success?: boolean;
  errors?: unknown;
  result?: CfCreateInputResult;
}

/** Build the typed endpoint list from the CF reply. Only the fully-formed push endpoints are surfaced — a
 *  partial one (missing url) is dropped rather than emitted half-built. RTMP carries its stream key; SRT the url.
 *  (WHIP-to-Stream `webRTC.url` is carried separately by the handler for the browser feed, not as an
 *  `IngestProtocol` endpoint — `whip` is not a container push protocol.) */
function endpointsFromReply(r: CfCreateInputResult): CfStreamLiveEndpoint[] {
  const eps: CfStreamLiveEndpoint[] = [];
  if (r.rtmps?.url && r.rtmps.streamKey) {
    eps.push({ protocol: "rtmp", url: r.rtmps.url, streamKey: r.rtmps.streamKey });
  }
  if (r.srt?.url) {
    eps.push({ protocol: "srt", url: r.srt.url });
  }
  return eps;
}

/**
 * The concrete CF Stream Live origin. Depends ONLY on `CfStreamLiveClient` (the backend's injected seam) plus a
 * small config; holds no worker/env types so it is trivially testable.
 */
export class CfStreamLiveClientImpl implements CfStreamLiveClient {
  private readonly fetchFn: typeof fetch;
  private readonly now: () => number;
  private readonly ttl: number;
  private readonly autoRecord: boolean;

  constructor(private readonly cfg: CfStreamLiveClientConfig) {
    // BIND to globalThis: the Workers/undici global `fetch` throws "Illegal invocation" when called as a
    // method (`this.fetchFn(...)` would set `this` to this instance). Storing it bound keeps `this` correct.
    // (Unit tests inject their own `fetchFn`, so this binding is only exercised in the real runtime.)
    this.fetchFn = cfg.fetchFn ?? fetch.bind(globalThis);
    this.now = cfg.now ?? Date.now;
    this.ttl = cfg.ttlSeconds ?? DEFAULT_TTL_SECONDS;
    this.autoRecord = cfg.autoRecordEnabled === true;
  }

  async createLiveInput(req: CfStreamLiveIngestRequest): Promise<CfStreamLiveResult> {
    // 1. Create the CF Stream Live input. E3n (wre#290): recording mode flips to "automatic" ONLY when the
    //    caller resolved `E3N_AUTORECORD_ENABLED` truthy — default stays "off", byte-identical to today.
    //    defaultCreator carries the org for CF-side attribution either way.
    let created: CfCreateInputResult;
    try {
      const res = await this.fetchFn(`${CF_API_BASE}/accounts/${this.cfg.accountId}/stream/live_inputs`, {
        method: "POST",
        headers: { authorization: `Bearer ${this.cfg.apiToken}`, "content-type": "application/json" },
        body: JSON.stringify({
          meta: { name: `wave:${req.org}:${req.room}` },
          recording: { mode: this.autoRecord ? "automatic" : "off" },
          defaultCreator: req.org,
        }),
      });
      const env = (await res.json().catch(() => ({}))) as CfEnvelope;
      if (!res.ok || env.success !== true || !env.result) {
        return { ok: false, status: res.status || 502, reason: `cf create-input failed: ${summarize(env.errors)}` };
      }
      created = env.result;
    } catch (e) {
      return { ok: false, status: 502, reason: `cf create-input error: ${(e as Error)?.message ?? String(e)}` };
    }

    const uid = created.uid ?? "";
    if (!LIVE_INPUT_UID.test(uid)) {
      return { ok: false, status: 502, reason: `cf create-input returned no/invalid uid (${JSON.stringify(created.uid)})` };
    }

    // 2. FORWARD org binding — REQUIRED. On failure, compensate (delete the orphan CF input) and fail typed.
    try {
      await this.cfg.kv.put(`${STREAM_INPUT_ORG_PREFIX}${uid}`, req.org, { expirationTtl: this.ttl });
    } catch (e) {
      await this.bestEffortDelete(uid);
      return { ok: false, status: 500, reason: `forward KV bind failed (orphan input ${uid} deleted): ${(e as Error)?.message ?? String(e)}` };
    }

    // 3. REVERSE per-org index — best-effort (discovery convenience; the forward binding already makes the input
    //    subscribable). A reverse-index failure must NOT undo a valid provision, so it is logged, not fatal.
    try {
      await this.appendReverseIndex(req.org, { uid, room: req.room, createdAt: this.now() });
    } catch (e) {
      console.warn(`whep-sources reverse index append failed org=${req.org} uid=${uid}: ${(e as Error)?.message ?? e}`);
    }

    return { ok: true, input: { uid, endpoints: endpointsFromReply(created) } };
  }

  /** Read-modify-write the reverse index: prepend the new entry (newest-first), dedupe by uid, cap the list. */
  private async appendReverseIndex(org: string, entry: OrgStreamInputEntry): Promise<void> {
    const key = `${ORG_STREAM_INPUTS_PREFIX}${org}`;
    const existing = await this.readReverseIndex(org);
    const deduped = existing.filter((e) => e.uid !== entry.uid);
    const next = [entry, ...deduped].slice(0, ORG_INDEX_MAX_ENTRIES);
    await this.cfg.kv.put(key, JSON.stringify(next), { expirationTtl: this.ttl });
  }

  /** Parse the reverse index for an org, tolerating absent/corrupt values (→ empty). Exposed for the discovery
   *  handler so both read the SAME shape. */
  async readReverseIndex(org: string): Promise<OrgStreamInputEntry[]> {
    return readOrgStreamInputs(this.cfg.kv, org);
  }

  /** Best-effort compensation delete of an orphaned CF input (never throws — compensation must not mask the
   *  original error it is cleaning up after). */
  private async bestEffortDelete(uid: string): Promise<void> {
    await CfStreamLiveClientImpl.bestEffortDeleteInput(this.fetchFn, this.cfg.accountId, this.cfg.apiToken, uid);
  }

  /** Public best-effort DELETE of a CF Stream Live input by uid — never throws (logs on failure). Callers that
   *  create an input OUTSIDE the atomic `createLiveInput` success path (e.g. a synthetic proof probe that must
   *  not leak a real CF input + KV entries every run) use this to compensate. Static so a caller with only a
   *  `uid` + the same config (no live client instance needed) can still clean up. */
  static async bestEffortDeleteInput(
    fetchFn: typeof fetch,
    accountId: string,
    apiToken: string,
    uid: string,
  ): Promise<void> {
    try {
      await fetchFn(`${CF_API_BASE}/accounts/${accountId}/stream/live_inputs/${uid}`, {
        method: "DELETE",
        headers: { authorization: `Bearer ${apiToken}` },
      });
    } catch (e) {
      console.warn(`cf-stream-live bestEffortDeleteInput failed uid=${uid}: ${(e as Error)?.message ?? e}`);
    }
  }
}

/**
 * Read + parse an org's reverse source index straight from KV — the discovery read path (`GET /v1/whep/sources`).
 * A free function (no CF token needed) so listing works even where the provision creds are absent. Tolerates
 * absent/corrupt values (→ empty). The SAME shape `CfStreamLiveClientImpl` writes.
 */
export async function readOrgStreamInputs(kv: StreamInputKv, org: string): Promise<OrgStreamInputEntry[]> {
  const raw = await kv.get(`${ORG_STREAM_INPUTS_PREFIX}${org}`);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (e): e is OrgStreamInputEntry =>
        e && typeof e.uid === "string" && typeof e.room === "string" && typeof e.createdAt === "number",
    );
  } catch {
    return [];
  }
}

/** Compact a CF `errors` array into a short reason string (never dumps the whole envelope). */
function summarize(errors: unknown): string {
  if (Array.isArray(errors) && errors.length) {
    const first = errors[0] as { code?: unknown; message?: unknown };
    return `[${first?.code ?? "?"}] ${String(first?.message ?? "").slice(0, 120)}`;
  }
  return "unknown error";
}
