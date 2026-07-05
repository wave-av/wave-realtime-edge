/// <reference types="@cloudflare/workers-types" />
/**
 * #88 M2 — ZoomRtmsBridgeDO: the Durable-Object host for the Zoom RTMS → WAVE media bridge.
 *
 * The webhook control plane (zoom-rtms-bridge.ts) verifies a `meeting.rtms_started` and, when armed,
 * routes it to THIS DO (keyed `idFromName(meetingUuid)`). The DO owns the two live sockets a Workers
 * request can't hold across its lifetime:
 *   • OUTBOUND (net-new): dials Zoom's signaling + media WS legs via `fetch(url,{Upgrade:websocket})`
 *     → `resp.webSocket.accept()` and drives RtmsBridgeCore's state machine over them.
 *   • INBOUND (proven, mirrors AgentSessionDO): the CF Realtime SFU dials our `/zoom/rtms/ingest`
 *     route (forwarded here) to PULL the transcoded PCM; the DO holds that server socket as the sink
 *     RtmsBridgeCore.pumpAudio sends `encodeIngestFrame` frames on.
 *
 * ── INERT ───────────────────────────────────────────────────────────────────────────────────────
 * Nothing runs unless `WAVE_ZOOM_RTMS` is truthy AND a meeting→room mapping exists in RT_MEETING_ORG
 * AND ZOOM_APPS_* creds are provisioned. Off (the default) → fetch() 501s and the webhook seam is a
 * no-op, so this DO is never entered. Arming (`WAVE_ZOOM_RTMS=1` + the secrets + a meeting mapping)
 * is a ◆ Jake-named crossing; the class export here only resolves the wrangler binding so the
 * migration can deploy. The meeting→room binding is an HONEST resolver seam: unmapped → fail-closed
 * (logged, no dial), never a fabricated target.
 *
 * ── PROVEN vs LIVE-SPIKE ────────────────────────────────────────────────────────────────────────
 * The DO's control paths (INERT 501 gate, ingest WS upgrade, start→core, stop→teardown, fail-closed
 * resolver) are unit-tested with an injected fetch + a stubbed WebSocketPair. The real outbound dial
 * to Zoom's servers + the real SFU pull are the ◆ live-meeting gap (same class AgentSessionDO flags).
 */
import {
  RtmsBridgeCore,
  type RtmsBridgeDeps,
  type RtmsSocket,
  type BridgeTarget,
} from "./rtms-bridge-core.js";
import {
  zoomRtmsEnabled,
  type RtmsStartedEvent,
  type OnRtmsStarted,
  type OnRtmsStopped,
} from "./zoom-rtms-bridge.js";
import { createIngestAdapter, type IngestFraming } from "./agent-ingest-adapter.js";
import type { IngestSocket } from "./agent-session.js";
import { mintRecorderToken, verifyRecorderToken } from "./encoders/recorder-auth.js";
import { SAFE_SEGMENT, ZOOM_RTMS_INGEST_ROUTE } from "./dispatch-helpers.js";

/** Env the ZoomRtmsBridgeDO reads. INERT unless WAVE_ZOOM_RTMS is truthy. All creds referenced, not valued. */
export interface ZoomRtmsBridgeDoEnv {
  WAVE_ZOOM_RTMS?: string | boolean; // truthy arms; absent/"0"/false → fully inert
  ZOOM_APPS_CLIENT_ID?: string; // General-app Client ID — the RTMS handshake clientId (fails closed if unset)
  ZOOM_APPS_CLIENT_SECRET?: string; // signs the RTMS handshake — never logged/returned
  CF_CALLS_APP_ID?: string; // CF Realtime SFU app id (createIngestAdapter) — unset → fails closed
  CF_CALLS_APP_SECRET?: string; // CF Realtime SFU app bearer — never logged/returned
  WAVE_INTERNAL_SECRET?: string; // capability-token key for the SFU's ingest dial-in
  AGENT_PUBLIC_WSS?: string; // our public wss base the SFU dials back to (default rt.wave.online)
  AGENT_INGEST_FRAMING?: IngestFraming; // "packet" (default) | "raw" (a live spike may select)
  RT_MEETING_ORG?: KVNamespace; // meeting_uuid → {org, sessionId, trackName?} publish-target mapping
  __zoomFetch?: typeof fetch; // test-only: injected fetch for the outbound dial + adapter create
}

/** The publish-target record stored in RT_MEETING_ORG under the meeting_uuid key. */
interface MeetingTargetRecord {
  org: string;
  sessionId: string;
  trackName?: string;
}

