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
  MoqTrackSink,
  type RtmsBridgeDeps,
  type RtmsSocket,
  type BridgeTarget,
  type ParticipantSink,
  type MoqForwardWriter,
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
import { createMoqForwardTarget, type MoqForwardTargetEnv } from "./encoders/moq-forward-target.js";
import { SAFE_SEGMENT, ZOOM_RTMS_INGEST_ROUTE } from "./dispatch-helpers.js";

/** Env the ZoomRtmsBridgeDO reads. INERT unless WAVE_ZOOM_RTMS is truthy. All creds referenced, not valued. */
export interface ZoomRtmsBridgeDoEnv extends MoqForwardTargetEnv {
  WAVE_ZOOM_RTMS?: string | boolean; // truthy arms; absent/"0"/false → fully inert
  // #88 M2 — independent flag for the VIDEO ingest leg (RTMS video frame → SFU video track push), still
  // gated by WAVE_ZOOM_RTMS being on too. Absent/"0"/false → audio-only, byte-identical to pre-video. The
  // DO does not yet mint a video target or accept a live video-ingest-sink socket (◆ follow-up slice) —
  // this only threads the flag into RtmsBridgeCore so its handshake/pump wiring is exercised.
  WAVE_RTMS_VIDEO?: string | boolean;
  // #RTMS-fanout — independent flag for the per-participant demux + multi-protocol sink fan-out
  // (RtmsBridgeCore's perParticipantEnabled), still gated by WAVE_ZOOM_RTMS being on too. Absent/"0"/false
  // → audio/video stay on the single mixed track, byte-identical to today. The DO does not yet wire a real
  // `sinks()` implementation (minting a per-participant CF-SFU track, or a MoQ/NDI forwarder) — that's a ◆
  // follow-up slice; this only threads the flag into RtmsBridgeCore so its demux/fan-out wiring is exercised.
  WAVE_RTMS_PER_PARTICIPANT?: string | boolean;
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

/** Truthy-flag check for the video ingest leg (mirrors zoomRtmsEnabled's pattern). */
export function rtmsVideoEnabled(env: { WAVE_RTMS_VIDEO?: string | boolean }): boolean {
  const v = env.WAVE_RTMS_VIDEO;
  return v === true || v === "1" || v === "true";
}

/** Truthy-flag check for the per-participant demux + sink fan-out (mirrors zoomRtmsEnabled's pattern). */
export function rtmsPerParticipantEnabled(env: { WAVE_RTMS_PER_PARTICIPANT?: string | boolean }): boolean {
  const v = env.WAVE_RTMS_PER_PARTICIPANT;
  return v === true || v === "1" || v === "true";
}

/** #RTMS-fanout — allowlist for a Zoom RTMS userId before it drives a per-participant track name/map-key.
 *  Mirrors rtms-bridge-core.ts's private SAFE_RTMS_USER_ID exactly (Corridor guardrail: re-check at every
 *  boundary that turns an untrusted value into a resource name — the DO receives an already-sanitized id
 *  from core's `sinks(userId)` call, but this is defense-in-depth, never trust-the-caller). */
const SAFE_RTMS_USER_ID = /^[A-Za-z0-9_-]{1,64}$/;

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
  // #RTMS-fanout WAVE_RTMS_PER_PARTICIPANT — per-track state, only ever populated when the flag is on
  // (buildDeps().sinks() is the sole writer). Flag off ⇒ these stay empty and `ingest` above is the
  // only slot in play — byte-identical to pre-fanout behavior.
  private meetingUuid: string | null = null; // set once startBridge resolves a target
  private resolvedOrg: string | null = null; // set once resolveTarget validates the KV record
  private target: BridgeTarget | null = null; // set once startBridge resolves a target
  private readonly ingestByTrack = new Map<string, IngestSocket>(); // trackName -> the SFU's inbound socket
  private readonly requestedParticipantTracks = new Set<string>(); // trackName -> createIngest already fired
  // #314 Slice 1 — the ONE persistent multiplexed MoQ-container WS for this meeting (lazily built, shared by
  // every participant's MoqTrackSink). `undefined` = not yet resolved; `null` = resolved inert (flag off, no
  // MOQ_PUBLISH binding, or invalid org/meetingUuid); an object = the live forwarder. See getMoqTarget().
  private moqTarget: MoqForwardWriter | null | undefined = undefined;

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
      // #RTMS-fanout: when the SFU dials back a PER-PARTICIPANT track (path carries the 4-segment
      // ZOOM_RTMS_INGEST_ROUTE shape — see maybeHandleZoomRtmsIngest's forward, which now preserves the
      // path instead of collapsing it to a bare "/ingest"), route that socket into ingestByTrack keyed by
      // the track segment. A bare "/ingest" dial (today's single-track path, and every existing test) has
      // no match here → trackName stays null → the legacy `this.ingest` slot, byte-identical to before.
      const m = new URL(request.url).pathname.match(ZOOM_RTMS_INGEST_ROUTE);
      const trackName = m ? m[4] : null;
      return this.acceptIngest(trackName);
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

