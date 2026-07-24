// E3n (wre#290) Axis A2 — the cron-sweep correlate→pull→register orchestration. Pure: every dependency is
// injected, no real CF/KV/R2/gateway network. Covers: happy path, missing org KV, pull failure (fail-safe, no
// double-register), and re-sweep idempotency (a re-tick never re-pulls/re-registers an already-landed video).
import { describe, it, expect, vi, afterEach } from "vitest";
import {
  sweepE3nRecordings,
  liveE3nSweepDeps,
  E3N_SOURCE_PROTOCOL,
  type E3nSweepDeps,
  type E3nSweepRuntimeEnv,
} from "../src/e3n-recording-sweep.js";
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
    zone: "us-east",
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
    expect(registerSpy).toHaveBeenCalledWith({
      org: "org-1",
      r2Key: "org-1/e3n-recordings/v1/recording.mp4",
      bucket: "wave-recordings-enam",
      zone: "us-east",
      sourceProtocol: E3N_SOURCE_PROTOCOL,
    });
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

describe("sweepE3nRecordings — cross-tenant leak guard (F1 CRITICAL)", () => {
  it("when CF's list is unfiltered (multiple live inputs' videos returned), pulls/registers ONLY the video whose liveInput matches the swept uid", async () => {
    // This is the exact bug: `listVideosForInput` (in production, CF's list endpoint) returns the WHOLE
    // account's videos rather than just this live input's — the mock the author's tests missed.
    const foreignVideo: CfVideoSummary = { uid: "v-foreign", liveInput: "in-OTHER-ORG", readyToStream: true, state: "ready", duration: 10, created: null };
    const matchingVideo: CfVideoSummary = completedVideo("v-mine");
    const pullSpy = vi.fn(async (video: CfVideoSummary, org: string) => ({
      r2Key: `${org}/e3n-recordings/${video.uid}/recording.mp4`,
      bucket: "wave-recordings-enam",
    }));
    const registerSpy = vi.fn(async () => ({ ok: true }));
    const deps = baseDeps({
      listVideosForInput: async () => [foreignVideo, matchingVideo],
      pullToR2: pullSpy,
      register: registerSpy,
    });

    const out = await sweepE3nRecordings(deps);

    expect(out.completed).toBe(1); // the foreign video never even counts as "completed" for this input
    expect(pullSpy).toHaveBeenCalledTimes(1);
    expect(pullSpy).toHaveBeenCalledWith(matchingVideo, "org-1");
    expect(registerSpy).toHaveBeenCalledTimes(1);
    expect(registerSpy).toHaveBeenCalledWith(
      expect.objectContaining({ r2Key: "org-1/e3n-recordings/v-mine/recording.mp4" }),
    );
    expect(deps.registeredSet.has("v-foreign")).toBe(false);
    expect(deps.registeredSet.has("v-mine")).toBe(true);
  });
});

describe("sweepE3nRecordings — explicit sourceProtocol (F4)", () => {
  it("register() always carries the CF-Stream-recording sourceProtocol, never the WHIP default", async () => {
    const registerSpy = vi.fn(async () => ({ ok: true }));
    const deps = baseDeps({ register: registerSpy });
    await sweepE3nRecordings(deps);
    expect(registerSpy).toHaveBeenCalledWith(expect.objectContaining({ sourceProtocol: E3N_SOURCE_PROTOCOL }));
    expect(E3N_SOURCE_PROTOCOL).not.toBe("whip");
  });
});

describe("liveE3nSweepDeps — region disable-gate (F2)", () => {
  afterEach(() => {
    vi.doUnmock("../src/region-registry.js");
    vi.resetModules();
  });

  const fullyConfiguredEnv = (): E3nSweepRuntimeEnv => ({
    E3N_AUTORECORD_ENABLED: "1",
    CF_ACCOUNT_ID: "acct",
    CF_STREAM_API_TOKEN: "tok",
    RT_MEETING_ORG: {} as unknown as KVNamespace,
    RT_RECORDINGS_ENAM: {} as unknown as R2Bucket,
    WAVE_GATEWAY_ORIGIN: "https://gw.example",
    WAVE_SERVICE_TOKEN: "svc",
  });

  it("is null (INERT, no literal fallback) once regionForBinding('RT_RECORDINGS_ENAM') returns null", async () => {
    vi.resetModules();
    vi.doMock("../src/region-registry.js", () => ({ regionForBinding: () => null }));
    const { liveE3nSweepDeps: liveDepsWithDisabledRegion } = await import("../src/e3n-recording-sweep.js");
    const deps = liveDepsWithDisabledRegion(fullyConfiguredEnv());
    expect(deps).toBeNull();
  });

  it("is non-null with a real region resolved (control: every other binding present)", () => {
    const deps = liveE3nSweepDeps(fullyConfiguredEnv());
    expect(deps).not.toBeNull();
    expect(deps?.zone).toBe("us-east");
  });
});
