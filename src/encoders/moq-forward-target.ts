/// <reference types="@cloudflare/workers-types" />
/**
 * #314 Slice 1 — MoqForwardTarget: ONE persistent, multiplexed WebSocket per meeting from this Worker to a
 * MoQ-publish container — `getContainer(env.MOQ_PUBLISH, "${org}:${meetingUuid}").fetch(Upgrade:websocket)`
 * (the SAME getContainer().fetch() idiom CfContainerTarget/RecorderContainer already prove — see
 * recorder-target.ts/recorder-container.ts) — carrying EVERY participant's demuxed audio/video frames over
 * ONE socket (a small per-frame [kind,uid,ts,len] header multiplexes them) instead of minting one CF-SFU
 * ingest track per participant (the existing buildParticipantSinks() path in zoom-rtms-bridge-do.ts).
 *
 * INERT BY DEFAULT: `createMoqForwardTarget` returns null (no connect attempted, no container reached) unless
 * BOTH `env.MOQ_PUBLISH` is bound AND the caller-supplied org/meetingUuid pass the namespace allowlist. The
 * DO (zoom-rtms-bridge-do.ts) only calls this when WAVE_RTMS_PER_PARTICIPANT is ALSO on — see buildDeps().
 *
 * FAIL-OPEN (mirrors CfContainerTarget's contract in recorder-target.ts): every write is best-effort. Not yet
 * connected, socket not OPEN, backpressured (bufferedAmount over the ceiling), or any connect/send error →
 * the frame is dropped (logged), NEVER thrown — the RTMS pump must never break on a container hiccup.
 *
 * AUTH: reuses recorder-auth.ts's `mintRecorderToken` — the SAME HMAC-over-(org,scope,name,exp) capability
 * primitive the SFU ingest dial-in already authenticates with (rather than inventing a new scheme) — scoped to
 * (org, meetingUuid, "moq-publish") and attached as `?t=` on the upgrade URL, PLUS the existing gateway-trust
 * `x-wave-internal` header (dispatch-helpers.ts gatewayGate's seal) when WAVE_INTERNAL_SECRET is provisioned.
 * Either one lets the container refuse a publish attempt that doesn't hold WAVE_INTERNAL_SECRET, even if the
 * container id/namespace is guessed.
 */
import type { Container } from "@cloudflare/containers";
import { mintRecorderToken } from "./recorder-auth.js";
import type { MoqForwardWriter, MoqFrameKind } from "../rtms-bridge-core.js";

/** Only safe org/meetingUuid segments may be interpolated into the container id `${org}:${meetingUuid}`.
 *  ':' is EXCLUDED (mirrors ingest-bridge.ts's SAFE_ROOM) — the interpolation itself supplies the ONE
 *  namespace separator, so neither segment may inject a second one and collide two distinct
 *  orgs/meetings onto the same container id. */
const SAFE_MOQ_SEGMENT = /^[A-Za-z0-9_.-]{1,128}$/;

/** bufferedAmount ceiling (bytes) above which a frame is dropped rather than queued/blocked (fail-open —
 *  never let a slow container backpressure the RTMS pump). Generous for small audio/video frames. */
const MAX_BUFFERED_BYTES = 1_000_000;

type GetContainerImpl = (ns: DurableObjectNamespace<Container>, id: string) => Container;

/** The live default getContainer impl (mirrors recorder-target.ts's defaultGetContainer). */
export const defaultGetContainer: GetContainerImpl = (ns, id) => ns.get(ns.idFromName(id)) as unknown as Container;

/**
 * Frame one (uid, kind, ts, payload) tuple for the multiplexed socket:
 *   [kindByte:u8][uidLen:u8][uid ascii bytes][ts:u32BE][payloadLen:u32BE][payload bytes]
 * `uid` is expected already sanitized (SAFE_RTMS_USER_ID, <=64 chars) by the caller; this only defends
 * against an oversized/non-ascii uid by truncating to the u8 length ceiling (255 bytes) — never throws.
 */
export function encodeMoqFrame(uid: string, kind: MoqFrameKind, ts: number, payload: Uint8Array): Uint8Array {
  const uidBytes = new TextEncoder().encode(uid).slice(0, 255);
  const header = new Uint8Array(1 + 1 + uidBytes.length + 4 + 4);
  const view = new DataView(header.buffer);
  header[0] = kind === "video" ? 1 : 0;
  header[1] = uidBytes.length;
  header.set(uidBytes, 2);
  view.setUint32(2 + uidBytes.length, Math.max(0, Math.floor(ts)) >>> 0, false);
  view.setUint32(2 + uidBytes.length + 4, payload.length >>> 0, false);
  const out = new Uint8Array(header.length + payload.length);
  out.set(header, 0);
  out.set(payload, header.length);
  return out;
}

/** Env keys this seam reads. Optional — absence degrades to `createMoqForwardTarget` returning null. */
export interface MoqForwardTargetEnv {
  /** COMMENTED in wrangler.toml until the ◆ container attach (mirrors RECORDER's contract). */
  MOQ_PUBLISH?: DurableObjectNamespace<Container>;
  /** Signs the moq-publish capability token + the x-wave-internal seal; never logged. */
  WAVE_INTERNAL_SECRET?: string;
}