// DO runtime shape (avoid a hard cloudflare:workers dep in this skeleton; mirrors agent-session.ts/room.ts).
interface DurableObjectStateLike {
  storage: { get<T>(key: string): Promise<T | undefined>; put<T>(key: string, value: T): Promise<void> };
}

/**
 * ZoomRtmsBridgeDO — one instance per Zoom meeting (idFromName(meetingUuid)). Holds one RtmsBridgeCore
 * and the SFU-facing ingest socket. Control-plane fetch(): the SFU's ingest WS upgrade, an internal
 * `/start` (from the verified webhook seam), and `/stop` (teardown on rtms_stopped or leg close).
 */
export class ZoomRtmsBridgeDO {
  private readonly env: ZoomRtmsBridgeDoEnv;
  private core: RtmsBridgeCore | null = null;
  private ingest: IngestSocket | null = null;

  constructor(_state: DurableObjectStateLike, env?: ZoomRtmsBridgeDoEnv) {
    this.env = env ?? {};
  }

  async fetch(request: Request): Promise<Response> {
    if (!zoomRtmsEnabled(this.env)) {
      // INERT: not armed → do nothing (config-no-silent-noop: honest 501, not a fake ok).
      return Response.json({ error: "ZOOM_RTMS_NOT_ENABLED", message: "WAVE_ZOOM_RTMS is off" }, { status: 501 });
    }
    // The SFU dials IN (WebSocket upgrade) to PULL our published PCM — perform the upgrade HERE so THIS
    // DO owns the live socket RtmsBridgeCore.pumpAudio sends on (mirrors AgentSessionDO's ingest leg).
    if ((request.headers.get("Upgrade") ?? "").toLowerCase() === "websocket") {
      return this.acceptIngest();
    }
    const path = new URL(request.url).pathname.replace(/^\/+/, "");
    try {
      if (path === "start" && request.method === "POST") {
        const body = (await request.json().catch(() => ({}))) as { event?: RtmsStartedEvent };
        if (!body.event || body.event.kind !== "rtms_started") {
          return Response.json({ error: "BAD_REQUEST", message: "start requires a verified rtms_started event" }, { status: 400 });
        }
        const started = await this.startBridge(body.event);
        return Response.json({ ok: true, started }, { status: 200 });
      }
      if (path === "stop" && request.method === "POST") {
        this.core?.stop();
        this.core = null;
        return Response.json({ ok: true, stopped: true }, { status: 200 });
      }
      return Response.json({ error: "BAD_REQUEST", message: `unknown zoom-rtms intent: ${path}` }, { status: 400 });
    } catch (e) {
      return Response.json({ error: "ZOOM_RTMS_DO_ERROR", message: (e as Error)?.message ?? "unexpected error" }, { status: 500 });
    }
  }

  /** Accept the SFU's ingest WS upgrade and hold the server socket as the PCM sink (mirrors AgentSessionDO). */
  private acceptIngest(): Response {
    const WSP = (globalThis as unknown as { WebSocketPair?: new () => Record<string, WebSocket> }).WebSocketPair;
    if (!WSP) {
      return Response.json({ error: "REALTIME_NOT_CONFIGURED", message: "WebSocketPair unavailable" }, { status: 503 });
    }
    const pair = new WSP();
    const client = (pair as unknown as Record<string, WebSocket>)[0];
    const server = (pair as unknown as Record<string, WebSocket>)[1];
    server.accept();
    try {
      (server as unknown as { binaryType?: string }).binaryType = "arraybuffer";
    } catch {
      /* binaryType not settable on some runtimes — we only SEND on this socket, so it's non-fatal */
    }
    const sink: IngestSocket = {
      send: (d) => server.send(d),
      close: () => {
        try {
          server.close();
        } catch {
          /* best-effort */
        }
      },
    };
    this.ingest = sink;
    const clear = (): void => {
      if (this.ingest === sink) this.ingest = null;
    };
    server.addEventListener("close", clear);
    server.addEventListener("error", clear);
    console.log(JSON.stringify({ msg: "zoom-rtms-ingest-open" }));
    try {
      return new Response(null, { status: 101, webSocket: client } as ResponseInit & { webSocket: WebSocket });
    } catch {
      return new Response(null, { status: 200, webSocket: client } as ResponseInit & { webSocket: WebSocket });
    }
  }

