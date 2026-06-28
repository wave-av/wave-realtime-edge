/// <reference types="@cloudflare/workers-types" />
/**
 * F (#55) — Direct (Plane-2) any-protocol ingest → WAVE SFU bridge CONTROL PLANE.
 *
 * FROZEN CONTRACT: ~/.claude/plans/wave-any-to-any-matrix/any-protocol-ingest-frozen-contract-DRAFT.md
 * (v0.1) §2/§3/§4/§6-F/§9. This is the thin control-only Worker organ for the SECOND ingest plane — the one
 * that terminates a NON-WebRTC contribution protocol (srt/rist/rtmp/moq) DIRECTLY in a per-protocol
 * Container, decodes, re-encodes to a WebRTC-negotiable codec, and republishes via WHIP into the SFU.
 *
 * It is the sibling of `stream-bridge.ts` (Plane-1, CF-Stream WHEP→WHIP, #91-B): IDENTICAL lifecycle
 * machinery (server-side org resolve, container /start + /stop control fetch, KV pending-set, every-15-min cron
 * reconcile), only the container MODE + the "what triggers a start" differ. Plane-1 starts on a signed
 * CF-Stream `live_input.connected` webhook; Plane-2 has NO such webhook (there is no CF-Stream
 * live_input.connected for RIST/MoQ, and we deliberately bypass CF Stream for RTMPS/SRT) — so the start
 * trigger is an EXPLICIT gateway-forwarded session-open control call (contract §3):
 *   gateway POST /v1/ingest/{proto}/session  → edge handleIngestBridge() → container /start
 *   gateway DELETE /v1/ingest/{proto}/session/{room} → edge → container /stop
 *
 * MEDIA NEVER ON THE WORKER (frozen invariant #2, contract §9.2): every byte of the contribution feed
 * terminates IN the per-protocol Container (the wave-transports engine decodes/re-encodes there) and at the
 * SFU. This module relays ONLY JSON/SDP text via the container's /start + /stop control fetch — it never
 * decodes, transcodes, or carries a media frame. (Transcode in the container is the §9.5 amendment;
 * invariant #2 — no media on a Worker — is unchanged and honored here.)
 *
 * TRUST (contract §3): UNLIKE the Plane-1 CF-Stream webhook (which self-authenticates an external CF call
 * via HMAC), this control call is GATEWAY-FORWARDED like every other paid `/v1/*` route — it trusts ONLY the
 * gateway-injected `x-wave-internal` seal (the worker's existing gatewayGate) and the gateway-stamped
 * `x-wave-org`. So org resolution is SERVER-SIDE from the key (frozen invariant #1): the org is read from the
 * gateway header, NEVER from the body/query. The body carries only the inbound endpoint info + the room.
 *
 * INERT (contract §6-F, §9): a route is reached ONLY when `INGEST_BRIDGE_ENABLED` is truthy AND the matching
 * per-protocol container binding (`SRT_BRIDGE`/`RIST_BRIDGE`/`RTMPS_BRIDGE`/`MOQ_BRIDGE`) is present. Off (the
 * default) → `maybeHandleIngestBridge` returns null → the worker's 501 catch-all is UNCHANGED. Flag on but a
 * binding absent → the dispatch fails CLOSED with a typed `<PROTO>_BRIDGE_NOT_ACTIVATED` 501 (honest, never a
 * fake transport, never a silent success) — exactly the `wave-bridge-edge/src/srt.ts` discipline (contract §3).
 *
 * METERING (contract §5): a Plane-2 leg is a bridged input → it bills the EXISTING
 * `wave_stream_bridge_minutes` SKU (no new SKU by default). The actual meter line is emitted by the WHIP
 * publish leg (the container republishes through the gateway with the sealed `x-wave-meter-override`); this
 * control plane only carries the meter name into the container /start payload so the container stamps it.
 */

import { METER_STREAM_BRIDGE_MINUTES } from "./whip.js";

/** The non-WebRTC contribution protocols this Plane-2 control plane dispatches. Byte-identical to the shared
 *  transport union (contract §1) — no new enum values minted here. WHIP is Plane-1 (cf-stream-bridge), not here. */
export const INGEST_PROTOCOLS = ["srt", "rist", "rtmp", "moq"] as const;
export type IngestProtocol = (typeof INGEST_PROTOCOLS)[number];

