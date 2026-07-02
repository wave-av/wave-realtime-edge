// E-MEDIA-TAP (#74) — RoomDO frame-sink → MediaTap wiring. Proves the DO's single frame sink (feedRecorderFrame,
// which the recorder route also calls) fans each decoded frame out to the room's MediaTap consumers WHEN ARMED,
// resolving (participant,kind) from the room registry — and is byte-identically inert when MEDIA_TAP_ENABLED is off.
// Uses the RoomDO typed API (ensureRoom/joinRoom/registerTrack are pure state — no SFU needed).
import { describe, it, expect } from "vitest";
import { RoomDO } from "../src/room.js";
import type { RoomDOEnv } from "../src/room.js";
import type { TapFrame } from "../src/media-tap.js";

function memStorage() {
  const map = new Map<string, unknown>();
  return { get: async <T>(k: string) => map.get(k) as T | undefined, put: async <T>(k: string, v: T) => void map.set(k, v) };
}

const ORG = "org-A";
const FRAME = new Uint8Array([9, 9, 9]);

async function seededRoom(env: RoomDOEnv) {
  const do_ = new RoomDO({ storage: memStorage() }, env);
  await do_.ensureRoom({ roomId: "room-1", org: ORG });
  await do_.joinRoom(ORG, { participantId: "p1", sessionId: "sess-1", role: "host" });
  await do_.registerTrack(ORG, { trackName: "mic", sessionId: "sess-1", participantId: "p1", kind: "audio" });
  return do_;
}

describe("RoomDO frame-sink → MediaTap", () => {
  it("fans a decoded frame out to a subscribed consumer when armed, resolving participant+kind from the registry", async () => {
    const do_ = await seededRoom({ MEDIA_TAP_ENABLED: "1" });
    const handle = do_.mediaTap.subscribe("recorder", {});
    await do_.feedRecorderFrame("sess-1", "mic", FRAME);
    const frame = (await handle.next()) as TapFrame;
    expect(frame).toMatchObject({ trackName: "mic", kind: "audio", participantId: "p1", seq: 1 });
    expect(frame.bytes).toEqual(FRAME);
  });

  it("is INERT when the flag is off — the same feed publishes nothing (prod byte-identical)", async () => {
    const do_ = await seededRoom({}); // no MEDIA_TAP_ENABLED
    do_.mediaTap.subscribe("recorder", {});
    await do_.feedRecorderFrame("sess-1", "mic", FRAME);
    expect(do_.mediaTap.stats().seq).toBe(0); // nothing published
  });

  it("fans ONE room's media out to TWO independent consumers — the epic's one-tap→two-consumer verdict", async () => {
    const do_ = await seededRoom({ MEDIA_TAP_ENABLED: "1" });
    const egress = do_.mediaTap.subscribe("egress", {}); // records everything
    const perception = do_.mediaTap.subscribe("perception", { kinds: ["audio"] }); // #85 audio agent
    await do_.feedRecorderFrame("sess-1", "mic", FRAME);
    expect((await egress.next())?.seq).toBe(1);
    expect((await perception.next())?.seq).toBe(1); // both saw the same frame, neither starved the other
    expect(do_.mediaTap.stats().consumers).toHaveLength(2);
  });

  it("an unregistered track resolves to no one (fail-closed) even when armed", async () => {
    const do_ = await seededRoom({ MEDIA_TAP_ENABLED: "1" });
    do_.mediaTap.subscribe("recorder", {});
    await do_.feedRecorderFrame("sess-1", "ghost", FRAME); // never registered
    expect(do_.mediaTap.stats().seq).toBe(0);
  });

  it("the recorder-frame intent path sinks through the SAME tap wiring", async () => {
    const do_ = await seededRoom({ MEDIA_TAP_ENABLED: "1" });
    const handle = do_.mediaTap.subscribe("c", {});
    const req = new Request("https://room/recorder-frame?sessionId=sess-1&trackName=mic", { method: "POST", body: FRAME });
    const res = await do_.fetch(req);
    expect(res.status).toBe(204);
    expect((await handle.next())?.trackName).toBe("mic");
  });
});