  /**
   * Resolve the publish target + creds and start the bridge. Fail-CLOSED and honest (config-no-silent-noop):
   * an unmapped meeting or unprovisioned ZOOM_APPS_* creds → log + return false (no dial), never a fabricated
   * target. Returns true only when the core was actually started.
   */
  private async startBridge(event: RtmsStartedEvent): Promise<boolean> {
    if (this.core?.isStarted) return true; // idempotent — one bridge per meeting DO
    if (!this.env.ZOOM_APPS_CLIENT_ID || !this.env.ZOOM_APPS_CLIENT_SECRET) {
      console.log(JSON.stringify({ msg: "zoom-rtms-not-armed", reason: "missing ZOOM_APPS_* creds", meetingUuid: event.meetingUuid }));
      return false;
    }
    const target = await this.resolveTarget(event.meetingUuid);
    if (!target) {
      console.log(JSON.stringify({ msg: "zoom-rtms-no-room-mapping", meetingUuid: event.meetingUuid }));
      return false;
    }
    this.core = new RtmsBridgeCore(this.buildDeps(target), {
      clientId: this.env.ZOOM_APPS_CLIENT_ID,
      clientSecret: this.env.ZOOM_APPS_CLIENT_SECRET,
      target,
      framing: this.env.AGENT_INGEST_FRAMING,
    });
    await this.core.start(event);
    return true;
  }

  /**
   * Meeting → wave-room publish target. Reads RT_MEETING_ORG[meetingUuid] = {org, sessionId, trackName?};
   * absent/malformed → null (fail-closed). Builds the SFU-facing ingest endpoint (a capability token bound
   * to org/session/track, verified by the /zoom/rtms/ingest route, exactly like the agent ingest path).
   */
  private async resolveTarget(meetingUuid: string): Promise<BridgeTarget | null> {
    const kv = this.env.RT_MEETING_ORG;
    if (!kv) return null;
    let rec: MeetingTargetRecord | null = null;
    try {
      rec = (await kv.get(meetingUuid, "json")) as MeetingTargetRecord | null;
    } catch {
      rec = null;
    }
    if (!rec || !SAFE_SEGMENT.test(rec.org ?? "") || !SAFE_SEGMENT.test(rec.sessionId ?? "")) return null;
    const trackName = rec.trackName && SAFE_SEGMENT.test(rec.trackName) ? rec.trackName : `zoom-${meetingUuid}`;
    if (!SAFE_SEGMENT.test(trackName)) return null;
    const baseWss = (this.env.AGENT_PUBLIC_WSS ?? "wss://rt.wave.online").replace(/\/+$/, "");
    const secret = this.env.WAVE_INTERNAL_SECRET;
    // Mint the capability token the SFU appends as ?t= (it can't send x-wave-internal), bound to the AGENT
    // track. Without WAVE_INTERNAL_SECRET the SFU dial-in 401s (fail-closed) — same as the agent ingest path.
    const token = secret ? await mintRecorderToken(secret, rec.org, rec.sessionId, trackName) : "";
    const seg = (s: string): string => encodeURIComponent(s);
    const endpoint =
      `${baseWss}/zoom/rtms/ingest/${seg(meetingUuid)}/${seg(rec.org)}/${seg(rec.sessionId)}/${seg(trackName)}` +
      (token ? `?t=${seg(token)}` : "");
    return { appId: this.env.CF_CALLS_APP_ID ?? "", bearer: this.env.CF_CALLS_APP_SECRET ?? "", sessionId: rec.sessionId, trackName, endpoint };
  }

  /** Live media deps: the outbound Zoom dial (fetch Upgrade), the SFU adapter create, the DO-held sink. */
  private buildDeps(target: BridgeTarget): RtmsBridgeDeps {
    const fetchImpl = this.env.__zoomFetch ?? fetch;
    return {
      connect: (url, onMessage, onClose) => this.connectZoomLeg(url, onMessage, onClose),
      createIngest: (tracks) => createIngestAdapter({ fetchImpl }, { appId: target.appId, bearer: target.bearer, tracks }),
      ingestSocket: () => this.ingest,
      now: () => Date.now(),
      log: (msg, fields) => console.log(JSON.stringify({ msg, ...fields })),
    };
  }