/** Narrowing guard for an untrusted path segment → a known protocol (else null → 400/501, never a default). */
export function asIngestProtocol(s: string): IngestProtocol | null {
  return (INGEST_PROTOCOLS as readonly string[]).includes(s) ? (s as IngestProtocol) : null;
}

/** Per-protocol container binding name (the wrangler `[[durable_objects.bindings]] name`). Absent → fail-closed 501. */
export const BRIDGE_BINDING: Record<IngestProtocol, string> = {
  srt: "SRT_BRIDGE",
  rist: "RIST_BRIDGE",
  rtmp: "RTMPS_BRIDGE",
  moq: "MOQ_BRIDGE",
};

/** KV-prefix for the durable pending-start set the cron reconcile re-dispatches (mirrors STREAM_PENDING_PREFIX). */
export const INGEST_PENDING_PREFIX = "ingest-bridge-pending:";
/** Bounded recovery window for a pending ingest start (KV TTL). Beyond this across cron ticks we give up loudly. */
export const INGEST_PENDING_TTL_SECONDS = 60 * 60 * 6; // 6h — a live contribution is long, but not unbounded
/** Max re-dispatch attempts before the cron gives up on a pending start (loud). */
export const MAX_INGEST_DISPATCH_ATTEMPTS = 5;

/** SFU room id for a bridged ingest leg: deterministic per (protocol, room) → idempotent re-dispatch joins
 *  the same SFU room (contract §3, mirrors stream-bridge bridgeRoomFor). `${proto}:${room}` is collision-safe
 *  across protocols (a srt room and a moq room never share an SFU session). */
export function ingestRoomFor(protocol: IngestProtocol, room: string): string {
  return `${protocol}:${room}`;
}

/** Truthy-flag check (mirrors streamBridgeEnabled): "1"/"true"/true → enabled; absent/"0"/false → inert. */
export function ingestBridgeEnabled(env: { INGEST_BRIDGE_ENABLED?: string | boolean }): boolean {
  const v = env.INGEST_BRIDGE_ENABLED;
  return v === true || v === "1" || v === "true";
}

/** Only safe single path/room segments cross into a DO id / container payload (validate-before-sink). */
const SAFE_ROOM = /^[A-Za-z0-9_:.-]{1,128}$/;

/**
 * The inbound endpoint info for one contribution leg — the listener coordinates the per-protocol container
 * must bind/accept to terminate the feed. This is TEXT only (host/port/path/streamKey); it is the LISTENER
 * descriptor, NEVER a media stream (media terminates in the container, contract §9.2). Validated before it is
 * placed in the /start payload. All fields optional — a self-hosted SRT/RIST leg may carry only host+port; a
 * CF-native MoQ leg may carry only a path; RTMPS may carry a streamKey.
 */
export interface IngestInbound {
  host?: string;
  port?: number;
  path?: string;
  streamKey?: string;
}

/** The /start control payload sent to the per-protocol container (contract §4). JSON/SDP text only — the
 *  Worker never sends media. The container terminates `protocol` at `inbound`, decodes→re-encodes, and
 *  WHIP-publishes to `whipEndpoint` using the bridge `wk_` key (`bridgeKeyRef`) into SFU `room`, stamping the
 *  `meter` override on the publish leg. The bridge key is passed by REF (a binding/secret name the container
 *  resolves env-side), NEVER inlined — no secret material on the wire (contract §8, never-log-or-leak). */
export interface IngestStartPayload {
  protocol: IngestProtocol;
  inbound: IngestInbound;
  whipEndpoint: string;
  bridgeKeyRef: string;
  room: string;
  meter: string;
}

/**
 * Control-plane capabilities, injected so every path unit-tests with NO live network/KV/container (mirrors
 * StreamBridgeDeps). `dispatchStart`/`dispatchStop` are the per-protocol container control fetches (live:
 * getContainer(<PROTO>_BRIDGE, `${org}:${room}`).fetch('/start'|'/stop')); `markPending`/`clearPending` are
 * the durable cron backstop. There is NO `resolveOrg` seam — org is gateway-stamped server-side, passed in.
 */
