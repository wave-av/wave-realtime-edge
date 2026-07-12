// #144 (#91-B) — WHIP → RoomDO recorder+negotiation wiring.
// Covers: (a) the pure SDP/flag/room-key helpers; (b) publishViaRoom's DO forward + FAIL-SOFT (null on any
// failure → caller falls back to the direct path); (c) Signaling.whipPublish orchestration (newSession → seat
// → register → recorder.onPublish armed, fail-open); (d) whip.ts handlePublish routing: flag ON routes through
// the room, flag OFF is the byte-identical direct path, and a room-path failure falls back to direct.
import { describe, it, expect } from "vitest";
import {
  parseSdpTracks,
  whipRoomRecordingEnabled,
  deriveWhipRoom,
  buildWhipTrackName,
  publishViaRoom,
  WHIP_ROOM_HEADER,
  type WhipRoomEnv,
} from "../src/whip-room.js";
import { Signaling, type RecordingHook } from "../src/signaling.js";
import { RoomCore } from "../src/room.js";
import { handleWhip, type WhipDeps, type WhipEnv, type WhipKv } from "../src/whip.js";
import type { SessionDescription } from "../src/sfu.js";

const SDP_AV =
  "v=0\r\no=- 1 1 IN IP4 0.0.0.0\r\ns=-\r\nt=0 0\r\n" +
  "m=audio 9 UDP/TLS/RTP/SAVPF 111\r\na=mid:0\r\na=sendonly\r\n" +
  "m=video 9 UDP/TLS/RTP/SAVPF 96\r\na=mid:1\r\na=sendonly\r\n";

// ── (a) pure helpers ─────────────────────────────────────────────────────────────────────────────
describe("#144 pure helpers", () => {
  it("parseSdpTracks extracts (mid, kind) for audio+video, ignores data channels", () => {
    const withData = SDP_AV + "m=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\na=mid:2\r\n";
    expect(parseSdpTracks(withData)).toEqual([
      { mid: "0", kind: "audio" },
      { mid: "1", kind: "video" },
    ]);
  });

  it("parseSdpTracks falls back to the ordinal index when a section has no a=mid", () => {
    const noMid = "v=0\r\nm=video 9 UDP/TLS/RTP/SAVPF 96\r\na=sendonly\r\n";
    expect(parseSdpTracks(noMid)).toEqual([{ mid: "0", kind: "video" }]);
  });

  it("parseSdpTracks returns [] for empty/none", () => {
    expect(parseSdpTracks("")).toEqual([]);
    expect(parseSdpTracks("v=0\r\ns=-\r\n")).toEqual([]);
  });

  it("whipRoomRecordingEnabled is off by default, on for truthy flags", () => {
    expect(whipRoomRecordingEnabled({})).toBe(false);
    expect(whipRoomRecordingEnabled({ WHIP_ROOM_RECORDING: "0" })).toBe(false);
    expect(whipRoomRecordingEnabled({ WHIP_ROOM_RECORDING: "1" })).toBe(true);
    expect(whipRoomRecordingEnabled({ WHIP_ROOM_RECORDING: true })).toBe(true);
  });

  it("deriveWhipRoom uses a validated caller room else a per-resource room", () => {
    expect(deriveWhipRoom("res01", "live-show")).toBe("live-show");
    expect(deriveWhipRoom("res01", "bad room!")).toBe("whip:res01"); // invalid → per-resource
    expect(deriveWhipRoom("res01", null)).toBe("whip:res01");
  });

  it("buildWhipTrackName is deterministic + url-safe", () => {
    expect(buildWhipTrackName("sessAbc", "0")).toBe("whip-sessAbc-0");
    expect(buildWhipTrackName("sessAbc", "au/dio")).toBe("whip-sessAbc-audio"); // sanitized
  });
});

// ── (b) publishViaRoom forward + fail-soft ───────────────────────────────────────────────────────
function stubRoom(fetchImpl: (req: Request) => Promise<Response>): {
  env: WhipRoomEnv;
  seen: { keys: string[]; reqs: Request[] };
} {
  const seen = { keys: [] as string[], reqs: [] as Request[] };
  const env: WhipRoomEnv = {
    ROOM: {
      idFromName(name: string) {
        seen.keys.push(name);
        return { __k: name };
      },
      get() {
        return {
          fetch: async (req: Request) => {
            seen.reqs.push(req);
            return fetchImpl(req);
          },
        };
      },
    },
  };
  return { env, seen };
}

