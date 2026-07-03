// #76 P2 (arch A, co-locate) — the agent's media-READ folds onto the SINGLE RoomDO.mediaTap: an in-process
// MediaConsumer for the agent's target track, NO 2nd SFU subscription, NO cross-DO frame transport. Proves the
// fold drains frames WHEN ARMED, is byte-identically INERT when MEDIA_TAP_ENABLED is off, and that the
// `agent-bind` fetch intent arms it. Additive: the live AgentSessionDO echo path is untouched (#78 later).
import { describe, it, expect } from "vitest";
import { RoomDO } from "../src/room.js";
import type { RoomDOEnv } from "../src/room.js";
import { agentConsumerId, buildAgentReadConsumer, startAgentRead } from "../src/agent-media-consumer.js";
import { MediaTap } from "../src/media-tap.js";

function memStorage() {
  const map = new Map<string, unknown>();
  return { get: async <T>(k: string) => map.get(k) as T | undefined, put: async <T>(k: string, v: T) => void map.set(k, v) };
}

const ORG = "org-A";
const FRAME = new Uint8Array([1, 2, 3]);

async function seededRoom(env: RoomDOEnv) {
  const do_ = new RoomDO({ storage: memStorage() }, env);
  await do_.ensureRoom({ roomId: "room-1", org: ORG });
  await do_.joinRoom(ORG, { participantId: "p1", sessionId: "sess-1", role: "host" });
  await do_.registerTrack(ORG, { trackName: "mic", sessionId: "sess-1", participantId: "p1", kind: "audio" });
  return do_;
}

describe("#76 P2 — agent read consumer (pure)", () => {
  it("selects audio on the agent's target track and drains via the tap", async () => {
    const tap = new MediaTap();
    let seen = 0;
    const handle = startAgentRead(tap, { agentId: "a1", participantTrackName: "mic" }, { onFrame: () => void seen++ }, true);
    expect(handle).not.toBeNull();
    tap.publish({ sessionId: "s", trackName: "mic", kind: "audio", participantId: "p1", bytes: FRAME, ts: 0 });
    await new Promise((r) => setTimeout(r, 0));
    expect(seen).toBe(1);
  });

  it("is INERT when not armed — startAgentRead returns null, nothing registers", () => {
    const tap = new MediaTap();
    const handle = startAgentRead(tap, { agentId: "a1", participantTrackName: "mic" }, { onFrame: () => {} }, false);
    expect(handle).toBeNull();
    expect(tap.consumerCount).toBe(0);
  });

  it("consumer id is stable per (agent, track) and selector narrows to audio+track", () => {
    const target = { agentId: "a1", participantTrackName: "mic" };
    expect(agentConsumerId(target)).toBe("agent:a1:mic");
    expect(buildAgentReadConsumer(target, { onFrame: () => {} }).selector).toEqual({ kinds: ["audio"], trackNames: ["mic"] });
  });
});

describe("#76 P2 — RoomDO agent-read fold", () => {
  it("armAgentRead drains the target track off the room's single tap WHEN ARMED (one subscribe, fanned)", async () => {
    const do_ = await seededRoom({ MEDIA_TAP_ENABLED: "1" });
    expect(do_.armAgentRead({ agentId: "a1", participantTrackName: "mic" })).toBe(true);
    await do_.feedRecorderFrame("sess-1", "mic", FRAME);
    await new Promise((r) => setTimeout(r, 0));
    expect(do_.agentReadFrameCount).toBe(1);
  });

  it("is byte-identically INERT when MEDIA_TAP_ENABLED is off (prod unchanged)", async () => {
    const do_ = await seededRoom({});
    expect(do_.armAgentRead({ agentId: "a1", participantTrackName: "mic" })).toBe(false);
    await do_.feedRecorderFrame("sess-1", "mic", FRAME);
    await new Promise((r) => setTimeout(r, 0));
    expect(do_.agentReadFrameCount).toBe(0);
  });

  it("the agent-bind fetch intent arms the read (armed:true) and validates inputs", async () => {
    const do_ = await seededRoom({ MEDIA_TAP_ENABLED: "1" });
    const ok = await do_.fetch(new Request("https://room/agent-bind?agentId=a1&participantTrackName=mic", { method: "POST" }));
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ ok: true, armed: true });
    const bad = await do_.fetch(new Request("https://room/agent-bind", { method: "POST" }));
    expect(bad.status).toBe(400);
  });

  it("re-bind is idempotent (only one drain across the same tap)", async () => {
    const do_ = await seededRoom({ MEDIA_TAP_ENABLED: "1" });
    do_.armAgentRead({ agentId: "a1", participantTrackName: "mic" });
    do_.armAgentRead({ agentId: "a1", participantTrackName: "mic" });
    expect(do_.mediaTap.consumerCount).toBe(1);
  });
});