export interface IngestBridgeDeps {
  /** Start the per-protocol container for (org, room) with the full /start payload. Control fetch only (no media).
   *  THROWS `<PROTO>_BRIDGE_NOT_ACTIVATED` when the binding is absent → fail-closed (handler → 501). */
  dispatchStart(org: string, payload: IngestStartPayload): Promise<void>;
  /** Stop the per-protocol container for (org, protocol, room) → WHIP DELETE → SFU close → stop meter. */
  dispatchStop(org: string, protocol: IngestProtocol, room: string): Promise<void>;
  /** Structured observability sink (live: console.log JSON). No secrets, no media — org + proto + room only. */
  log?(msg: string, fields: Record<string, unknown>): void;
  /** Durable retry: persist a pending-start record the cron reconcile re-dispatches on a transient start failure. */
  markPending?(payload: IngestStartPayload, org: string): Promise<void>;
  /** Clear a pending record once a start succeeds or a stop tears the leg down. */
  clearPending?(org: string, protocol: IngestProtocol, room: string): Promise<void>;
}

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

/** Pending key is per (org, proto, room) so two orgs' identically-named rooms never collide in the cron set. */
function pendingKey(org: string, protocol: IngestProtocol, room: string): string {
  return `${INGEST_PENDING_PREFIX}${org}:${protocol}:${room}`;
}

/** Parse + validate the untrusted /start body. Returns the room + inbound descriptor or an error string.
 *  `room` is required + path-safe; `inbound` fields are typed-narrowed (host/port/path/streakKey) — anything
 *  unrecognized is dropped (validate-before-sink). NEVER reads org/meter from the body (server-side only). */
export function parseIngestStartBody(
  raw: unknown,
): { room: string; inbound: IngestInbound } | { error: string } {
  const b = (raw ?? {}) as Record<string, unknown>;
  const room = typeof b.room === "string" ? b.room : typeof b.streamKey === "string" ? b.streamKey : "";
  if (!room || !SAFE_ROOM.test(room)) return { error: "ingest session requires a path-safe room or streamKey" };
  const src = (b.inbound ?? {}) as Record<string, unknown>;
  const inbound: IngestInbound = {};
  if (typeof src.host === "string") inbound.host = src.host;
  if (typeof src.port === "number" && Number.isFinite(src.port)) inbound.port = src.port;
  if (typeof src.path === "string") inbound.path = src.path;
  if (typeof src.streamKey === "string") inbound.streamKey = src.streamKey;
  return { room, inbound };
}

/**
 * Handle one Plane-2 ingest control action (contract §3). `action` is "start" (gateway POST .../session) or
 * "stop" (gateway DELETE .../session/{room}). Org is the gateway-stamped, server-side org (invariant #1) — the
 * caller has already gatewayGate'd + validated it. On "start" we build the full /start payload (protocol +
 * inbound + whipEndpoint + bridgeKeyRef + room + meter) and dispatch the container; a transient failure enqueues
 * a durable pending record for the every-15-min cron and still 200s (fail-open behind the accepted control call, like
 * Plane-1's signed-ack). A binding-absent fail-closes to a typed 501 (NOT a pending-requeue — an absent binding
 * is a config gap the cron can't fix). On "stop" we tear the leg down idempotently.
 */
export async function handleIngestBridge(
  action: "start" | "stop",
  protocol: IngestProtocol,
  org: string,
  body: unknown,
  whipEndpoint: string,
  bridgeKeyRef: string,
  deps: IngestBridgeDeps,
): Promise<Response> {
  const base = { protocol, org };

  if (action === "stop") {
    const room = typeof (body as { room?: unknown })?.room === "string" ? (body as { room: string }).room : "";
    if (!room || !SAFE_ROOM.test(room)) {
      return jsonResponse({ error: "BAD_REQUEST", message: "ingest stop requires a path-safe room" }, 400);
    }
    try {
      await deps.dispatchStop(org, protocol, room);
      await deps.clearPending?.(org, protocol, room).catch(() => {});
      return jsonResponse({ ok: true, action, protocol, room }, 200);
    } catch (err) {
      if (isNotActivated(err)) return notActivated(protocol);
      deps.log?.("ingest-bridge-stop-failed", { ...base, room, error: String(err) });
      // A stop is best-effort teardown — clear the pending so the cron does not keep re-dispatching a dead leg.
      await deps.clearPending?.(org, protocol, room).catch(() => {});
      return jsonResponse({ ok: true, action, protocol, room, note: "stop-best-effort" }, 200);
    }
  }

  // action === "start"
  const parsed = parseIngestStartBody(body);
  if ("error" in parsed) return jsonResponse({ error: "BAD_REQUEST", message: parsed.error }, 400);
  const room = ingestRoomFor(protocol, parsed.room);
  const payload: IngestStartPayload = {
    protocol,
    inbound: parsed.inbound,
    whipEndpoint,
    bridgeKeyRef,
    room,
    meter: METER_STREAM_BRIDGE_MINUTES,
  };
  try {
    await deps.dispatchStart(org, payload);
    await deps.clearPending?.(org, protocol, room).catch(() => {});
    return jsonResponse({ ok: true, action, protocol, room }, 201);
  } catch (err) {
    if (isNotActivated(err)) {
      // Binding absent → honest fail-closed 501. NOT requeued (a config gap is not a transient failure).
      deps.log?.("ingest-bridge-not-activated", { ...base, room });
      return notActivated(protocol);
    }
    // Transient container-start failure → durable pending record for the cron reconcile; accept the control call.
    deps.log?.("ingest-bridge-start-failed", { ...base, room, error: String(err) });
    await deps.markPending?.(payload, org).catch(() => {});
    return jsonResponse({ ok: true, action, protocol, room, pending: true }, 202);
  }
}

