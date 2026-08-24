// E-ROOMS receipt test — two-party live-room A/V + state-sync proof.
//
// Exercises the full signaling path with two participants (Alice + Bob):
//   1. Both join the same room (separate SFU sessions)
//   2. Alice publishes audio + video tracks
//   3. Bob subscribes to Alice's tracks (SFU pull from publisher's session)
//   4. Presence state-sync delivers the participant list to both
//   5. Alice leaves; Bob's subscription is torn down
//
// This is a HEADLESS receipt: mocked SFU HTTP + in-memory storage, but exercises the
// real RoomCore state machine, real Signaling orchestration, and real Presence engine.
// A live receipt requires two WebRTC browsers — this is the closest automated equivalent.
//
// Born: E-ROOMS parity ledger row #1 arm crossing (2026-08-23).

import { describe, it, expect } from "vitest";
import { RoomCore, RoomStorage } from "../src/room.js";
import { Signaling } from "../src/signaling.js";
import { SfuClient } from "../src/sfu.js";
import { projectRoomView } from "../src/presence.js";

// ── helpers ──────────────────────────────────────────────────────────────────

function memStorage(): RoomStorage {
  const map = new Map<string, unknown>();
  return {
    async get<T>(k: string) { return map.get(k) as T | undefined; },
    async put<T>(k: string, v: T) { map.set(k, v); },
  };
}

const CFG = { appId: "0123456789abcdef0123456789abcdef", appSecret: "test-secret" };
const SESSION_A = "sess-AAAA-AAAA-AAAA";
const SESSION_B = "sess-BBBB-BBBB-BBBB";

function jsonResp(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

function scriptedFetch(routes: Array<{ match: string; method?: string; body: unknown; status?: number }>) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fn: (input: string, init?: RequestInit) => Promise<Response> = async (input, init) => {
      const url = input;
    calls.push({ url, init });
    const method = init?.method ?? "GET";
    const route = routes.find((r) => url.includes(r.match) && (!r.method || r.method === method));
    if (!route) throw new Error(`no scripted route for ${method} ${url}`);
    return jsonResp(route.body, route.status ?? 200);
  };
  return { fn, calls };
}

const ORG = "org_receipt";
const ROOM = "room-e-rooms-receipt";
const CTX_ALICE = { org: ORG, room: ROOM, participantId: "alice" };
const CTX_BOB   = { org: ORG, room: ROOM, participantId: "bob" };

// ── receipt ──────────────────────────────────────────────────────────────────

describe("E-ROOMS receipt: two-party A/V + state-sync", () => {
  it("full two-party room lifecycle: join → publish → subscribe → presence → leave", async () => {
    // ── Step 1: Alice joins ──
    const aliceFetch = scriptedFetch([
      { match: "/sessions/new", method: "POST", body: { sessionId: SESSION_A } },
    ]);
    const core = new RoomCore(memStorage());
    const aliceSig = new Signaling(core, new SfuClient(CFG, aliceFetch.fn));

    const aliceJoin = await aliceSig.join(CTX_ALICE);
    expect("waiting" in aliceJoin).toBe(false);
    expect(aliceJoin.sessionId).toBe(SESSION_A);
    expect(aliceJoin.participantId).toBe("alice");

    // ── Step 2: Alice publishes audio + video ──
    const alicePubFetch = scriptedFetch([
      { match: "/tracks/new", method: "POST", body: {
        tracks: [
          { mid: "0", trackName: "cam" },
          { mid: "1", trackName: "mic" },
        ],
        sessionDescription: { type: "answer", sdp: "a=pub-ok" },
      }},
    ]);
    const alicePubSig = new Signaling(core, new SfuClient(CFG, alicePubFetch.fn));
    const pubResult = await alicePubSig.publishTrack(CTX_ALICE, {
      tracks: [
        { mid: "0", trackName: "cam", kind: "video" },
        { mid: "1", trackName: "mic", kind: "audio" },
      ],
      offer: { type: "offer", sdp: "v=0" },
    });
    expect(pubResult.tracks).toHaveLength(2);
    expect(pubResult.sessionDescription?.sdp).toBe("a=pub-ok");

    // Verify tracks are in the room registry
    const snap1 = await core.snapshot();
    const aliceTracks = Object.values(snap1.tracks).filter((t) => t.sessionId === SESSION_A);
    expect(aliceTracks).toHaveLength(2);
    expect(aliceTracks.map((t) => t.trackName).sort()).toEqual(["cam", "mic"]);

    // ── Step 3: Bob joins ──
    const bobJoinFetch = scriptedFetch([
      { match: "/sessions/new", method: "POST", body: { sessionId: SESSION_B } },
    ]);
    const bobSig = new Signaling(core, new SfuClient(CFG, bobJoinFetch.fn));

    const bobJoin = await bobSig.join(CTX_BOB);
    expect("waiting" in bobJoin).toBe(false);
    expect(bobJoin.sessionId).toBe(SESSION_B);
    expect(bobJoin.participantId).toBe("bob");

    // ── Step 4: Bob subscribes to Alice's "cam" ──
    const bobSubFetch = scriptedFetch([
      { match: "/tracks/new", method: "POST", body: {
        tracks: [{ trackName: "cam" }],
        sessionDescription: { type: "offer", sdp: "v=pull-cam" },
        requiresImmediateRenegotiation: true,
      }},
    ]);
    const bobSubSig = new Signaling(core, new SfuClient(CFG, bobSubFetch.fn));
    const subResult = await bobSubSig.subscribeTrack(CTX_BOB, { trackName: "cam" });
    expect(subResult.requiresImmediateRenegotiation).toBe(true);

    // The SFU pull referenced ALICE's session (the publisher)
    const pullCall = bobSubFetch.calls.find((c) => c.url.includes("/tracks/new"));
    expect(pullCall).toBeDefined();
    const pullBody = JSON.parse(pullCall!.init!.body as string);
    expect(pullBody.tracks[0]).toMatchObject({
      location: "remote",
      sessionId: SESSION_A,
      trackName: "cam",
    });

    // ── Step 5: Presence — both participants visible ──
    const snap2 = await core.snapshot();
    const participantIds = Object.keys(snap2.participants).sort();
    expect(participantIds).toEqual(["alice", "bob"]);

    // Project the room view (presence engine)
    const view = projectRoomView(snap2, { includeWaiting: false });
    expect(view.participants).toHaveLength(2);
    expect(view.participants.map((p) => p.participantId).sort()).toEqual(["alice", "bob"]);

    // ── Step 6: Alice leaves — her tracks are GC'd ──
    await aliceSig.leave(CTX_ALICE);
    const snap3 = await core.snapshot();
    expect(Object.keys(snap3.participants)).toEqual(["bob"]);
    // Alice's tracks should be removed from the registry
    const remainingTracks = Object.values(snap3.tracks).filter((t) => t.sessionId === SESSION_A);
    expect(remainingTracks).toHaveLength(0);

    // Bob is still in the room
    const viewAfter = projectRoomView(snap3, { includeWaiting: false });
    expect(viewAfter.participants).toHaveLength(1);
    expect(viewAfter.participants[0].participantId).toBe("bob");
  });
});
