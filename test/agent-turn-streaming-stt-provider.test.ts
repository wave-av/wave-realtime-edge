// E1 (elevenlabs-surface-adoption epic, #4081) — buildTurnDeps streaming STT PROVIDER selection.
// Proves: (1) VOICE_AGENT_STREAMING_STT_PROVIDER unset -> identical Deepgram streaming path
// (byte-identical to pre-E1 behavior); (2) "elevenlabs" -> routes to the new Scribe Realtime
// adapter; (3) an ElevenLabs error -> fails CLOSED, falls back to Deepgram (never drops the turn).
// Every WebSocket/fetch is a FAKE — no live network.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { buildTurnDeps, type AgentTurnEnv } from "../src/agent-turn.js";
import type { AgentMediaDeps } from "../src/agent-session.js";

const media: AgentMediaDeps = {
  createEgress: vi.fn(),
  createIngest: vi.fn(),
  ingestSocket: () => null,
  now: () => 0,
  log: () => {},
};

/** Minimal fake Deepgram outbound WebSocket — mirrors test/agent-stt-streaming.test.ts's mock. */
function createMockDeepgramWs() {
  const inst = {
    url: "",
    sent: [] as unknown[],
    onopen: null as (() => void) | null,
    onmessage: null as ((ev: { data: string | ArrayBuffer }) => void) | null,
    onerror: null as (() => void) | null,
    onclose: null as ((ev: { code: number; reason: string }) => void) | null,
    send(data: unknown) {
      inst.sent.push(data);
    },
    close() {
      queueMicrotask(() => inst.onclose?.({ code: 1000, reason: "" }));
    },
  };
  return inst;
}

async function flushMicrotasks() {
  await Promise.resolve();
  await Promise.resolve();
}

describe("buildTurnDeps — streaming STT provider selection (VOICE_AGENT_STREAMING_STT_PROVIDER)", () => {
  let mocks: ReturnType<typeof createMockDeepgramWs>[];
  let origWs: typeof globalThis.WebSocket | undefined;

  beforeEach(() => {
    mocks = [];
    origWs = globalThis.WebSocket;
    (globalThis as any).WebSocket = function (url: string) {
      const ws = createMockDeepgramWs();
      ws.url = url;
      mocks.push(ws);
      return ws;
    };
  });

  afterEach(() => {
    if (origWs !== undefined) (globalThis as any).WebSocket = origWs;
    else delete (globalThis as any).WebSocket;
  });

  it("PROVIDER unset -> identical Deepgram streaming path (byte-identical to pre-E1 default)", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("ElevenLabs fetch should NEVER be called when provider is unset");
    });
    const env: AgentTurnEnv = {
      VOICE_AGENT_STREAMING_STT: "true",
      DEEPGRAM_API_KEY: "dg-key",
      ELEVENLABS_API_KEY: "el-key", // present but must be ignored — provider unset means Deepgram
    };
    const resultP = buildTurnDeps(env, media, fetchImpl).transcribe(new Uint8Array(16));
    await flushMicrotasks();

    expect(mocks).toHaveLength(1);
    expect(mocks[0]!.url).toContain("wss://api.deepgram.com");
    expect(fetchImpl).not.toHaveBeenCalled();

    mocks[0]!.onopen?.();
    mocks[0]!.onmessage?.({
      data: JSON.stringify({ channel: { alternatives: [{ transcript: "hi" }] }, is_final: true }),
    });
    await expect(resultP).resolves.toEqual({ isFinal: true, transcript: "hi" });
  });

  it("PROVIDER=elevenlabs -> routes to the Scribe v2 Realtime adapter (not Deepgram)", async () => {
    const fetchImpl = vi.fn(async () => {
      const sock = {
        accept: vi.fn(),
        send: vi.fn(),
        close: vi.fn(),
        addEventListener: vi.fn((type: string, cb: (ev: any) => void) => {
          if (type === "message") {
            // setTimeout (a macrotask), not queueMicrotask — guarantees this fires AFTER the
            // caller finishes wiring ws.onmessage in the same synchronous turn (matches how a
            // real network message always arrives strictly later than local wiring, never racing
            // a same-tick microtask against registration).
            setTimeout(
              () => cb({ data: JSON.stringify({ message_type: "committed_transcript", text: "from elevenlabs" }) }),
              0,
            );
          }
        }),
      };
      return { status: 101, webSocket: sock } as any;
    });
    const env: AgentTurnEnv = {
      VOICE_AGENT_STREAMING_STT: "true",
      VOICE_AGENT_STREAMING_STT_PROVIDER: "elevenlabs",
      ELEVENLABS_API_KEY: "el-key",
      DEEPGRAM_API_KEY: "dg-key",
    };

    const result = await buildTurnDeps(env, media, fetchImpl).transcribe(new Uint8Array(16));

    expect(result).toEqual({ isFinal: true, transcript: "from elevenlabs" });
    expect(fetchImpl).toHaveBeenCalled();
    const url = (fetchImpl.mock.calls[0] as unknown as [string])[0];
    expect(url).toContain("wss://api.elevenlabs.io/v1/speech-to-text/realtime");
    expect(mocks).toHaveLength(0); // Deepgram WebSocket never opened
  });

  it("PROVIDER=elevenlabs + ElevenLabs error -> fails CLOSED, falls back to Deepgram (turn not dropped)", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("simulated ElevenLabs upgrade failure");
    });
    const env: AgentTurnEnv = {
      VOICE_AGENT_STREAMING_STT: "true",
      VOICE_AGENT_STREAMING_STT_PROVIDER: "elevenlabs",
      ELEVENLABS_API_KEY: "el-key",
      DEEPGRAM_API_KEY: "dg-key",
    };

    const resultP = buildTurnDeps(env, media, fetchImpl).transcribe(new Uint8Array(16));
    await flushMicrotasks();
    await flushMicrotasks();

    // The ElevenLabs attempt failed closed and the code fell back to the Deepgram streaming path.
    expect(mocks).toHaveLength(1);
    expect(mocks[0]!.url).toContain("wss://api.deepgram.com");

    mocks[0]!.onopen?.();
    mocks[0]!.onmessage?.({
      data: JSON.stringify({ channel: { alternatives: [{ transcript: "fallback ok" }] }, is_final: true }),
    });
    await expect(resultP).resolves.toEqual({ isFinal: true, transcript: "fallback ok" });
  });

  it("PROVIDER=elevenlabs + missing ELEVENLABS_API_KEY -> fails CLOSED, falls back to Deepgram", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("should not be called — key missing short-circuits before fetch");
    });
    const env: AgentTurnEnv = {
      VOICE_AGENT_STREAMING_STT: "true",
      VOICE_AGENT_STREAMING_STT_PROVIDER: "elevenlabs",
      DEEPGRAM_API_KEY: "dg-key",
      // ELEVENLABS_API_KEY intentionally unset
    };

    const resultP = buildTurnDeps(env, media, fetchImpl).transcribe(new Uint8Array(16));
    await flushMicrotasks();

    expect(mocks).toHaveLength(1);
    expect(mocks[0]!.url).toContain("wss://api.deepgram.com");
    mocks[0]!.onopen?.();
    mocks[0]!.onmessage?.({
      data: JSON.stringify({ channel: { alternatives: [{ transcript: "no key fallback" }] }, is_final: true }),
    });
    await expect(resultP).resolves.toEqual({ isFinal: true, transcript: "no key fallback" });
  });
});
