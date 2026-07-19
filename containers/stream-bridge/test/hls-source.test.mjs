// #35 — LL-HLS source leg tests. Pure: injected spawn + dgram socket factory, NO real ffmpeg, NO real UDP.
// Proves the ORCHESTRATION (ffmpeg argv, socket binding, track production, state transitions, teardown);
// the live RTP forwarding fidelity is a ◆ go-live proof (§7.6), out of unit-test scope.
import { describe, it, expect, vi } from "vitest";
import { hlsPull, ffmpegArgs, probeHasAudio } from "../server/hls-source.mjs";

// #230: RTP ports are OS-assigned per relay, so the argv tests pass explicit ports instead of importing constants.
const PORTS = { video: 50001, audio: 50002 };

const SRC = "https://customer-abc.cloudflarestream.com/uid123/manifest/video.m3u8?protocol=llhls";

/**
 * A fake dgram socket capturing handlers + bind port; emit(ev,...) drives events from the test.
 * Models the real kernel contract for #230: the caller asks for port 0 and the OS hands back a distinct
 * ephemeral port, readable via `address()`. `nextEphemeral` is a module-level counter so two relays in the
 * same test observably get DIFFERENT ports — which is the whole point of the fix.
 */
let nextEphemeral = 49152; // start of the IANA ephemeral range
function makeFakeSocket() {
  const h = {};
  return {
    boundPort: null,
    on: (ev, cb) => { h[ev] = cb; },
    bind: function (port, _addr, cb) { this.boundPort = port === 0 ? nextEphemeral++ : port; cb?.(); },
    address: function () { return { address: "127.0.0.1", port: this.boundPort }; },
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
  // `hasAudio: true` pins the audio-bearing source these orchestration tests were written for, bypassing the ffprobe
  // round-trip. The probe itself and the video-only path get their own dedicated blocks below.
  const base = { srcUrl: SRC, makeTrack, parseRtp, spawnFn, socketFactory, hasAudio: true };
  return { sockets, socketFactory, ff, spawnFn, base };
}

/** A fake ffprobe handle: `stdoutData` is emitted, then `exit` fires with `code`. */
function makeFakeProbe(stdoutData, code) {
  const h = {};
  const so = {};
  const proc = {
    stdout: { on: (ev, cb) => { so[ev] = cb; } },
    on: (ev, cb) => {
      h[ev] = cb;
      // Drive the probe to completion on the next tick, once both listeners are attached.
      if (ev === "exit") {
        queueMicrotask(() => {
          if (stdoutData) so.data?.(stdoutData);
          h.exit?.(code);
        });
      }
    },
    kill: vi.fn(),
  };
  return proc;
}

describe("ffmpegArgs — pure argv builder", () => {
  it("decodes the source to VP8+Opus RTP on the two localhost ports", () => {
    const args = ffmpegArgs(SRC, undefined, true, PORTS);
    expect(args).toContain("-i");
    expect(args[args.indexOf("-i") + 1]).toBe(SRC);
    expect(args).toContain("libvpx");
    expect(args).toContain("libopus");
    expect(args).toContain(`rtp://127.0.0.1:${PORTS.video}`);
    expect(args).toContain(`rtp://127.0.0.1:${PORTS.audio}`);
    expect(args).toContain("-re"); // wall-clock pacing (live)
  });

  it("injects an Authorization header ONLY when a signed-source auth is given", () => {
    expect(ffmpegArgs(SRC, undefined, true, PORTS)).not.toContain("-headers");
    const authed = ffmpegArgs(SRC, "tok_signed", true, PORTS);
    expect(authed).toContain("-headers");
    expect(authed[authed.indexOf("-headers") + 1]).toContain("Bearer tok_signed");
  });

  it("omits the ENTIRE audio output leg for a video-only source (#2 — the 502 bug)", () => {
    const args = ffmpegArgs(SRC, undefined, false, PORTS);
    // The video leg is untouched...
    expect(args).toContain("libvpx");
    expect(args).toContain(`rtp://127.0.0.1:${PORTS.video}`);
    // ...and NOTHING audio remains. A bare `-map 0:a:0?` would leave an output that maps zero streams, which makes
    // ffmpeg abort with "Output file #1 does not contain any stream" — the startup failure this fix exists to kill.
    expect(args).not.toContain("libopus");
    expect(args).not.toContain(`rtp://127.0.0.1:${PORTS.audio}`);
    expect(args.filter((a) => a === "-f")).toHaveLength(1);
  });

  it("marks the audio map optional when audio IS expected (tolerates a mid-flight re-ladder)", () => {
    expect(ffmpegArgs(SRC, undefined, true, PORTS)).toContain("0:a:0?");
  });
});

describe("probeHasAudio — video-only detection", () => {
  it("returns false when ffprobe exits 0 listing no audio streams", async () => {
    const spawnFn = vi.fn(() => makeFakeProbe("", 0));
    await expect(probeHasAudio(SRC, undefined, { spawnFn })).resolves.toBe(false);
    expect(spawnFn.mock.calls[0][0]).toBe("ffprobe");
    expect(spawnFn.mock.calls[0][1]).toContain("a"); // -select_streams a
  });

  it("returns true when ffprobe reports an audio stream index", async () => {
    const spawnFn = vi.fn(() => makeFakeProbe("1\n", 0));
    await expect(probeHasAudio(SRC, undefined, { spawnFn })).resolves.toBe(true);
  });

  it("FAILS SAFE to true on a non-zero probe exit — never silently drops real audio", async () => {
    const spawnFn = vi.fn(() => makeFakeProbe("", 1));
    await expect(probeHasAudio(SRC, undefined, { spawnFn })).resolves.toBe(true);
  });

  it("FAILS SAFE to true when ffprobe cannot be spawned at all", async () => {
    const spawnFn = vi.fn(() => { throw new Error("ENOENT ffprobe"); });
    await expect(probeHasAudio(SRC, undefined, { spawnFn })).resolves.toBe(true);
  });

  it("FAILS SAFE to true on timeout, and kills the hung probe", async () => {
    const proc = { stdout: { on: vi.fn() }, on: vi.fn(), kill: vi.fn() };
    const spawnFn = vi.fn(() => proc);
    await expect(probeHasAudio(SRC, undefined, { spawnFn, timeoutMs: 5 })).resolves.toBe(true);
    expect(proc.kill).toHaveBeenCalledWith("SIGKILL");
  });

  it("mirrors the signed-source Bearer into the probe", async () => {
    const spawnFn = vi.fn(() => makeFakeProbe("1\n", 0));
    await probeHasAudio(SRC, "tok_signed", { spawnFn });
    expect(spawnFn.mock.calls[0][1].join(" ")).toContain("Bearer tok_signed");
  });
});

describe("hlsPull — source leg orchestration", () => {
  it("spawns ffmpeg, binds both RTP sockets, and produces a video + audio track", async () => {
    const { base, sockets, spawnFn } = harness();
    const onTrack = vi.fn();
    await hlsPull({ ...base, onTrack, onState: vi.fn() });

    expect(spawnFn).toHaveBeenCalledOnce();
    expect(spawnFn.mock.calls[0][0]).toBe("ffmpeg");
    // #230: both legs bind OS-assigned ports, and — critically — the ffmpeg argv points at the ports we actually
    // hold. Asserting the argv (not just the binds) is what catches a relay that comes up but sends RTP nowhere.
    const bound = sockets.map((s) => s.boundPort);
    expect(bound.every((p) => p > 0)).toBe(true);
    expect(new Set(bound).size).toBe(2); // never the same port twice
    const argv = spawnFn.mock.calls[0][1].join(" ");
    for (const p of bound) expect(argv).toContain(`rtp://127.0.0.1:${p}`);
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

  it("bridges a VIDEO-ONLY source: one track, one socket, no audio args (#2 regression)", async () => {
    const { sockets, ff } = harness();
    const spawnFn = vi.fn(() => ff);
    const socketFactory = () => { const s = makeFakeSocket(); sockets.push(s); return s; };
    const onTrack = vi.fn();
    const onState = vi.fn();

    await hlsPull({
      srcUrl: SRC, makeTrack, parseRtp, spawnFn, socketFactory, onTrack, onState,
      probeFn: async () => false, // the source carries no audio
    });

    // Exactly one track and one bound socket — and crucially NO onState('failed'): the old hard `-map 0:a:0`
    // made ffmpeg exit at startup here, which surfaced as the container /start 502.
    expect(onTrack).toHaveBeenCalledTimes(1);
    expect(onTrack.mock.calls[0][0].kind).toBe("video");
    expect(sockets).toHaveLength(1);
    expect(sockets[0].boundPort).toBeGreaterThan(0);
    expect(onState).not.toHaveBeenCalledWith("failed");
    expect(spawnFn.mock.calls[0][1]).not.toContain("libopus");
  });

  it("consults the probe when hasAudio is not pre-declared", async () => {
    const { base } = harness();
    const probeFn = vi.fn(async () => true);
    const { hasAudio: _pinned, ...noPin } = base;
    const onTrack = vi.fn();
    await hlsPull({ ...noPin, onTrack, onState: vi.fn(), probeFn });

    expect(probeFn).toHaveBeenCalledOnce();
    expect(probeFn.mock.calls[0][0]).toBe(SRC);
    expect(onTrack).toHaveBeenCalledTimes(2);
  });
});

describe("hlsPull — RTP ports are per-relay, never fixed (#230)", () => {
  it("two concurrent relays bind four DISTINCT ports — the EADDRINUSE ceiling is gone", async () => {
    // THE regression. With fixed 5004/5006 the second relay's bind failed with
    // `bind EADDRINUSE 127.0.0.1:5004`, surfaced as a container /start 502 — so a second customer
    // broadcasting concurrently simply could not be bridged. Observed live 2026-07-18.
    const a = harness();
    const b = harness();
    await hlsPull({ ...a.base, onTrack: vi.fn(), onState: vi.fn() });
    await hlsPull({ ...b.base, onTrack: vi.fn(), onState: vi.fn() });

    const ports = [...a.sockets, ...b.sockets].map((s) => s.boundPort);
    expect(ports).toHaveLength(4);
    expect(new Set(ports).size).toBe(4); // no overlap between relays
    // ...and each relay's ffmpeg targets ITS OWN pair, not the other's.
    const argvA = a.spawnFn.mock.calls[0][1].join(" ");
    for (const p of b.sockets.map((s) => s.boundPort)) expect(argvA).not.toContain(`127.0.0.1:${p}`);
  });

  it("asks the OS for a port (bind 0) rather than claiming a well-known one", async () => {
    const { base, sockets } = harness();
    const bindSpy = [];
    const socketFactory = () => {
      const s = makeFakeSocket();
      const realBind = s.bind.bind(s);
      s.bind = (port, addr, cb) => { bindSpy.push(port); return realBind(port, addr, cb); };
      sockets.push(s);
      return s;
    };
    await hlsPull({ ...base, socketFactory, onTrack: vi.fn(), onState: vi.fn() });
    expect(bindSpy).toEqual([0, 0]); // never a hardcoded port
  });

  it("refuses to spawn ffmpeg if a socket cannot report its bound port — no silent dead air", async () => {
    // Guessing a port here would produce a relay that looks up while ffmpeg sends RTP into a void:
    // the silent-no-op failure class that hid #235 and #241. It must fail loud instead.
    const { base } = harness();
    const spawnFn = vi.fn(() => makeFakeFfmpeg());
    const socketFactory = () => {
      const s = makeFakeSocket();
      s.address = () => ({ address: "127.0.0.1", port: 0 }); // kernel reported nothing usable
      return s;
    };
    await expect(hlsPull({ ...base, spawnFn, socketFactory, onTrack: vi.fn(), onState: vi.fn() }))
      .rejects.toThrow(/did not report a bound port/);
    expect(spawnFn).not.toHaveBeenCalled();
  });

  it("ffmpegArgs refuses to build argv without ports — the fixed-port default cannot come back", () => {
    expect(() => ffmpegArgs(SRC, undefined, true)).toThrow(/ports\.video is required/);
    expect(() => ffmpegArgs(SRC, undefined, true, { video: 50001 })).toThrow(/ports\.audio is required/);
    // video-only needs no audio port
    expect(() => ffmpegArgs(SRC, undefined, false, { video: 50001 })).not.toThrow();
  });
});
