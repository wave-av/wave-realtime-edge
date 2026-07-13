// #151 — RoomRecording.buildDispatch: the per-track recorder-dispatch descriptors the RoomDO returns to an
// internal orchestrator. Proves: [] when WAVE_INTERNAL_SECRET is unset (never an unusable descriptor); one
// descriptor per track carrying a token that verifyRecorderToken ACCEPTS for the exact (org,session,track)
// scope and REJECTS for a different track (scope-tight); descriptors carry NO secret (only appId + path + token).
import { describe, it, expect } from "vitest";
import { RoomRecording } from "../src/room-recording.js";
import { verifyRecorderToken } from "../src/encoders/recorder-auth.js";
import type { RoomStorage, TrackKind } from "../src/room.js";

function memStorage(): RoomStorage {
	const m = new Map<string, unknown>();
	return {
		async get<T>(k: string) {
			return m.get(k) as T | undefined;
		},
		async put<T>(k: string, v: T) {
			m.set(k, v);
		},
	};
}

const TRACKS: { trackName: string; sessionId: string; kind: TrackKind }[] = [
	{ trackName: "cam", sessionId: "sfu-sess-1", kind: "video" },
	{ trackName: "mic", sessionId: "sfu-sess-1", kind: "audio" },
];

describe("RoomRecording.buildDispatch — #151 recorder descriptors", () => {
	it("returns [] when WAVE_INTERNAL_SECRET is unset (no unusable descriptor)", async () => {
		const r = new RoomRecording({ CF_CALLS_APP_ID: "app1" } as never, memStorage());
		expect(await r.buildDispatch("org_x", "r1", TRACKS)).toEqual([]);
	});

	it("mints one descriptor per track with a scope-tight, verifiable token — and leaks NO secret", async () => {
		const secret = "canary-internal-secret";
		const r = new RoomRecording({ WAVE_INTERNAL_SECRET: secret, CF_CALLS_APP_ID: "app1" } as never, memStorage());
		const out = await r.buildDispatch("org_x", "r1", TRACKS);
		expect(out.length).toBe(2);

		const cam = out.find((d) => d.trackName === "cam")!;
		expect(cam.publisherSessionId).toBe("sfu-sess-1");
		expect(cam.kind).toBe("video");
		expect(cam.appId).toBe("app1");
		expect(cam.sfuBase).toBe("https://rtc.live.cloudflare.com/v1");
		expect(cam.ingestPath).toBe("/v1/realtime/recording-ingest/org_x/r1/sfu-sess-1/cam");

		// The minted token verifies for EXACTLY (org_x, sfu-sess-1, cam) …
		expect(await verifyRecorderToken(secret, "org_x", "sfu-sess-1", "cam", cam.token)).toBe(true);
		// … and is REJECTED for a different track (scope-tight — a leaked cam URL can't record the mic) …
		expect(await verifyRecorderToken(secret, "org_x", "sfu-sess-1", "mic", cam.token)).toBe(false);
		// … and for a different secret (mint here ≡ verify at the ingest route, keyed by THIS secret).
		expect(await verifyRecorderToken("other", "org_x", "sfu-sess-1", "cam", cam.token)).toBe(false);

		// No descriptor field carries a secret value (only appId, path, and the scoped token).
		const serialized = JSON.stringify(out);
		expect(serialized).not.toContain(secret);
	});
});
