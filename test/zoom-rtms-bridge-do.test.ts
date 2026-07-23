// #88 M2 — ZoomRtmsBridgeDO shell (src/zoom-rtms-bridge-do.ts). Proves the control paths with an injected
// fetch + a stubbed WebSocketPair (zero live Zoom/SFU): INERT 501 without the flag, the SFU ingest WS
// upgrade, the fail-CLOSED resolver (no creds / no room mapping → no dial), and that an armed+mapped start
// actually dials Zoom's signaling leg with the handshake req. The full media sequence is proven in the core.
import { describe, it, expect, beforeAll } from "vitest";
import { ZoomRtmsBridgeDO } from "../src/zoom-rtms-bridge-do.js";
import type { RtmsStartedEvent } from "../src/zoom-rtms-bridge.js";
import { rtmsHandshakeSignature } from "../src/rtms-auth.js";
import { signalingHandshakeReq } from "../src/rtms-protocol.js";
import { bytesToBase64 } from "../src/twilio-mediastream.js";
import { int16ToPcmS16Le } from "../src/rtms-audio.js";

const EVENT: RtmsStartedEvent = {
  kind: "rtms_started",
  meetingUuid: "mtg-uuid-xyz",
  rtmsStreamId: "stream-77",
  serverUrls: "wss://signal.zoom.us",
};

class FakeWs {
  sent: string[] = [];
  private listeners: Record<string, Array<(ev: unknown) => void>> = {};
  accept(): void {}
  addEventListener(type: string, cb: (ev: unknown) => void): void {
    (this.listeners[type] ??= []).push(cb);
  }
  send(d: string): void {
    this.sent.push(d);
  }
  close(): void {}
  /** Test-only: fire a captured listener (drives the mock Zoom legs' onMessage). */
  fire(type: string, ev: unknown): void {
    for (const cb of this.listeners[type] ?? []) cb(ev);
  }
}

let serverWS: FakeWs;
// #RTMS-fanout — every server-side socket the DO's WebSocketPair mock creates, in creation order (so a test
// can grab the Nth accepted ingest socket — the mixed one, or a specific participant's).
const serverSockets: FakeWs[] = [];
beforeAll(() => {
  (globalThis as unknown as { WebSocketPair: unknown }).WebSocketPair = class {
    0 = new FakeWs();
    1 = (serverWS = ((): FakeWs => {
      const ws = new FakeWs();
      serverSockets.push(ws);
      return ws;
    })());
  } as unknown;
});

const mkState = () => ({ storage: { get: async () => undefined, put: async () => {} } }) as never;

/** A KV stub that maps the test meeting to a wave room, or nothing. */
const kv = (mapped: boolean) =>
  ({
    get: async (k: string) => (mapped && k === EVENT.meetingUuid ? { org: "acme", sessionId: "sess-12345678", trackName: "zoom-mtg" } : null),
  }) as unknown;

const dialed: FakeWs[] = [];
/** #RTMS-fanout — every /adapters/websocket/new create call, so a test can assert distinct trackNames were
 *  requested (one per participant) instead of just counting invocations. */