/** Sentinel error a dispatch throws when the per-protocol container binding is absent → fail-closed 501. */
export class BridgeNotActivatedError extends Error {
  constructor(public readonly protocol: IngestProtocol) {
    super(`${protocol} ingest bridge binding absent (inert until ◆ go-live)`);
    this.name = "BridgeNotActivatedError";
  }
}
function isNotActivated(err: unknown): err is BridgeNotActivatedError {
  return err instanceof BridgeNotActivatedError;
}
/** The typed honest-501 (contract §3): `<PROTO>_BRIDGE_NOT_ACTIVATED`, no fake transport, no silent success. */
function notActivated(protocol: IngestProtocol): Response {
  return jsonResponse(
    { error: `${protocol.toUpperCase()}_BRIDGE_NOT_ACTIVATED`, message: `${protocol} ingest bridge is not activated` },
    501,
  );
}

/** A durable pending-start record (JSON value at the pending key). Carries the full /start payload to replay. */
interface PendingIngest {
  org: string;
  payload: IngestStartPayload;
  attempts: number;
}

/**
 * Cron reconcile backstop (scheduled()): re-dispatch every pending-start record a control-call start failed on
 * transiently. Mirrors `reconcileStreamPending`. The control call returns 202 once and never re-delivers — so
 * without this a transient container-start failure would leave the contribution un-bridged. For each pending
 * record we re-issue dispatchStart with the SAME payload (idempotent: a duplicate joins the same deterministic
 * SFU room). On success we clear it; on a still-failing/binding-absent start we bump attempts and give up
 * loudly after the max. Best-effort — never throws out of scheduled().
 */
export async function reconcileIngestPending(
  kv: KVNamespace,
  deps: Pick<IngestBridgeDeps, "dispatchStart" | "log">,
  log?: (msg: string, fields: Record<string, unknown>) => void,
): Promise<void> {
  const emit = log ?? deps.log;
  let cursor: string | undefined;
  do {
    const page = await kv.list({ prefix: INGEST_PENDING_PREFIX, cursor });
    cursor = page.list_complete ? undefined : page.cursor;
    for (const k of page.keys) {
      const raw = await kv.get(k.name);
      if (!raw) continue; // expired between list and get
      let rec: PendingIngest;
      try {
        rec = JSON.parse(raw) as PendingIngest;
      } catch {
        await kv.delete(k.name); // corrupt → drop
        continue;
      }
      if (!rec?.org || !rec?.payload?.protocol || !rec?.payload?.room) {
        await kv.delete(k.name);
        continue;
      }
      let ok = false;
      try {
        await deps.dispatchStart(rec.org, rec.payload);
        ok = true;
      } catch (err) {
        emit?.("ingest-bridge-reconcile-error", {
          org: rec.org,
          protocol: rec.payload.protocol,
          room: rec.payload.room,
          error: String(err),
        });
      }
      if (ok) {
        await kv.delete(k.name);
        emit?.("ingest-bridge-reconciled", { org: rec.org, protocol: rec.payload.protocol, room: rec.payload.room });
      } else {
        const attempts = (Number(rec.attempts) || 0) + 1;
        if (attempts >= MAX_INGEST_DISPATCH_ATTEMPTS) {
          await kv.delete(k.name);
          emit?.("ingest-bridge-reconcile-giveup", {
            org: rec.org,
            protocol: rec.payload.protocol,
            room: rec.payload.room,
            attempts,
          });
        } else {
          await kv.put(k.name, JSON.stringify({ ...rec, attempts }), { expirationTtl: INGEST_PENDING_TTL_SECONDS });
        }
      }
    }
  } while (cursor);
}