  /**
   * Dial ONE outbound Zoom RTMS leg: `fetch(url,{headers:{Upgrade:"websocket"}})` → `resp.webSocket.accept()`.
   * This is the net-new outbound-WebSocket idiom the repo had zero of before #88 — provable only against a
   * live Zoom server (the ◆ spike). RTMS frames are text JSON, so we relay `ev.data` as a string.
   */
  private async connectZoomLeg(
    url: string,
    onMessage: (text: string) => void,
    onClose?: () => void,
  ): Promise<RtmsSocket> {
    const fetchImpl = this.env.__zoomFetch ?? fetch;
    const resp = await fetchImpl(url, { headers: { Upgrade: "websocket" } });
    const ws = (resp as unknown as { webSocket?: WebSocket }).webSocket;
    if (!ws) throw new Error("zoom RTMS upgrade returned no webSocket");
    ws.accept();
    ws.addEventListener("message", (ev: MessageEvent) => {
      onMessage(typeof ev.data === "string" ? ev.data : "");
    });
    ws.addEventListener("close", () => onClose?.());
    ws.addEventListener("error", () => onClose?.());
    return {
      send: (d: string) => ws.send(d),
      close: () => {
        try {
          ws.close();
        } catch {
          /* best-effort */
        }
      },
    };
  }
}

// ── route-dispatch wiring (extracted here so route-dispatch.ts stays under the 800-line gate) ──────────────

/** Env slice the dispatch-side Zoom helpers read (a subset of the worker Env). */
interface ZoomRtmsDispatchEnv {
  WAVE_ZOOM_RTMS?: string | boolean;
  WAVE_INTERNAL_SECRET?: string;
  ZOOM_RTMS_BRIDGE?: DurableObjectNamespace;
}

/**
 * Build the webhook seams that route a verified rtms_started/stopped to the meeting-keyed ZoomRtmsBridgeDO.
 * When ZOOM_RTMS_BRIDGE is unbound, returns `{}` → maybeHandleZoomRtms uses its no-op defaults (verify+ack
 * only, still INERT). idFromName(meetingUuid) so the start, stop, and ingest-forward all resolve one DO.
 */
export function zoomRtmsSeams(env: ZoomRtmsDispatchEnv): { onRtmsStarted?: OnRtmsStarted; onRtmsStopped?: OnRtmsStopped } {
  const bridge = env.ZOOM_RTMS_BRIDGE;
  if (!bridge) return {};
  return {
    onRtmsStarted: async (ev): Promise<void> => {
      await bridge.get(bridge.idFromName(ev.meetingUuid)).fetch(new Request("https://zoom-rtms/start", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ event: ev }),
      }));
    },
    onRtmsStopped: async (ev): Promise<void> => {
      await bridge.get(bridge.idFromName(ev.meetingUuid)).fetch(new Request("https://zoom-rtms/stop", { method: "POST" }));
    },
  };
}

/**
 * The Zoom RTMS ingest WS: the CF Realtime SFU dials IN to PULL the bridged Zoom audio. Forward the upgrade to
 * the idFromName(meetingUuid) ZoomRtmsBridgeDO (the DO that started the bridge owns the sink socket). Symmetric
 * auth to the agent ingest route: the ?t= capability token (org/session/track), else the gateway-trust seal.
 * Returns null (fall-through, INERT) unless armed AND the path matches.
 */
export async function maybeHandleZoomRtmsIngest(
  request: Request,
  env: ZoomRtmsDispatchEnv,
  gatewayGate: (req: Request, secret?: string) => Response | null,
): Promise<Response | null> {
  if (!zoomRtmsEnabled(env)) return null;
  const url = new URL(request.url);
  const m = url.pathname.match(ZOOM_RTMS_INGEST_ROUTE);
  if (!m) return null;
  const [, zmid, zorg, zsession, ztrack] = m;
  if (![zmid, zorg, zsession, ztrack].every((s) => SAFE_SEGMENT.test(s)) || !env.ZOOM_RTMS_BRIDGE) {
    return Response.json({ error: "BAD_REQUEST", message: "invalid zoom rtms ingest path or no ZOOM_RTMS_BRIDGE binding" }, { status: 400 });
  }
  const tok = url.searchParams.get("t");
  const tokenOk = !!tok && !!env.WAVE_INTERNAL_SECRET && (await verifyRecorderToken(env.WAVE_INTERNAL_SECRET, zorg, zsession, ztrack, tok));
  if (!tokenOk) {
    const denied = gatewayGate(request, env.WAVE_INTERNAL_SECRET);
    if (denied) return denied;
  }
  if ((request.headers.get("Upgrade") ?? "").toLowerCase() !== "websocket") {
    return Response.json({ error: "UPGRADE_REQUIRED", message: "zoom rtms ingest route requires a WebSocket upgrade" }, { status: 426 });
  }
  // Preserve the Upgrade header + WS-upgrade intent across the stub boundary; relay the DO's 101 + client.
  return env.ZOOM_RTMS_BRIDGE.get(env.ZOOM_RTMS_BRIDGE.idFromName(zmid)).fetch(new Request("https://zoom-rtms/ingest", request));
}