const adapterCreates: Array<{ trackName: string; endpoint: string }> = [];
const zoomFetch = (async (url: string, init?: { body?: string }) => {
  if (String(url).includes("/adapters/websocket/new")) {
    const body = init?.body ? (JSON.parse(init.body) as { tracks: Array<{ trackName: string; endpoint: string }> }) : { tracks: [] };
    if (body.tracks[0]) adapterCreates.push({ trackName: body.tracks[0].trackName, endpoint: body.tracks[0].endpoint });
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

describe("ZoomRtmsBridgeDO — per-participant sinks (#RTMS-fanout WAVE_RTMS_PER_PARTICIPANT)", () => {
  const ackFrame = (audioUrl: string): string =>
    JSON.stringify({ msg_type: 2, status_code: 0, media_server: { server_urls: { audio: audioUrl } } });
  const audioFrame = (userId: number | string, samples: number[]): string =>
    JSON.stringify({ msg_type: 14, content: { user_id: userId, data: bytesToBase64(int16ToPcmS16Le(new Int16Array(samples))) } });
  const flushAsync = async (): Promise<void> => {
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
  };
  const ingestUpgrade = (path: string): Request => new Request(`https://zoom-rtms${path}`, { headers: { Upgrade: "websocket" } });

  it("flag OFF: no per-participant track is ever requested — byte-identical single mixed track", async () => {
    dialed.length = 0;
    adapterCreates.length = 0;
    serverSockets.length = 0;
    const doo = new ZoomRtmsBridgeDO(mkState(), armed()); // WAVE_RTMS_PER_PARTICIPANT absent
    await doo.fetch(startReq());
    await doo.fetch(ingestUpgrade("/ingest")); // the mixed slot
    dialed[0].fire("message", { data: ackFrame("wss://media.zoom.us/audio") });
    await flushAsync(); // let the media-leg dial + its addEventListener registration settle
    dialed[1].fire("message", { data: audioFrame(5, [1, 2, 3, 4]) });
    await flushAsync();
    expect(adapterCreates).toHaveLength(1); // only the one mixed-track create from start(), never a per-user one
    expect(adapterCreates[0].trackName).toBe("zoom-mtg");
    expect(serverSockets[0].sent).toHaveLength(1); // the mixed socket got the frame
  });

  it("flag ON + 2 userIds: 2 distinct ingest tracks are created, each sink gets only its user's frames", async () => {
    dialed.length = 0;
    adapterCreates.length = 0;
    serverSockets.length = 0;
    const doo = new ZoomRtmsBridgeDO(mkState(), armed({ WAVE_RTMS_PER_PARTICIPANT: "1" }));
    await doo.fetch(startReq());
    dialed[0].fire("message", { data: ackFrame("wss://media.zoom.us/audio") });
    await flushAsync(); // let the media-leg dial + its addEventListener registration settle

    // First frame per user: sinks() fires the async createIngest, but no socket has dialed back yet → dropped.
    dialed[1].fire("message", { data: audioFrame(5, [1, 2, 3, 4]) });
    dialed[1].fire("message", { data: audioFrame(9, [5, 6, 7, 8]) });
    await flushAsync();

    expect(adapterCreates).toHaveLength(3); // start()'s mixed track + one per user
    const track5 = "zoom-mtg-uuid-xyz-5";
    const track9 = "zoom-mtg-uuid-xyz-9";
    expect(adapterCreates.map((a) => a.trackName)).toEqual(expect.arrayContaining([track5, track9]));
    expect(adapterCreates.find((a) => a.trackName === track5)?.endpoint).toContain(`/${track5}`);

    // Now the SFU dials BACK each participant's minted endpoint — the DO must route each socket by trackName.
    await doo.fetch(ingestUpgrade(`/zoom/rtms/ingest/${EVENT.meetingUuid}/acme/sess-12345678/${track5}`));
    const sock5 = serverSockets[serverSockets.length - 1];
    await doo.fetch(ingestUpgrade(`/zoom/rtms/ingest/${EVENT.meetingUuid}/acme/sess-12345678/${track9}`));
    const sock9 = serverSockets[serverSockets.length - 1];
    expect(sock5).not.toBe(sock9);

    // Second frame per user: the cached ParticipantSink now finds its socket live and sends.
    dialed[1].fire("message", { data: audioFrame(5, [1, 2, 3, 4]) });
    dialed[1].fire("message", { data: audioFrame(9, [5, 6, 7, 8]) });

    expect(sock5.sent).toHaveLength(1);
    expect(sock9.sent).toHaveLength(1);
    expect(sock5.sent[0]).not.toBe(sock9.sent[0]); // distinct seq counters per participant
    expect(adapterCreates).toHaveLength(3); // no re-create on the second frame (idempotent per trackName)
  });

  it("flag ON + an invalid userId still falls back to the mixed track (no per-participant track requested)", async () => {
    dialed.length = 0;
    adapterCreates.length = 0;
    serverSockets.length = 0;
    const doo = new ZoomRtmsBridgeDO(mkState(), armed({ WAVE_RTMS_PER_PARTICIPANT: "1" }));
    await doo.fetch(startReq());
    await doo.fetch(ingestUpgrade("/ingest")); // the mixed slot
    const mixedSock = serverSockets[serverSockets.length - 1];
    dialed[0].fire("message", { data: ackFrame("wss://media.zoom.us/audio") });
    await flushAsync(); // let the media-leg dial + its addEventListener registration settle
    dialed[1].fire("message", { data: audioFrame(1e21, [1, 2, 3, 4]) }); // fails SAFE_RTMS_USER_ID
    await flushAsync();

    expect(adapterCreates).toHaveLength(1); // only start()'s mixed track — sinks() never reached
    expect(mixedSock.sent).toHaveLength(1); // frame landed on the mixed socket instead
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