// ── Live runtime wiring (kept HERE so worker.ts only DELEGATES — never builds deps inline; file-size budget). ──

/** Minimal DO-namespace shape (a per-protocol container binding) — avoids a hard cloudflare:workers import. */
interface ContainerNamespace {
  idFromName(name: string): unknown;
  get(id: unknown): { fetch(request: Request): Promise<Response> };
}

/** The worker Env subset the live wiring needs: the flag + per-protocol container bindings + KV + the WHIP
 *  publish endpoint the container republishes to + the bridge key REF. All container bindings stay COMMENTED in
 *  wrangler.toml until each per-leg ◆ go-live → absent → fail-closed 501 (never a fake transport). */
export interface IngestBridgeRuntimeEnv {
  INGEST_BRIDGE_ENABLED?: string | boolean;
  SRT_BRIDGE?: ContainerNamespace;
  RIST_BRIDGE?: ContainerNamespace;
  RTMPS_BRIDGE?: ContainerNamespace;
  MOQ_BRIDGE?: ContainerNamespace;
  RT_MEETING_ORG?: KVNamespace; // reused KV (ingest-bridge-pending: prefix)
  /** The gateway WHIP publish endpoint the container republishes the re-encoded feed to (public, non-secret).
   *  Default: the canonical `${GATEWAY_BASE_URL}/v1/whip/publish`. */
  INGEST_WHIP_ENDPOINT?: string;
  GATEWAY_BASE_URL?: string;
  /** The bridge wk_ key REF (a container-side binding/secret NAME the container resolves env-side) — NEVER the
   *  key material. Default: "WHIP_KEY" (matches the stream-bridge container's env var name). */
  INGEST_BRIDGE_KEY_REF?: string;
}

/** Minimal waitUntil-carrier (ExecutionContext satisfies it) so this module needs no worker-runtime import. */
interface WaitUntilCtx {
  waitUntil(p: Promise<unknown>): void;
}

/** Resolve the per-protocol container binding from the env (absent → null → fail-closed). */
function bindingFor(env: IngestBridgeRuntimeEnv, protocol: IngestProtocol): ContainerNamespace | undefined {
  return env[BRIDGE_BINDING[protocol] as keyof IngestBridgeRuntimeEnv] as ContainerNamespace | undefined;
}

/** The gateway WHIP publish endpoint the container republishes to (explicit override, else GATEWAY_BASE_URL). */
export function whipEndpointFor(env: IngestBridgeRuntimeEnv): string {
  if (env.INGEST_WHIP_ENDPOINT) return env.INGEST_WHIP_ENDPOINT;
  const base = (env.GATEWAY_BASE_URL ?? "https://api.wave.online").replace(/\/+$/, "");
  return `${base}/v1/whip/publish`;
}

/**
 * Live container dispatch: reach the per-protocol container by the deterministic `${org}:${room}` DO id and POST
 * a control /start (text payload). Binding COMMENTED until each leg's ◆ go-live → absent → THROWS
 * BridgeNotActivatedError (handler → typed 501). Shared by the control route and the cron reconcile.
 */
export async function liveIngestDispatchStart(
  env: IngestBridgeRuntimeEnv,
  org: string,
  payload: IngestStartPayload,
): Promise<void> {
  const ns = bindingFor(env, payload.protocol);
  if (!ns) throw new BridgeNotActivatedError(payload.protocol);
  const stub = ns.get(ns.idFromName(`${org}:${payload.room}`));
  const res = await stub.fetch(
    new Request("https://ingest-bridge/start", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    }),
  );
  if (!res.ok) throw new Error(`${payload.protocol} ingest container /start → ${res.status}`);
}

