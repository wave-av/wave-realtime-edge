// #35 — LL-HLS source leg tests. Pure: injected spawn + dgram socket factory, NO real ffmpeg, NO real UDP.
// Proves the ORCHESTRATION (ffmpeg argv, socket binding, track production, state transitions, teardown);
// the live RTP forwarding fidelity is a ◆ go-live proof (§7.6), out of unit-test scope.
import { describe, it, expect, vi } from "vitest";
import { hlsPull, ffmpegArgs, VIDEO_RTP_PORT, AUDIO_RTP_PORT } from "../server/hls-source.mjs";

const SRC = "https://customer-abc.cloudflarestream.com/uid123/manifest/video.m3u8?protocol=llhls";

/** A fake dgram socket capturing handlers + bind port; emit(ev,...) drives events from the test. */
function makeFakeSocket() {
  const h = {};
  return {
    boundPort: null,
    on: (ev, cb) => { h[ev] = cb; },
    bind: function (port, _addr, cb) { this.boundPort = port; cb?.(); },
    close: vi.fn(),
    emit: (ev, ...a) => h[ev]?.(...a),
  };
}

/** A fake child_process handle; _emit(ev,...) drives exit/error from the test. */
function makeFakeFfmpeg() {
  const h = {};
  const se = {};
  return {
    stderr: { on: (ev, cb) => { se[ev] = cb; } },
    on: (ev, cb) => { h[ev] = cb; },
    kill: vi.fn(),
    _emit: (ev, ...a) => h[ev]?.(...a),
  };
}

// werift-free fakes for the injected primitives.
const makeTrack = (kind) => ({ kind, writeRtp: vi.fn() });
const parseRtp = (buf) => buf; // identity — the module only forwards the parsed value to writeRtp

function harness() {
  const sockets = [];
  const socketFactory = () => { const s = makeFakeSocket(); sockets.push(s); return s; };
  const ff = makeFakeFfmpeg();
  const spawnFn = vi.fn(() => ff);
  const base = { srcUrl: SRC, makeTrack, parseRtp, spawnFn, socketFactory };
  return { sockets, socketFactory, ff, spawnFn, base };
}

describe("ffmpegArgs — pure argv builder", () => {
  it("decodes the source to VP8+Opus RTP on the two localhost ports", () => {
    const args = ffmpegArgs(SRC);
    expect(args).toContain("-i");
    expect(args[args.indexOf("-i") + 1]).toBe(SRC);
    expect(args).toContain("libvpx");
    expect(args).toContain("libopus");
    expect(args).toContain(`rtp://127.0.0.1:${VIDEO_RTP_PORT}`);
    expect(args).toContain(`rtp://127.0.0.1:${AUDIO_RTP_PORT}`);
    expect(args).toContain("-re"); // wall-clock pacing (live)
  });

  it("injects an Authorization header ONLY when a signed-source auth is given", () => {
    expect(ffmpegArgs(SRC)).not.toContain("-headers");
    const authed = ffmpegArgs(SRC, "tok_signed");
    expect(authed).toContain("-headers");
    expect(authed[authed.indexOf("-headers") + 1]).toContain("Bearer tok_signed");
  });
});

describe("hlsPull — source leg orchestration", () => {
  it("spawns ffmpeg, binds both RTP sockets, and produces a video + audio track", async () => {
    const { base, sockets, spawnFn } = harness();
    const onTrack = vi.fn();
    await hlsPull({ ...base, onTrack, onState: vi.fn() });

    expect(spawnFn).toHaveBeenCalledOnce();
    expect(spawnFn.mock.calls[0][0]).toBe("ffmpeg");
    expect(sockets.map((s) => s.boundPort).sort()).toEqual([VIDEO_RTP_PORT, AUDIO_RTP_PORT].sort());
    expect(onTrack).toHaveBeenCalledTimes(2);
    expect(onTrack.mock.calls.map((c) => c[0].kind).sort()).toEqual(["audio", "video"]);
  });

  it("fires onState('connected') on the FIRST datagram (before writeRtp/attach)", async () => {
    const { base, sockets } = harness();
    const onState = vi.fn();
    await hlsPull({ ...base, onTrack: vi.fn(), onState });

    expect(onState).not.toHaveBeenCalled(); // no media yet
    sockets[0].emit("message", Buffer.alloc(12)); // minimal RTP header; writeRtp is best-effort/caught
    expect(onState).toHaveBeenCalledWith("connected");
    sockets[1].emit("message", Buffer.alloc(12)); // second packet must NOT re-signal
    expect(onState).toHaveBeenCalledTimes(1);
  });

  it("fires onState('failed') when ffmpeg exits non-zero and we did NOT stop it", async () => {
    const { base, ff } = harness();
    const onState = vi.fn();
    await hlsPull({ ...base, onTrack: vi.fn(), onState });

    ff._emit("exit", 1);
    expect(onState).toHaveBeenCalledWith("failed");
  });

  it("treats a CLEAN ffmpeg exit (code 0) mid-relay as a failure — a live source ending is not success", async () => {
    const { base, ff } = harness();
    const onState = vi.fn();
    await hlsPull({ ...base, onTrack: vi.fn(), onState });

    ff._emit("exit", 0);
    expect(onState).toHaveBeenCalledWith("failed");
  });

  it("fires onState('failed') + closes the socket on a MID-RELAY (post-bind) socket error, not silently", async () => {
    const { base, sockets } = harness();
    const onState = vi.fn();
    await hlsPull({ ...base, onTrack: vi.fn(), onState }); // bind resolved → settled

    sockets[0].emit("error", new Error("EADDRNOTAVAIL mid-stream"));
    expect(onState).toHaveBeenCalledWith("failed");
    expect(sockets[0].close).toHaveBeenCalled();
  });

  it("stop() kills ffmpeg + closes both sockets, and suppresses the ensuing exit as NOT a failure", async () => {
    const { base, sockets, ff } = harness();
    const onState = vi.fn();
    const handle = await hlsPull({ ...base, onTrack: vi.fn(), onState });

    await handle.stop();
    await handle.stop(); // idempotent
    expect(ff.kill).toHaveBeenCalledOnce();
    expect(ff.kill).toHaveBeenCalledWith("SIGTERM");
    for (const s of sockets) expect(s.close).toHaveBeenCalled();

    ff._emit("exit", 143); // SIGTERM exit AFTER stop → must NOT be reported as a source failure
    expect(onState).not.toHaveBeenCalledWith("failed");
  });

  it("requires srcUrl / makeTrack / parseRtp (guards)", async () => {
    const { base } = harness();
    await expect(hlsPull({ ...base, srcUrl: undefined, onTrack: vi.fn(), onState: vi.fn() }))
      .rejects.toThrow(/srcUrl is required/);
    await expect(hlsPull({ ...base, makeTrack: undefined, onTrack: vi.fn(), onState: vi.fn() }))
      .rejects.toThrow(/makeTrack is required/);
    await expect(hlsPull({ ...base, parseRtp: undefined, onTrack: vi.fn(), onState: vi.fn() }))
      .rejects.toThrow(/parseRtp is required/);
  });
});
