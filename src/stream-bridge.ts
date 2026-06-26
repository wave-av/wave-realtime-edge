/// <reference types="@cloudflare/workers-types" />
/**
 * B1 (#91-a) — CF Stream Live → WAVE SFU bridge CONTROL PLANE (webhook receiver + lifecycle reconcile).
 *
 * FROZEN CONTRACT: ~/.claude/plans/wave-any-to-any-matrix/cf-stream-bridge-frozen-contract-DRAFT.md
 * (v0.1) §2/§3/§6-B1/§9. This is the thin control-only Worker organ. It NEVER touches a media byte: on a
 * signed `live_input.connected` it resolves the input's org and dispatches the republisher CONTAINER
 * (`whep-to-whip`, B2) to start; on `.disconnected` it tells the container to stop. The media path —
 * WHEP-pull → passthrough → WHIP-out → SFU → recorder — lives entirely in the container and the SFU
 * (contract §9.2); this module relays only SDP/JSON text via the container's start/stop control fetch.
 *
 * INERT (contract §6-B1, §9.8): the whole surface is reached ONLY when `STREAM_BRIDGE_ENABLED` is truthy.
 * Off (the default) → the worker's 501 catch-all is unchanged and this module is never entered. The
 * `[[containers]] StreamBridge` binding stays COMMENTED in wrangler.toml until the ◆ go-live, so even when
 * the flag is on without a binding the dispatch fails CLOSED (503), never silently.
 *
 * SECURITY (load-bearing, contract §2/§9.9): like `rtk-webhook.ts` this route is intentionally NOT behind
 * the gateway (`x-wave-internal`) — Cloudflare Stream calls it directly. It therefore authenticates itself:
 * the `Webhook-Signature` header is an HMAC-SHA256 over `${time}.${rawBody}` keyed by the per-subscription
 * signing secret (`WAVE_STREAM_WEBHOOK_SECRET`), verified in CONSTANT TIME BEFORE the body is parsed. A
 * missing/invalid/stale signature → 401, nothing acted on. (This is CF Stream's documented webhook scheme —
 * an HMAC variant of rtk's RSA well-known; contract Q-3 confirms the exact signed-bytes shape at provision.)
 *
 * ORG ATTRIBUTION (contract §9.1): org comes ONLY from a server-side KV lookup of the input uid
 * (`STREAM_INPUT_ORG`, reusing the RT_MEETING_ORG namespace under a `stream-input-org:` prefix — exactly how
 * whip.ts reuses it). The webhook body's uid is a DISPATCH LOOKUP KEY, never an org claim on the wire. A KV
 * miss → loud `stream-bridge-skipped-no-org` warn + NO dispatch (never an orphan SFU session / bad billing
 * prefix), mirroring rtk's `__unattributed__` discipline but fail-closed (no media admitted at all).
 *
 * IDEMPOTENCY (contract §6/Q-6): the SFU room is the deterministic `cfstream:${uid}` — webhook + the periodic
 * (15-min) cron lifecycle-poll can both fire `connected`; the second dispatch JOINs the same room (WHIP listener
 * #98 rejects a duplicate resource for the same deterministic room), never a second session.
 */

/** KV-prefix mapping a CF Stream live_input uid → the org whose bridge key republishes it (server-side). */
export const STREAM_INPUT_ORG_PREFIX = "stream-input-org:";
/** KV-prefix for the durable pending-republisher set the cron lifecycle-poll reconciles. */
export const STREAM_PENDING_PREFIX = "stream-bridge-pending:";
/** Bounded recovery window for a pending republisher (KV TTL). A live input we cannot bridge within this
 * window across cron ticks is given up loudly rather than re-dispatched forever. */
export const STREAM_PENDING_TTL_SECONDS = 60 * 60 * 6; // 6h — a live event is long, but not unbounded
/** Max re-dispatch attempts before the cron gives up on a pending input (loud). */
export const MAX_STREAM_DISPATCH_ATTEMPTS = 5;
/** Replay-window tolerance: reject a signature whose `time=` is more than this far from now (seconds). */
export const STREAM_SIG_TOLERANCE_SECONDS = 60 * 5; // ±5 min — CF's recommended webhook skew

/** The deterministic SFU room id for a bridged input (contract §6/Q-6). One input → one room, idempotent. */
export function bridgeRoomFor(uid: string): string {
  return `cfstream:${uid}`;
}

