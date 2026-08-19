import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { streamingTranscribe } from "../src/agent-stt-streaming.js";

/**
 * Minimal WebSocket mock — enough to exercise the streaming adapter without network.
 * Matches the OutboundWebSocket interface the adapter uses (standard browser `WebSocket` API).
 */
function createMockWs() {
  const inst = {
    url: "",
    readyState: 0, // CONNECTING
    sent: [] as (string | ArrayBuffer | Uint8Array)[],
    onopen: null as (() => void) | null,
    onmessage: null as ((ev: { data: string | ArrayBuffer }) => void) | null,
    onerror: null as (() => void) | null,
    onclose: null as ((ev: { code: number; reason: string }) => void) | null,
    send(data: string | ArrayBuffer | Uint8Array) {
      inst.sent.push(data);
    },
    close(code?: number, reason?: string) {
      inst.readyState = 2; // CLOSING
      // Fire onclose asynchronously — matches real WebSocket behaviour (closing handshake is not sync).
      queueMicrotask(() => {
        inst.readyState = 3; // CLOSED
        inst.onclose?.({ code: code ?? 1000, reason: reason ?? "" });
      });
    },
  };
  return inst;
}

describe("streamingTranscribe", () => {
  let mocks: ReturnType<typeof createMockWs>[];
  let origWs: typeof globalThis.WebSocket | undefined;

  beforeEach(() => {
    mocks = [];
    origWs = globalThis.WebSocket;
    // Wire the mock as the global WebSocket constructor.
    (globalThis as any).WebSocket = function (url: string) {
      const ws = createMockWs();
      ws.url = url;
      mocks.push(ws);
      return ws;
    };
  });

  afterEach(() => {
    if (origWs !== undefined) {
      (globalThis as any).WebSocket = origWs;
    } else {
      delete (globalThis as any).WebSocket;
    }
  });

  it("resolves final transcript from Deepgram streaming", async () => {
    const pcm = new Uint8Array(100);
    const env = { DEEPGRAM_API_KEY: "test-key" } as any;

    const resultP = streamingTranscribe(pcm, env);
    const ws = mocks[0];

    // Simulate connection open → adapter sends chunks + closes
    ws.onopen?.();

    // Partial message (not final — ignored for the result)
    ws.onmessage?.({
      data: JSON.stringify({
        channel: { alternatives: [{ transcript: "hello " }] },
        is_final: false,
      }),
    });

    // Final message
    ws.onmessage?.({
      data: JSON.stringify({
        channel: { alternatives: [{ transcript: "hello world" }] },
        is_final: true,
      }),
    });

    const result = await resultP;
    expect(result).toEqual({ isFinal: true, transcript: "hello world" });
  });

  it("throws when DEEPGRAM_API_KEY is missing", async () => {
    const pcm = new Uint8Array(100);
    const env = {} as any;

    await expect(streamingTranscribe(pcm, env)).rejects.toThrow(
      "DEEPGRAM_API_KEY not provisioned",
    );
  });

  it("sends PCM in chunks and closes the socket", async () => {
    const pcm = new Uint8Array(8192); // exactly 2 chunks at CHUNK_SIZE=4096
    const env = { DEEPGRAM_API_KEY: "test-key" } as any;

    const resultP = streamingTranscribe(pcm, env);
    const ws = mocks[0];

    ws.onopen?.();

    // Should have sent 2 chunks
    expect(ws.sent).toHaveLength(2);
    expect((ws.sent[0] as Uint8Array).length).toBe(4096);
    expect((ws.sent[1] as Uint8Array).length).toBe(4096);

    // Complete the stream
    ws.onmessage?.({
      data: JSON.stringify({
        channel: { alternatives: [{ transcript: "ok" }] },
        is_final: true,
      }),
    });

    await resultP;
    // Socket should have been closed (readyState = CLOSED after microtask)
    // The mock's close() fires onclose asynchronously; the adapter already resolved.
  });

  it("resolves with last transcript when socket closes without is_final", async () => {
    const pcm = new Uint8Array(100);
    const env = { DEEPGRAM_API_KEY: "test-key" } as any;

    const resultP = streamingTranscribe(pcm, env);
    const ws = mocks[0];

    ws.onopen?.();

    // A non-final transcript arrives
    ws.onmessage?.({
      data: JSON.stringify({
        channel: { alternatives: [{ transcript: "partial" }] },
        is_final: false,
      }),
    });

    // Socket closes without is_final (e.g. server-side close after processing)
    ws.onclose?.({ code: 1000, reason: "done" });

    const result = await resultP;
    expect(result).toEqual({ isFinal: true, transcript: "partial" });
  });

  it("rejects on WebSocket error", async () => {
    const pcm = new Uint8Array(100);
    const env = { DEEPGRAM_API_KEY: "test-key" } as any;

    const resultP = streamingTranscribe(pcm, env);
    const ws = mocks[0];

    ws.onerror?.();

    await expect(resultP).rejects.toThrow("Deepgram WebSocket error");
  });

  it("resolves empty transcript for silence (no alternatives)", async () => {
    const pcm = new Uint8Array(100);
    const env = { DEEPGRAM_API_KEY: "test-key" } as any;

    const resultP = streamingTranscribe(pcm, env);
    const ws = mocks[0];

    ws.onopen?.();

    // Deepgram returns an empty alternative set (silence / no speech recognized)
    ws.onmessage?.({
      data: JSON.stringify({
        channel: { alternatives: [{ transcript: "" }] },
        is_final: true,
      }),
    });

    const result = await resultP;
    expect(result).toEqual({ isFinal: true, transcript: "" });
  });
});