/**
 * Lazy-connect, per-meeting multiplexed forwarder: one WS to
 * `getContainer(MOQ_PUBLISH, "${org}:${meetingUuid}")` opened on the FIRST writeFrame call and reused for
 * every subsequent frame/participant of that meeting; `close()` on stop. Fail-open throughout — see the
 * module header. Never queues: a frame that arrives before the (async) connect resolves is DROPPED, exactly
 * the same "drop until connected" contract `deps.ingestSocket()` already has (rtms-bridge-core.ts).
 */
export class MoqForwardTarget implements MoqForwardWriter {
  private ws: WebSocket | null = null;
  private connecting: Promise<void> | null = null;
  private closed = false;

  constructor(
    private readonly binding: DurableObjectNamespace<Container>,
    private readonly org: string,
    private readonly meetingUuid: string,
    private readonly log: (msg: string, fields: Record<string, unknown>) => void,
    private readonly secret?: string,
    private readonly getContainerImpl: GetContainerImpl = defaultGetContainer,
  ) {}

  writeFrame(uid: string, kind: MoqFrameKind, ts: number, payload: Uint8Array): void {
    if (this.closed) return;
    const ws = this.ws;
    if (ws) {
      this.send(ws, uid, kind, ts, payload);
      return;
    }
    if (!this.connecting) this.connecting = this.connect();
    // Fire-and-forget: THIS frame drops (fail-open, no queueing); a later frame — once `this.ws` is set —
    // sends normally. Never awaited here so writeFrame stays synchronous (the RTMS pump never blocks on it).
    void this.connecting;
  }

  private send(ws: WebSocket, uid: string, kind: MoqFrameKind, ts: number, payload: Uint8Array): void {
    if (ws.readyState !== 1 /* OPEN */) return; // not open (yet, or anymore) → drop
    const buffered = (ws as unknown as { bufferedAmount?: number }).bufferedAmount ?? 0;
    if (buffered > MAX_BUFFERED_BYTES) {
      this.log("moq-forward-backpressure-drop", { meetingUuid: this.meetingUuid, uid, kind, bufferedAmount: buffered });
      return;
    }
    try {
      ws.send(encodeMoqFrame(uid, kind, ts, payload));
    } catch (e) {
      this.log("moq-forward-send-error", { meetingUuid: this.meetingUuid, uid, kind, message: (e as Error)?.message ?? "unknown" });
    }
  }

  private async connect(): Promise<void> {
    try {
      const container = this.getContainerImpl(this.binding, `${this.org}:${this.meetingUuid}`);
      const token = this.secret ? await mintRecorderToken(this.secret, this.org, this.meetingUuid, "moq-publish") : "";
      const url = `https://moq-publish/publish/${encodeURIComponent(this.meetingUuid)}${token ? `?t=${encodeURIComponent(token)}` : ""}`;
      const headers: Record<string, string> = { Upgrade: "websocket" };
      if (this.secret) headers["x-wave-internal"] = this.secret;
      const res = await container.fetch(new Request(url, { headers }));
      const ws = (res as unknown as { webSocket?: WebSocket }).webSocket;
      if (!ws) {
        this.log("moq-forward-connect-no-socket", { meetingUuid: this.meetingUuid, org: this.org });
        return;
      }
      ws.accept();
      const clear = (): void => {
        if (this.ws === ws) this.ws = null;
      };
      ws.addEventListener("close", clear);
      ws.addEventListener("error", clear);
      if (this.closed) {
        try {
          ws.close();
        } catch {
          /* best-effort */
        }
        return;
      }
      this.ws = ws;
    } catch (e) {
      this.log("moq-forward-connect-error", { meetingUuid: this.meetingUuid, org: this.org, message: (e as Error)?.message ?? "unknown" });
    } finally {
      this.connecting = null;
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    try {
      this.ws?.close();
    } catch {
      /* best-effort */
    }
    this.ws = null;
  }
}

/**
 * Build the meeting's MoqForwardTarget, or null (inert) when `env.MOQ_PUBLISH` is absent OR org/meetingUuid
 * fail the namespace allowlist (never a fabricated/partial forwarder — config-no-silent-noop: logs why).
 */
export function createMoqForwardTarget(
  env: MoqForwardTargetEnv,
  org: string,
  meetingUuid: string,
  log: (msg: string, fields: Record<string, unknown>) => void,
  getContainerImpl?: GetContainerImpl,
): MoqForwardWriter | null {
  if (!env.MOQ_PUBLISH) return null;
  if (!SAFE_MOQ_SEGMENT.test(org) || !SAFE_MOQ_SEGMENT.test(meetingUuid)) {
    log("moq-forward-invalid-namespace", { org, meetingUuid });
    return null;
  }
  return new MoqForwardTarget(env.MOQ_PUBLISH, org, meetingUuid, log, env.WAVE_INTERNAL_SECRET, getContainerImpl);
}