/** Truthy-flag check (mirrors whipIngestEnabled): "1"/"true"/true → enabled; absent/"0"/false → inert. */
export function streamBridgeEnabled(env: { STREAM_BRIDGE_ENABLED?: string | boolean }): boolean {
  const v = env.STREAM_BRIDGE_ENABLED;
  return v === true || v === "1" || v === "true";
}

/** Hex-encode bytes (lower-case), for comparing an HMAC digest to the header's `sig1=`. */
function toHex(buf: ArrayBuffer): string {
  const b = new Uint8Array(buf);
  let s = "";
  for (let i = 0; i < b.length; i++) s += b[i].toString(16).padStart(2, "0");
  return s;
}

/** Constant-time equality of two equal-length hex strings (length leak only — both are fixed-width digests). */
export function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** Parsed `Webhook-Signature: time=<unix>,sig1=<hex>` → { time, sig }, or null if malformed. */
export function parseWebhookSignature(header: string | null): { time: number; sig: string } | null {
  if (!header) return null;
  let time = NaN;
  let sig = "";
  for (const part of header.split(",")) {
    const [k, v] = part.split("=", 2);
    if (k?.trim() === "time") time = Number(v);
    else if (k?.trim() === "sig1") sig = (v ?? "").trim();
  }
  if (!Number.isFinite(time) || !sig) return null;
  return { time, sig };
}

/**
 * Verify a CF Stream webhook signature over the RAW body. Signed message = `${time}.${rawBody}`, HMAC-SHA256
 * keyed by the subscription secret, compared constant-time to the header's `sig1` hex. Fail-CLOSED: a
 * malformed header, a stale `time` (> tolerance), an import error, or a digest mismatch all yield false
 * (never throws). `now` is injectable so the replay-window check is deterministic in tests.
 */
