// E3n (wre#290) Axis A2 — the cron-sweep correlate→pull→register orchestration. Pure: every dependency is
// injected, no real CF/KV/R2/gateway network. Covers: happy path, missing org KV, pull failure (fail-safe, no
// double-register), and re-sweep idempotency (a re-tick never re-pulls/re-registers an already-landed video).
import { describe, it, expect, vi } from "vitest";
import { sweepE3nRecordings, type E3nSweepDeps } from "../src/e3n-recording-sweep.js";
import { isCompletedRecording, type CfVideoSummary } from "../src/e3n-recording-pull.js";

const completedVideo = (uid: string): CfVideoSummary => ({
  uid,
  liveInput: "in1",
  readyToStream: true,
  state: "ready",
  duration: 42,
  created: "2026-01-01",
});

function baseDeps(overrides: Partial<E3nSweepDeps> = {}): E3nSweepDeps & { registeredSet: Set<string> } {
  const registeredSet = new Set<string>();
  return {
    registeredSet,
    async listLiveInputs() {
      return [{ uid: "in1" }];
    },
    async resolveOrg() {
      return "org-1";
    },
    async listVideosForInput() {
      return [completedVideo("v1")];
    },
    async isRegistered(videoUid) {
      return registeredSet.has(videoUid);
    },
    async markRegistered(videoUid) {
      registeredSet.add(videoUid);
    },
    async pullToR2(video, org) {
      return { r2Key: `${org}/e3n-recordings/${video.uid}/recording.mp4`, bucket: "wave-recordings-enam" };
    },
    async register() {
      return { ok: true };
    },
    log: () => {},
    ...overrides,
  };
}

describe("sweepE3nRecordings — happy path", () => {
  it("pulls, registers, and marks a completed recording exactly once", async () => {
    const registerSpy = vi.fn(async () => ({ ok: true }));
    const deps = baseDeps({ register: registerSpy });
    const out = await sweepE3nRecordings(deps);
    expect(out).toMatchObject({ scanned: 1, completed: 1, registered: 1, alreadyRegistered: 0, missingOrg: 0, pullPending: 0, registerFailed: 0 });
    expect(registerSpy).toHaveBeenCalledWith({ org: "org-1", r2Key: "org-1/e3n-recordings/v1/recording.mp4", bucket: "wave-recordings-enam", zone: "us-east" });
    expect(deps.registeredSet.has("v1")).toBe(true);
  });

  it("skips non-completed videos entirely (no pull, no register call)", async () => {
    const pullSpy = vi.fn(async () => null);
    const deps = baseDeps({
      listVideosForInput: async () => [{ uid: "v-inprogress", liveInput: "in1", readyToStream: false, state: "inprogress", duration: null, created: null }],
      pullToR2: pullSpy,
    });
    const out = await sweepE3nRecordings(deps);
    expect(out.completed).toBe(0);
    expect(pullSpy).not.toHaveBeenCalled();
  });
});

describe("sweepE3nRecordings — missing org", () => {
  it("skips a completed video whose org cannot be resolved; never pulls or registers", async () => {
    const pullSpy = vi.fn(async () => ({ r2Key: "x", bucket: "b" }));
    const registerSpy = vi.fn(async () => ({ ok: true }));
    const deps = baseDeps({ resolveOrg: async () => null, pullToR2: pullSpy, register: registerSpy });
    const out = await sweepE3nRecordings(deps);
    expect(out.missingOrg).toBe(1);
    expect(out.registered).toBe(0);
    expect(pullSpy).not.toHaveBeenCalled();
    expect(registerSpy).not.toHaveBeenCalled();
  });
});

describe("sweepE3nRecordings — pull failure is fail-safe", () => {
  it("a null pull (not-ready or a real failure) never registers and never marks — retried next tick", async () => {
    const registerSpy = vi.fn(async () => ({ ok: true }));
    const deps = baseDeps({ pullToR2: async () => null, register: registerSpy });
    const out = await sweepE3nRecordings(deps);
    expect(out.pullPending).toBe(1);
    expect(out.registered).toBe(0);
    expect(registerSpy).not.toHaveBeenCalled();
    expect(deps.registeredSet.has("v1")).toBe(false);
  });

  it("a register failure leaves bytes durable but does NOT mark registered — retried, never double-billed by marking", async () => {
    const deps = baseDeps({ register: async () => ({ ok: false }) });
    const out = await sweepE3nRecordings(deps);
    expect(out.registerFailed).toBe(1);
    expect(out.registered).toBe(0);
    expect(deps.registeredSet.has("v1")).toBe(false);
  });
});

describe("sweepE3nRecordings — re-sweep idempotency", () => {
  it("an already-registered video is skipped before any pull/register call on the next tick", async () => {
    const pullSpy = vi.fn(async () => ({ r2Key: "x", bucket: "b" }));
    const registerSpy = vi.fn(async () => ({ ok: true }));
    const deps = baseDeps({ pullToR2: pullSpy, register: registerSpy });

    const first = await sweepE3nRecordings(deps);
    expect(first.registered).toBe(1);

    pullSpy.mockClear();
    registerSpy.mockClear();
    const second = await sweepE3nRecordings(deps);
    expect(second.alreadyRegistered).toBe(1);
    expect(second.registered).toBe(0);
    expect(pullSpy).not.toHaveBeenCalled();
    expect(registerSpy).not.toHaveBeenCalled();
  });
});

describe("sweepE3nRecordings — list failures don't abort the tick", () => {
  it("a listVideosForInput failure on one input is skipped; other inputs still process", async () => {
    const deps = baseDeps({
      listLiveInputs: async () => [{ uid: "bad" }, { uid: "in1" }],
      listVideosForInput: async (uid) => (uid === "bad" ? null : [completedVideo("v1")]),
    });
    const out = await sweepE3nRecordings(deps);
    expect(out.scanned).toBe(2);
    expect(out.registered).toBe(1);
  });
});

describe("isCompletedRecording sanity (imported for cross-module contract check)", () => {
  it("matches the sweep's own gate", () => {
    expect(isCompletedRecording(completedVideo("v1"))).toBe(true);
  });
});