/** Build the live IngestBridgeDeps (container start/stop; KV pending). */
export function liveIngestBridgeDeps(env: IngestBridgeRuntimeEnv): IngestBridgeDeps {
  const kv = env.RT_MEETING_ORG;
  const log = (msg: string, fields: Record<string, unknown>) => console.log(JSON.stringify({ msg, ...fields }));
  return {
    dispatchStart: (org, payload) => liveIngestDispatchStart(env, org, payload),
    dispatchStop: async (org, protocol, room) => {
      const ns = bindingFor(env, protocol);
      if (!ns) throw new BridgeNotActivatedError(protocol);
      const stub = ns.get(ns.idFromName(`${org}:${ingestRoomFor(protocol, room)}`));
      await stub.fetch(new Request("https://ingest-bridge/stop", { method: "POST" }));
    },
    log,
    markPending: async (payload, org) => {
      if (kv)
        await kv.put(
          pendingKey(org, payload.protocol, payload.room),
          JSON.stringify({ org, payload, attempts: 0 } satisfies PendingIngest),
          { expirationTtl: INGEST_PENDING_TTL_SECONDS },
        );
    },
    clearPending: async (org, protocol, room) => {
      if (kv) await kv.delete(pendingKey(org, protocol, room));
    },
  };
}

/** Route shapes (contract §3): POST /v1/ingest/{proto}/session ; DELETE /v1/ingest/{proto}/session/{room}. */
const INGEST_SESSION_ROUTE = /^\/v1\/ingest\/([a-z]+)\/session$/;
const INGEST_SESSION_STOP_ROUTE = /^\/v1\/ingest\/([a-z]+)\/session\/([A-Za-z0-9_:.-]{1,128})$/;

/**
 * Route delegate for worker.ts: if this is an (enabled) Plane-2 ingest control call, gateway-gate it, resolve
 * the protocol + server-side org, and dispatch. Otherwise return null so the worker falls through (501 catch-all
 * when inert). The caller passes its own gatewayGate so the trust check stays in one place. One call site, zero
 * deps-building in worker.ts.
 *
 * @param gate the worker's gatewayGate (returns a 4xx Response when the x-wave-internal seal is missing/wrong, else null).
 */
export async function maybeHandleIngestBridge(
  request: Request,
  env: IngestBridgeRuntimeEnv & { WAVE_INTERNAL_SECRET?: string },
  gate: (request: Request, secret: string | undefined) => Response | null,
  safeOrg: RegExp,
): Promise<Response | null> {
  if (!ingestBridgeEnabled(env)) return null;
  const url = new URL(request.url);
  const startM = request.method === "POST" ? url.pathname.match(INGEST_SESSION_ROUTE) : null;
  const stopM = request.method === "DELETE" ? url.pathname.match(INGEST_SESSION_STOP_ROUTE) : null;
  if (!startM && !stopM) return null;

  const protoStr = (startM ?? stopM)![1];
  const protocol = asIngestProtocol(protoStr);
  if (!protocol) {
    return new Response(
      JSON.stringify({ error: "BAD_REQUEST", message: `unsupported ingest protocol "${protoStr}"` }),
      { status: 400, headers: { "content-type": "application/json" } },
    );
  }

  // Gateway-trust chokepoint — identical to every other paid /v1/* route (contract §3, frozen invariant #1).
  const denied = gate(request, env.WAVE_INTERNAL_SECRET);
  if (denied) return denied;
  const org = request.headers.get("x-wave-org") ?? "";
  if (!safeOrg.test(org)) {
    return new Response(
      JSON.stringify({ error: "BAD_REQUEST", message: "missing or malformed org context (x-wave-org) — stamped by the gateway" }),
      { status: 400, headers: { "content-type": "application/json" } },
    );
  }

  const deps = liveIngestBridgeDeps(env);
  if (stopM) {
    return handleIngestBridge("stop", protocol, org, { room: stopM[2] }, "", "", deps);
  }
  let body: unknown = {};
  try {
    body = await request.json();
  } catch {
    body = {};
  }
  return handleIngestBridge(
    "start",
    protocol,
    org,
    body,
    whipEndpointFor(env),
    env.INGEST_BRIDGE_KEY_REF ?? "WHIP_KEY",
    deps,
  );
}

/** Cron delegate for worker.ts scheduled(): re-dispatch any pending ingest start (INERT unless enabled + KV). */
export function scheduledIngestReconcile(env: IngestBridgeRuntimeEnv, ctx: WaitUntilCtx): void {
  if (!ingestBridgeEnabled(env) || !env.RT_MEETING_ORG) return;
  ctx.waitUntil(
    reconcileIngestPending(
      env.RT_MEETING_ORG,
      { dispatchStart: (org, payload) => liveIngestDispatchStart(env, org, payload) },
      (msg, fields) => console.log(JSON.stringify({ msg, ...fields })),
    ),
  );
}