export async function verifyStreamSignature(
  rawBody: BufferSource,
  header: string | null,
  secret: string,
  now: number = Date.now(),
  subtle: SubtleCrypto = crypto.subtle,
): Promise<boolean> {
  if (!secret) return false;
  const parsed = parseWebhookSignature(header);
  if (!parsed) return false;
  // Replay guard: reject a signature whose timestamp is outside the tolerance window.
  if (Math.abs(now / 1000 - parsed.time) > STREAM_SIG_TOLERANCE_SECONDS) return false;
  try {
    const key = await subtle.importKey(
      "raw",
      new TextEncoder().encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const bodyText = new TextDecoder().decode(rawBody);
    const mac = await subtle.sign("HMAC", key, new TextEncoder().encode(`${parsed.time}.${bodyText}`));
    return timingSafeEqualHex(toHex(mac), parsed.sig.toLowerCase());
  } catch {
    return false; // never trust on a crypto error
  }
}

/** Lifecycle states we act on. `connected` → start a republisher; `disconnected` → stop it. */
export type StreamLifecycle = "connected" | "disconnected" | "other";

/** The fields we read off a CF Stream `live_input.*` webhook payload (tolerant of field-name variants). */
export interface StreamBridgeEvent {
  uid: string; // the live_input uid (the dispatch lookup key — NEVER an org claim)
  lifecycle: StreamLifecycle;
  live?: boolean; // input is currently receiving a contribution feed (used by the cron lifecycle-poll)
}

/**
 * Parse a CF Stream live webhook body. Tolerant of `notificationName`/`eventType`/`event` for the lifecycle
 * name and `input_id`/`uid`/`live_input.uid` for the input id — CF's payload shape varies across the live
 * webhook surfaces (contract Q-3 pins the exact one at provision). Returns null if there is no usable uid.
 */
export function parseStreamEvent(rawText: string): StreamBridgeEvent | null {
  let j: Record<string, unknown>;
  try {
    j = JSON.parse(rawText) as Record<string, unknown>;
  } catch {
    return null;
  }
  const li = (j.live_input ?? null) as Record<string, unknown> | null;
  const uid = String(
    j.input_id ?? j.uid ?? j.inputId ?? (li && typeof li.uid === "string" ? li.uid : "") ?? "",
  );
  if (!uid) return null;
  const name = String(j.notificationName ?? j.eventType ?? j.event ?? "").toLowerCase();
  const lifecycle: StreamLifecycle = name.includes("connected")
    ? name.includes("disconnect")
      ? "disconnected"
      : "connected"
    : "other";
  const live =
    typeof j.live === "boolean"
      ? j.live
      : li && typeof li.live === "boolean"
        ? (li.live as boolean)
        : undefined;
  return { uid, lifecycle, live };
}

/**
 * Control-plane capabilities, injected so every path unit-tests with NO live network/KV/container (mirrors
 * rtk-webhook's WebhookDeps + whip's WhipDeps seams). `resolveOrg` is the server-side uid→org lookup;
 * `dispatchStart`/`dispatchStop` are the container control fetches (live: getContainer(STREAM_BRIDGE,
 * `${org}:${uid}`).fetch('/start'|'/stop')); `markPending`/`clearPending` are the durable cron backstop.
 */
export interface StreamBridgeDeps {
  /** uid → org (live: KV get on STREAM_INPUT_ORG). Miss → null → fail-closed skip, NO dispatch. */
  resolveOrg(uid: string): Promise<string | null>;
  /** Start the republisher container for (org, uid) into the deterministic room. Control fetch only (no media). */
  dispatchStart(org: string, uid: string, room: string): Promise<void>;
  /** Stop the republisher container for (org, uid) → WHIP DELETE → SFU close → stop meter. */
  dispatchStop(org: string, uid: string): Promise<void>;
  /** Structured observability sink (live: console.log JSON). No secrets, no media — uid + org + lifecycle only. */
  log?(msg: string, fields: Record<string, unknown>): void;
  /** Durable retry: persist a pending-republisher record (uid→{org,attempts}) the cron reconcile re-dispatches. */
  markPending?(uid: string, org: string): Promise<void>;
  /** Clear a pending record once a disconnected (or a confirmed-running) input no longer needs re-dispatch. */
  clearPending?(uid: string): Promise<void>;
  /** Background a dispatch off the request (live: ctx.waitUntil). Absent → awaited (tests assert it). */
  waitUntil?(p: Promise<unknown>): void;
}

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

/**
 * Handle one CF Stream `live_input.*` webhook POST. Verify the HMAC over the RAW body FIRST (constant-time,
 * replay-guarded), then parse, then dispatch the CONTROL action — never a media byte. A bad/absent/stale
 * signature → 401 before parse. A validly-signed event always acks 200 (so CF stops retrying); the dispatch
 * itself is best-effort + fail-open behind the ack (a container start failure is logged + enqueued for the
 * cron lifecycle-poll, never failing the signed ack). Org miss → loud skip, no dispatch (fail-closed admission).
 *
 * @param secret the per-subscription signing secret (WAVE_STREAM_WEBHOOK_SECRET). Empty → every request 401s.
 */
export async function handleStreamBridge(
  request: Request,
  secret: string,
  deps: StreamBridgeDeps,
  now: number = Date.now(),
): Promise<Response> {
  const raw = await request.arrayBuffer();
  const sigHeader = request.headers.get("webhook-signature");

  if (!(await verifyStreamSignature(raw, sigHeader, secret, now))) {
    return jsonResponse({ error: "BAD_SIGNATURE" }, 401);
  }

  const evt = parseStreamEvent(new TextDecoder().decode(raw));
  if (!evt) return jsonResponse({ error: "BAD_PAYLOAD" }, 400);

  const base = { uid: evt.uid, lifecycle: evt.lifecycle };

  if (evt.lifecycle === "disconnected") {
    // Resolve org for the stop (a stop with no org is a no-op skip — nothing to tear down for an un-bridged input).
    const org = await deps.resolveOrg(evt.uid).catch(() => null);
    if (org) {
      const stop = deps
        .dispatchStop(org, evt.uid)
        .then(() => deps.clearPending?.(evt.uid))
        .catch((err) => deps.log?.("stream-bridge-stop-failed", { ...base, org, error: String(err) }));
      if (deps.waitUntil) deps.waitUntil(stop);
      else await stop;
    } else {
      deps.log?.("stream-bridge-stop-no-org", base);
    }
    return jsonResponse({ ok: true, lifecycle: evt.lifecycle }, 200);
  }

  if (evt.lifecycle === "connected") {
    const org = await deps.resolveOrg(evt.uid).catch(() => null);
    if (!org) {
      // Fail-CLOSED admission: never start a republisher / SFU session for an input with no org (no orphan
      // billing prefix, no untrusted-input-driven media). Loud — the sweep/operator surfaces it.
      deps.log?.("stream-bridge-skipped-no-org", base);
      return jsonResponse({ ok: true, lifecycle: evt.lifecycle, skipped: "no-org" }, 200);
    }
    const room = bridgeRoomFor(evt.uid); // deterministic → idempotent re-dispatch joins the same room
    const start = deps
      .dispatchStart(org, evt.uid, room)
      .then(() => deps.clearPending?.(evt.uid))
      .catch(async (err) => {
        deps.log?.("stream-bridge-start-failed", { ...base, org, room, error: String(err) });
        await deps.markPending?.(evt.uid, org).catch(() => {}); // durable cron re-dispatch
      });
    if (deps.waitUntil) deps.waitUntil(start);
    else await start;
    return jsonResponse({ ok: true, lifecycle: evt.lifecycle, room }, 200);
  }

  deps.log?.("stream-bridge-lifecycle-other", base);
  return jsonResponse({ ok: true, lifecycle: evt.lifecycle }, 200);
}

/** A durable pending-republisher record (JSON value at `${STREAM_PENDING_PREFIX}${uid}`). */
interface PendingBridge {
  org: string;
  attempts: number;
}

/**
 * Cron lifecycle-poll backstop (scheduled()): re-dispatch every pending-republisher record a POST-ack start
 * failed on. CF Stream fires `live_input.connected` once; on our 200 it never re-delivers — so without this a
 * transient container-start failure would leave a LIVE input un-bridged. For each pending record we re-issue
 * dispatchStart for the deterministic room (idempotent: a duplicate joins the same room, never a 2nd session).
 * On success we clear it; on a still-failing start we bump attempts and give up loudly after the max. Mirrors
 * `reconcilePending` in rtk-webhook.ts. Best-effort — never throws out of scheduled().
 */
export async function reconcileStreamPending(
  kv: KVNamespace,
  deps: Pick<StreamBridgeDeps, "dispatchStart" | "log">,
  log?: (msg: string, fields: Record<string, unknown>) => void,
): Promise<void> {
  let cursor: string | undefined;
  do {
    const page = await kv.list({ prefix: STREAM_PENDING_PREFIX, cursor });
    cursor = page.list_complete ? undefined : page.cursor;
    for (const k of page.keys) {
      const uid = k.name.slice(STREAM_PENDING_PREFIX.length);
      const raw = await kv.get(k.name);
      if (!raw) continue; // expired between list and get
      let rec: PendingBridge;
      try {
        rec = JSON.parse(raw) as PendingBridge;
      } catch {
        await kv.delete(k.name); // corrupt → drop
        continue;
      }
      if (!rec?.org) {
        await kv.delete(k.name);
        continue;
      }
      let ok = false;
      try {
        await deps.dispatchStart(rec.org, uid, bridgeRoomFor(uid));
        ok = true;
      } catch (err) {
        (log ?? deps.log)?.("stream-bridge-reconcile-error", { uid, org: rec.org, error: String(err) });
      }
      if (ok) {
        await kv.delete(k.name);
        (log ?? deps.log)?.("stream-bridge-reconciled", { uid, org: rec.org });
      } else {
        const attempts = (Number(rec.attempts) || 0) + 1;
        if (attempts >= MAX_STREAM_DISPATCH_ATTEMPTS) {
          await kv.delete(k.name);
          (log ?? deps.log)?.("stream-bridge-reconcile-giveup", { uid, org: rec.org, attempts });
        } else {
          await kv.put(k.name, JSON.stringify({ org: rec.org, attempts }), {
            expirationTtl: STREAM_PENDING_TTL_SECONDS,
          });
        }
      }
    }
  } while (cursor);
}

// ── Live runtime wiring (kept HERE so worker.ts only DELEGATES — never builds deps inline; file-size budget). ──

/** The worker Env subset the live wiring needs: the flag/secret + the container binding + the KV. */
export interface StreamBridgeRuntimeEnv {
  STREAM_BRIDGE_ENABLED?: string | boolean;
  WAVE_STREAM_WEBHOOK_SECRET?: string;
  STREAM_BRIDGE?: DurableObjectNamespace; // B2 republisher container — COMMENTED until ◆ go-live → absent → fail-closed
  RT_MEETING_ORG?: KVNamespace; // reused KV (stream-input-org: + stream-bridge-pending: prefixes)
}

/** Minimal waitUntil-carrier (ExecutionContext satisfies it) so this module needs no worker-runtime import. */
interface WaitUntilCtx {
  waitUntil(p: Promise<unknown>): void;
}

/**
 * Live container dispatch: reach the republisher container (B2) by the deterministic `${org}:${uid}` DO id and
 * POST a control /start (text {room, uid}). Binding COMMENTED until ◆ go-live → absent → THROWS (handler logs +
 * cron-requeues), never silent. Shared by the webhook route and the cron reconcile.
 */
export async function liveStreamDispatchStart(
  env: StreamBridgeRuntimeEnv,
  org: string,
  uid: string,
  room: string,
): Promise<void> {
  if (!env.STREAM_BRIDGE) throw new Error("stream-bridge container binding absent (inert until ◆ go-live)");
  const stub = env.STREAM_BRIDGE.get(env.STREAM_BRIDGE.idFromName(`${org}:${uid}`));
  const res = await stub.fetch("https://stream-bridge/start", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ room, uid }),
  });
  if (!res.ok) throw new Error(`stream-bridge container /start → ${res.status}`);
}

