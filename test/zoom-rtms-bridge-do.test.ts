// #88 M2 — ZoomRtmsBridgeDO shell (src/zoom-rtms-bridge-do.ts). Proves the control paths with an injected
// fetch + a stubbed WebSocketPair (zero live Zoom/SFU): INERT 501 without the flag, the SFU ingest WS
// upgrade, the fail-CLOSED resolver (no creds / no room mapping → no dial), and that an armed+mapped start
// actually dials Zoom's signaling leg with the handshake req. The full media sequence is proven in the core.
import { describe, it, expect, beforeAll } from "vitest";
import { ZoomRtmsBridgeDO } from "../src/zoom-rtms-bridge-do.js";
import type { RtmsStartedEvent } from "../src/zoom-rtms-bridge.js";
import { rtmsHandshakeSignature } from "../src/rtms-auth.js";
import { signalingHandshakeReq } from "../src/rtms-protocol.js";

const EVENT: RtmsStartedEvent = {
  kind: "rtms_started",
  meetingUuid: "mtg-uuid-xyz",
  rtmsStreamId: "stream-77",
  serverUrls: "wss://signal.zoom.us",
};

class FakeWs {
  sent: string[] = [];
  accept(): void {}
  addEventListener(): void {}
  send(d: string): void {
    this.sent.push(d);
  }
  close(): void {}
}

let serverWS: FakeWs;
beforeAll(() => {
  (globalThis as unknown as { WebSocketPair: unknown }).WebSocketPair = class {
    0 = new FakeWs();
    1 = (serverWS = new FakeWs());
  } as unknown;
});

const mkState = () => ({ storage: { get: async () => undefined, put: async () => {} } }) as never;

/** A KV stub that maps the test meeting to a wave room, or nothing. */
const kv = (mapped: boolean) =>
  ({
    get: async (k: string) => (mapped && k === EVENT.meetingUuid ? { org: "acme", sessionId: "sess-12345678", trackName: "zoom-mtg" } : null),
  }) as unknown;

const dialed: FakeWs[] = [];
const zoomFetch = (async (url: string) => {
  if (String(url).includes("/adapters/websocket/new")) {
    return { ok: true, status: 200, json: async () => ({ tracks: [{ adapterId: "in_1", sessionId: "cf_pub" }] }) } as unknown as Response;
  }
  const ws = new FakeWs();
  dialed.push(ws);
  return { webSocket: ws } as unknown as Response;
}) as unknown as typeof fetch;

const armed = (over: Record<string, unknown> = {}) =>
  ({
    WAVE_ZOOM_RTMS: "1",
    ZOOM_APPS_CLIENT_ID: "APPID123",
    ZOOM_APPS_CLIENT_SECRET: "s3cr3t",
    CF_CALLS_APP_ID: "a".repeat(32),
    CF_CALLS_APP_SECRET: "sfu-bearer",
    WAVE_INTERNAL_SECRET: "wis",
    AGENT_PUBLIC_WSS: "wss://rt.wave.online",
    RT_MEETING_ORG: kv(true),
    __zoomFetch: zoomFetch,
    ...over,
  }) as never;

const startReq = () =>
  new Request("https://zoom-rtms/start", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ event: EVENT }),
  });

describe("ZoomRtmsBridgeDO — INERT gate", () => {
  it("501s every intent when WAVE_ZOOM_RTMS is off", async () => {
    const doo = new ZoomRtmsBridgeDO(mkState(), {} as never);
    expect((await doo.fetch(startReq())).status).toBe(501);
    expect((await doo.fetch(new Request("https://zoom-rtms/x", { headers: { Upgrade: "websocket" } }))).status).toBe(501);
  });
});

describe("ZoomRtmsBridgeDO — SFU ingest WS upgrade", () => {
  it("accepts the upgrade and holds the socket when armed", async () => {
    const doo = new ZoomRtmsBridgeDO(mkState(), armed());
    const res = await doo.fetch(new Request("https://zoom-rtms/ingest", { headers: { Upgrade: "websocket" } }));
    expect(res.status).toBeLessThan(400); // 101 (or 200 fallback in node)
  });

  it("503s when WebSocketPair is unavailable (config-no-silent-noop)", async () => {
    const saved = (globalThis as unknown as { WebSocketPair: unknown }).WebSocketPair;
    (globalThis as unknown as { WebSocketPair: unknown }).WebSocketPair = undefined;
    const doo = new ZoomRtmsBridgeDO(mkState(), armed());
    const res = await doo.fetch(new Request("https://zoom-rtms/ingest", { headers: { Upgrade: "websocket" } }));
    expect(res.status).toBe(503);
    (globalThis as unknown as { WebSocketPair: unknown }).WebSocketPair = saved;
  });
});

describe("ZoomRtmsBridgeDO — start: fail-closed resolver", () => {
  it("does not dial when ZOOM_APPS_* creds are unprovisioned (started:false)", async () => {
    const doo = new ZoomRtmsBridgeDO(mkState(), armed({ ZOOM_APPS_CLIENT_ID: undefined, ZOOM_APPS_CLIENT_SECRET: undefined }));
    const res = await doo.fetch(startReq());
    expect(res.status).toBe(200);
    expect(((await res.json()) as { started: boolean }).started).toBe(false);
  });

  it("does not dial when the meeting has no wave-room mapping (started:false)", async () => {
    const doo = new ZoomRtmsBridgeDO(mkState(), armed({ RT_MEETING_ORG: kv(false) }));
    const res = await doo.fetch(startReq());
    expect(((await res.json()) as { started: boolean }).started).toBe(false);
  });

  it("400s a start body that isn't a verified rtms_started event", async () => {
    const doo = new ZoomRtmsBridgeDO(mkState(), armed());
    const res = await doo.fetch(new Request("https://zoom-rtms/start", { method: "POST", body: JSON.stringify({ event: { kind: "other" } }) }));
    expect(res.status).toBe(400);
  });
});

describe("ZoomRtmsBridgeDO — start: armed + mapped dials Zoom", () => {
  it("resolves the target, creates the ingest adapter, and sends the signaling handshake", async () => {
    dialed.length = 0;
    const doo = new ZoomRtmsBridgeDO(mkState(), armed());
    const res = await doo.fetch(startReq());
    expect(((await res.json()) as { started: boolean }).started).toBe(true);
    // The outbound signaling leg was dialed and the handshake sent (proves the DO wired real deps into the core).
    expect(dialed).toHaveLength(1);
    const sig = await rtmsHandshakeSignature("APPID123", EVENT.meetingUuid, EVENT.rtmsStreamId, "s3cr3t");
    expect(dialed[0].sent[0]).toBe(signalingHandshakeReq(EVENT.meetingUuid, EVENT.rtmsStreamId, sig));
  });
});

describe("ZoomRtmsBridgeDO — stop + unknown intent", () => {
  it("stops cleanly and 400s an unknown intent", async () => {
    const doo = new ZoomRtmsBridgeDO(mkState(), armed());
    const stop = await doo.fetch(new Request("https://zoom-rtms/stop", { method: "POST" }));
    expect(((await stop.json()) as { stopped: boolean }).stopped).toBe(true);
    const bad = await doo.fetch(new Request("https://zoom-rtms/wat", { method: "POST" }));
    expect(bad.status).toBe(400);
  });
});