const OFFER: SessionDescription = { type: "offer", sdp: SDP_AV };

describe("#144 publishViaRoom", () => {
  it("forwards a whip-publish intent (keyed org:room) and returns the session + answer", async () => {
    const { env, seen } = stubRoom(async () =>
      Response.json({ sessionId: "sessRoom01", sessionDescription: { type: "answer", sdp: "v=0\r\nROOM\r\n" } }),
    );
    const res = await publishViaRoom(env, "acme", OFFER, "res01", null, "whip-res01");
    expect(res).toEqual({ sessionId: "sessRoom01", answerSdp: "v=0\r\nROOM\r\n", room: "whip:res01" });
    expect(seen.keys[0]).toBe("acme:whip:res01");
    expect(new URL(seen.reqs[0].url).pathname).toBe("/whip-publish");
    const body = (await seen.reqs[0].json()) as { ctx: { role: string }; offer: SessionDescription };
    expect(body.ctx.role).toBe("speaker");
    expect(body.offer.sdp).toBe(SDP_AV);
  });

  it("returns null (fail-soft) on a non-2xx room response", async () => {
    const { env } = stubRoom(async () => new Response("boom", { status: 500 }));
    expect(await publishViaRoom(env, "acme", OFFER, "res01", null, "whip-res01")).toBeNull();
  });

  it("returns null (fail-soft) when the room answer is missing", async () => {
    const { env } = stubRoom(async () => Response.json({ sessionId: "sessRoom01" }));
    expect(await publishViaRoom(env, "acme", OFFER, "res01", null, "whip-res01")).toBeNull();
  });

  it("returns null when the DO throws or no ROOM binding is present", async () => {
    const { env } = stubRoom(async () => {
      throw new Error("net");
    });
    expect(await publishViaRoom(env, "acme", OFFER, "res01", null, "whip-res01")).toBeNull();
    expect(await publishViaRoom({}, "acme", OFFER, "res01", null, "whip-res01")).toBeNull();
  });
});

// ── (c) Signaling.whipPublish orchestration ──────────────────────────────────────────────────────
function memStorage() {
  const m = new Map<string, unknown>();
  return {
    async get<T>(k: string) {
      return m.get(k) as T | undefined;
    },
    async put(k: string, v: unknown) {
      m.set(k, v);
    },
    async delete(k: string) {
      m.delete(k);
    },
    async list() {
      return new Map();
    },
  };
}

describe("#144 Signaling.whipPublish", () => {
  it("creates the session, seats the publisher, registers tracks, and ARMS the recorder", async () => {
    const room = new RoomCore(memStorage() as never);
    const pushed: unknown[] = [];
    const sfu = {
      newSession: async () => ({ sessionId: "sessWhip01", sessionDescription: { type: "answer", sdp: SDP_AV } }),
      pushTracks: async (_s: string, tracks: unknown) => {
        pushed.push(tracks);
        return { tracks: [] };
      },
    } as never;
    const recorded: { sessionId: string; trackName: string; kind: string }[] = [];
    const recording: RecordingHook = {
      onPublish: async (_org, sessionId, _room, trackName, kind) => {
        recorded.push({ sessionId, trackName, kind });
      },
      finalize: async () => {},
    };
    const sig = new Signaling(room, sfu, {}, recording);
    const res = await sig.whipPublish(
      { org: "acme", room: "whip:res01", participantId: "whip-res01" },
      { offer: OFFER },
    );

    expect(res.sessionId).toBe("sessWhip01");
    expect(res.tracks.map((t) => t.trackName)).toEqual(["whip-sessWhip01-0", "whip-sessWhip01-1"]);
    // recorder armed for BOTH tracks with the derived names + kinds.
    expect(recorded).toEqual([
      { sessionId: "sessWhip01", trackName: "whip-sessWhip01-0", kind: "audio" },
      { sessionId: "sessWhip01", trackName: "whip-sessWhip01-1", kind: "video" },
    ]);
    // publisher seated + tracks registered in the room.
    expect((await room.listParticipants()).map((p) => p.participantId)).toEqual(["whip-res01"]);
    expect((await room.listTracks()).map((t) => t.trackName).sort()).toEqual([
      "whip-sessWhip01-0",
      "whip-sessWhip01-1",
    ]);
    expect(pushed.length).toBe(2); // each track named on the SFU
  });

  it("is FAIL-OPEN: a recorder onPublish throw never fails the publish", async () => {
    const room = new RoomCore(memStorage() as never);
    const sfu = {
      newSession: async () => ({ sessionId: "sessWhip02", sessionDescription: { type: "answer", sdp: SDP_AV } }),
      pushTracks: async () => ({ tracks: [] }),
    } as never;
    const recording: RecordingHook = {
      onPublish: async () => {
        throw new Error("recorder down");
      },
      finalize: async () => {},
    };
    const sig = new Signaling(room, sfu, {}, recording);
    const res = await sig.whipPublish({ org: "acme", room: "r", participantId: "p" }, { offer: OFFER });
    expect(res.sessionId).toBe("sessWhip02"); // publish still succeeds
  });
});