/** Build the live StreamBridgeDeps (KV org-resolve + pending; container start/stop; ctx.waitUntil). */
export function liveStreamBridgeDeps(env: StreamBridgeRuntimeEnv, ctx?: WaitUntilCtx): StreamBridgeDeps {
  const kv = env.RT_MEETING_ORG;
  const log = (msg: string, fields: Record<string, unknown>) => console.log(JSON.stringify({ msg, ...fields }));
  return {
    resolveOrg: async (uid) => (kv ? kv.get(`${STREAM_INPUT_ORG_PREFIX}${uid}`) : null),
    dispatchStart: (org, uid, room) => liveStreamDispatchStart(env, org, uid, room),
    dispatchStop: async (org, uid) => {
      if (!env.STREAM_BRIDGE) return; // nothing bound → nothing to tear down
      const stub = env.STREAM_BRIDGE.get(env.STREAM_BRIDGE.idFromName(`${org}:${uid}`));
      await stub.fetch("https://stream-bridge/stop", { method: "POST" });
    },
    log,
    markPending: async (uid, org) => {
      if (kv)
        await kv.put(`${STREAM_PENDING_PREFIX}${uid}`, JSON.stringify({ org, attempts: 0 }), {
          expirationTtl: STREAM_PENDING_TTL_SECONDS,
        });
    },
    clearPending: async (uid) => {
      if (kv) await kv.delete(`${STREAM_PENDING_PREFIX}${uid}`);
    },
    waitUntil: ctx ? (p) => ctx.waitUntil(p) : undefined,
  };
}