  /**
   * Accept the SFU's ingest WS upgrade and hold the server socket as the PCM sink (mirrors AgentSessionDO).
   * `trackName` is null for the legacy single-track dial (or when it matches the mixed target's own track
   * name) → held in `this.ingest`; any OTHER track name (a per-participant track minted by `sinks()`) is
   * held in `ingestByTrack` keyed by that name instead. Both slots use the identical accept/sink/cleanup
   * shape — only WHERE the socket is stored differs.
   */
  private acceptIngest(trackName: string | null): Response {
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
    const isMixed = !trackName || trackName === this.target?.trackName;
    let clear: () => void;
    if (isMixed) {
      this.ingest = sink;
      clear = (): void => {
        if (this.ingest === sink) this.ingest = null;
      };
    } else {
      this.ingestByTrack.set(trackName, sink);
      clear = (): void => {
        if (this.ingestByTrack.get(trackName) === sink) this.ingestByTrack.delete(trackName);
      };
    }
    server.addEventListener("close", clear);
    server.addEventListener("error", clear);
    console.log(JSON.stringify({ msg: "zoom-rtms-ingest-open", trackName: trackName ?? "(mixed)" }));
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
    // #RTMS-fanout — stash so buildDeps().sinks()/ensureParticipantTrack can mint a per-user track/endpoint
    // later, lazily, without re-resolving the KV mapping per participant.
    this.meetingUuid = event.meetingUuid;
    this.target = target;
    this.core = new RtmsBridgeCore(this.buildDeps(target), {
      clientId: this.env.ZOOM_APPS_CLIENT_ID,
      clientSecret: this.env.ZOOM_APPS_CLIENT_SECRET,
      target,
      framing: this.env.AGENT_INGEST_FRAMING,
      videoEnabled: rtmsVideoEnabled(this.env),
      perParticipantEnabled: rtmsPerParticipantEnabled(this.env),
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
    this.resolvedOrg = rec.org; // #RTMS-fanout — needed later to mint per-participant endpoints
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
      // #RTMS-fanout WAVE_RTMS_PER_PARTICIPANT — always wired (core only calls it when perParticipantEnabled
      // AND a valid userId was parsed, per rtms-bridge-core.ts); flag off ⇒ never invoked, inert.
      sinks: (userId) => this.buildParticipantSinks(userId),
      now: () => Date.now(),
      log: (msg, fields) => console.log(JSON.stringify({ msg, ...fields })),
    };
  }

  /**
   * #RTMS-fanout — RtmsBridgeDeps.sinks(userId): called by core ONCE per newly-seen (sanitized) participant,
   * SYNCHRONOUSLY (the result is cached in core's participants map). Since minting a real SFU ingest track
   * is async (an HTTP round-trip), this returns a sink IMMEDIATELY that lazily re-reads `ingestByTrack` on
   * every audio()/video() call — exactly the same "drop until the socket connects" contract the mixed path
   * already has via `deps.ingestSocket()`. The async createIngest kick-off is fired here (best-effort,
   * logged on failure, never thrown into core's synchronous call).
   *
   * ◆ LIVE-INFRA-GATED: the SFU actually dialing BACK the per-participant endpoint (the other half of the
   * round-trip — see acceptIngest's per-track routing) is proven here only via an INJECTED upgrade request
   * in tests; the real CF Realtime SFU behavior for N concurrent inbound dials on one DO is unverified
   * against live infra (same class of gap the module header already documents for the outbound Zoom dial).
   */
  private buildParticipantSinks(userId: string | null): ParticipantSink[] {
    if (!userId || !SAFE_RTMS_USER_ID.test(userId) || !this.target || !this.meetingUuid) return [];
    const trackName = `zoom-${this.meetingUuid}-${userId}`;
    this.ensureParticipantTrack(trackName).catch((e) => {
      console.log(JSON.stringify({ msg: "zoom-rtms-participant-track-error", trackName, message: (e as Error)?.message ?? "unknown" }));
    });
    const self = this;
    const sink: ParticipantSink = {
      audio(frame: Uint8Array): void {
        self.ingestByTrack.get(trackName)?.send(frame);
      },
      video(frame: Uint8Array): void {
        self.ingestByTrack.get(trackName)?.send(frame);
      },
      close(): void {
        self.ingestByTrack.get(trackName)?.close?.();
        self.ingestByTrack.delete(trackName);
        self.requestedParticipantTracks.delete(trackName);
      },
    };
    const sinks: ParticipantSink[] = [sink];
    // #314 Slice 1 — an ADDITIONAL container-egress sink, on top of (never instead of) the SFU-track sink
    // above. Only ever added when getMoqTarget() resolves live (flag on AND MOQ_PUBLISH bound AND a valid
    // namespace) — otherwise this is a no-op and `sinks` stays exactly the single-entry array it is today.
    const moq = this.getMoqTarget();
    if (moq) sinks.push(new MoqTrackSink((msg, fields) => console.log(JSON.stringify({ msg, ...fields })), userId, moq));
    return sinks;
  }

  /**
   * #314 Slice 1 — lazily resolve (once per DO instance) the ONE MoqForwardWriter every participant's
   * MoqTrackSink shares for this meeting. Resolves to `null` (cached, never retried) when
   * WAVE_RTMS_PER_PARTICIPANT is off, MOQ_PUBLISH is unbound, or org/meetingUuid haven't been resolved yet
   * (resolveTarget hasn't run) — INERT by default: with no `[[containers]] MOQ_PUBLISH` binding provisioned,
   * this always returns null and MoqTrackSink stays the log-only stub it was before #314.
   */
  private getMoqTarget(): MoqForwardWriter | null {
    if (this.moqTarget !== undefined) return this.moqTarget;
    if (!rtmsPerParticipantEnabled(this.env) || !this.env.MOQ_PUBLISH || !this.resolvedOrg || !this.meetingUuid) {
      this.moqTarget = null;
      return null;
    }
    this.moqTarget = createMoqForwardTarget(this.env, this.resolvedOrg, this.meetingUuid, (msg, fields) =>
      console.log(JSON.stringify({ msg, ...fields })),
    );
    return this.moqTarget;
  }

  /**
   * #RTMS-fanout — lazily mint the per-participant CF Realtime ingest adapter (mirrors resolveTarget's
   * endpoint-building for the mixed track, but keyed to `zoom-${meetingUuid}-${userId}`). Idempotent per
   * trackName (a Set guards against a duplicate createIngest call on every frame); a failure clears the
   * guard so the NEXT frame for that participant retries, rather than permanently wedging the participant.
   */
  private async ensureParticipantTrack(trackName: string): Promise<void> {
    if (this.requestedParticipantTracks.has(trackName)) return;
    this.requestedParticipantTracks.add(trackName);
    const target = this.target;
    if (!target || !this.meetingUuid || !this.resolvedOrg) return;
    try {
      const baseWss = (this.env.AGENT_PUBLIC_WSS ?? "wss://rt.wave.online").replace(/\/+$/, "");
      const secret = this.env.WAVE_INTERNAL_SECRET;
      const seg = (s: string): string => encodeURIComponent(s);
      const token = secret ? await mintRecorderToken(secret, this.resolvedOrg, target.sessionId, trackName) : "";
      const endpoint =
        `${baseWss}/zoom/rtms/ingest/${seg(this.meetingUuid)}/${seg(this.resolvedOrg)}/${seg(target.sessionId)}/${seg(trackName)}` +
        (token ? `?t=${seg(token)}` : "");
      const fetchImpl = this.env.__zoomFetch ?? fetch;
      await createIngestAdapter(
        { fetchImpl },
        {
          appId: target.appId,
          bearer: target.bearer,
          tracks: [{ location: "local", sessionId: target.sessionId, trackName, endpoint, inputCodec: "pcm", mode: "buffer" }],
        },
      );
      console.log(JSON.stringify({ msg: "zoom-rtms-participant-track-created", trackName }));
    } catch (e) {
      this.requestedParticipantTracks.delete(trackName); // allow a later frame to retry
      console.log(JSON.stringify({ msg: "zoom-rtms-participant-track-error", trackName, message: (e as Error)?.message ?? "unknown" }));
    }
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
  WAVE_ORG?: string;
  ZOOM_RTMS_BRIDGE?: DurableObjectNamespace;
  RT_MEETING_ORG?: { get(key: string, type: "json"): Promise<unknown>; put(key: string, value: string): Promise<void> };
}

/**
 * #314-unblock — idempotently populate RT_MEETING_ORG[meetingUuid] on a verified rtms_started webhook, so
 * resolveTarget() (which fails CLOSED to null on a missing/malformed record) has something to dial into.
 * NEVER clobbers an existing operator-provisioned mapping (only writes when absent). Never throws — a KV
 * hiccup here must not block the /start POST that follows; log a non-secret error and move on.
 */
async function populateMeetingOrg(env: ZoomRtmsDispatchEnv, meetingUuid: string): Promise<void> {
  const kv = env.RT_MEETING_ORG;
  if (!kv) return;
  try {
    const existing = await kv.get(meetingUuid, "json");
    if (existing) return; // never clobber an existing mapping
    const rawOrg = env.WAVE_ORG ?? "default";
    const org = SAFE_SEGMENT.test(rawOrg) ? rawOrg : "default";
    const safe = (s: string): string => `zoom-${s}`.replace(/[^A-Za-z0-9_:.-]/g, "").slice(0, 128);
    const sessionId = safe(meetingUuid);
    const trackName = safe(meetingUuid);
    await kv.put(meetingUuid, JSON.stringify({ org, sessionId, trackName }));
  } catch (e) {
    console.log(JSON.stringify({ msg: "zoom-rtms-meeting-org-populate-error", meetingUuid, message: (e as Error)?.message ?? "unknown" }));
  }
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
      await populateMeetingOrg(env, ev.meetingUuid);
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
  // #RTMS-fanout: keep the 4-segment path (not a bare "/ingest") so the DO can re-match ZOOM_RTMS_INGEST_ROUTE
  // and route this socket to the right per-participant track slot (see acceptIngest). The ?t= token was
  // already verified above — dropped here, it's not needed past this boundary.
  const forwardUrl = `https://zoom-rtms/zoom/rtms/ingest/${encodeURIComponent(zmid)}/${encodeURIComponent(zorg)}/${encodeURIComponent(zsession)}/${encodeURIComponent(ztrack)}`;
  return env.ZOOM_RTMS_BRIDGE.get(env.ZOOM_RTMS_BRIDGE.idFromName(zmid)).fetch(new Request(forwardUrl, request));
}