// ── (d) whip.ts handlePublish routing + fallback ─────────────────────────────────────────────────
function memKv(): WhipKv {
  const store = new Map<string, string>();
  return {
    async get(k) {
      return store.get(k) ?? null;
    },
    async put(k, v) {
      store.set(k, v);
    },
    async delete(k) {
      store.delete(k);
    },
  };
}

const DIRECT_ANSWER = "v=0\r\nDIRECT\r\n";
const ROOM_ANSWER = "v=0\r\nROOM\r\n";

function whipDeps(): { deps: WhipDeps; newSessionCalls: number } {
  let newSessionCalls = 0;
  const deps: WhipDeps = {
    sfu: () =>
      ({
        newSession: async () => {
          newSessionCalls++;
          return { sessionId: "sessDirect1", sessionDescription: { type: "answer", sdp: DIRECT_ANSWER } };
        },
        pushTracks: async () => ({ tracks: [] }),
      }) as never,
    now: () => 1_000_000,
    mintResourceId: () => "res00000001",
    fetch: (async () => new Response(null, { status: 200 })) as unknown as typeof fetch,
  };
  return {
    get deps() {
      return deps;
    },
    get newSessionCalls() {
      return newSessionCalls;
    },
  } as never;
}

function roomBinding(status = 200): WhipRoomEnv["ROOM"] {
  return {
    idFromName: (n: string) => ({ n }),
    get: () => ({
      fetch: async () =>
        status === 200
          ? Response.json({ sessionId: "sessRoom01", sessionDescription: { type: "answer", sdp: ROOM_ANSWER } })
          : new Response("boom", { status }),
    }),
  };
}

function baseEnv(over: Record<string, unknown> = {}): WhipEnv {
  return {
    WHIP_INGEST_ENABLED: "1",
    CF_CALLS_APP_ID: "a".repeat(32),
    CF_CALLS_APP_SECRET: "sekret",
    RT_MEETING_ORG: memKv(),
    ...over,
  } as never;
}

function publishReq(): Request {
  return new Request("https://rt.wave.online/v1/whip/publish", {
    method: "POST",
    headers: { "content-type": "application/sdp" },
    body: SDP_AV,
  });
}

describe("#144 whip.ts handlePublish routing", () => {
  it("flag OFF → byte-identical direct SFU path (answer from newSession)", async () => {
    const h = whipDeps();
    const res = await handleWhip(publishReq(), baseEnv({ ROOM: roomBinding() }), "acme", h.deps);
    expect(res!.status).toBe(201);
    expect(await res!.text()).toBe(DIRECT_ANSWER);
    expect(h.newSessionCalls).toBe(1);
  });

  it("flag ON + ROOM → routes through the room (answer from the room, SFU newSession NOT called)", async () => {
    const h = whipDeps();
    const res = await handleWhip(
      publishReq(),
      baseEnv({ WHIP_ROOM_RECORDING: "1", ROOM: roomBinding() }),
      "acme",
      h.deps,
    );
    expect(res!.status).toBe(201);
    expect(await res!.text()).toBe(ROOM_ANSWER);
    expect(h.newSessionCalls).toBe(0); // direct SFU path untouched
  });

  it("flag ON but the room path fails → FALLS BACK to the direct path (publish never breaks)", async () => {
    const h = whipDeps();
    const res = await handleWhip(
      publishReq(),
      baseEnv({ WHIP_ROOM_RECORDING: "1", ROOM: roomBinding(500) }),
      "acme",
      h.deps,
    );
    expect(res!.status).toBe(201);
    expect(await res!.text()).toBe(DIRECT_ANSWER);
    expect(h.newSessionCalls).toBe(1);
  });
});