/**
 * Route delegate for worker.ts: if this is the (enabled) CF Stream bridge webhook, handle it and return the
 * Response; otherwise return null so the worker falls through (501 catch-all when inert). One call site, zero
 * deps-building in worker.ts.
 */
export async function maybeHandleStreamBridge(
  request: Request,
  env: StreamBridgeRuntimeEnv,
  ctx?: WaitUntilCtx,
): Promise<Response | null> {
  if (request.method !== "POST" || !streamBridgeEnabled(env)) return null;
  if (new URL(request.url).pathname !== "/v1/stream/bridge/webhook") return null;
  return handleStreamBridge(request, env.WAVE_STREAM_WEBHOOK_SECRET ?? "", liveStreamBridgeDeps(env, ctx));
}

/** Cron delegate for worker.ts scheduled(): re-dispatch any pending republisher (INERT unless enabled + KV). */
export function scheduledStreamReconcile(env: StreamBridgeRuntimeEnv, ctx: WaitUntilCtx): void {
  if (!streamBridgeEnabled(env) || !env.RT_MEETING_ORG) return;
  ctx.waitUntil(
    reconcileStreamPending(
      env.RT_MEETING_ORG,
      { dispatchStart: (org, uid, room) => liveStreamDispatchStart(env, org, uid, room) },
      (msg, fields) => console.log(JSON.stringify({ msg, ...fields })),
    ),
  );
}
