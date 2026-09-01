// E1 (elevenlabs-surface-adoption epic, #4081) — ElevenLabs Scribe v2 Realtime streaming STT
// adapter. Every WebSocket is a FAKE (via a faked fetch()-upgrade Response) — no live network.
import { describe, it, expect, vi } from "vitest";
import {
  streamingTranscribeElevenLabs,
  downmixStereo16LEToMono,
} from "../src/agent-stt-elevenlabs-realtime.js";

/**
 * Minimal fake CF Workers-upgraded WebSocket — enough to exercise the adapter's fetch()-upgrade
 * path without a real WebSocket global or a live network. Mirrors the `.accept()` /
 * `.addEventListener()` shape `response.webSocket` carries in the Workers runtime.
 */
function createFakeRawSocket() {
  const listeners: Record<string, ((ev: any) => void)[]> = { message: [], close: [], error: [] };
  const sock = {
    sent: [] as string[],
    accepted: false,
    accept() {
      sock.accepted = true;
    },
    send(data: string) {
      sock.sent.push(data);
    },
    close(_code?: number, _reason?: string) {
      queueMicrotask(() => {
        for (const cb of listeners.close) cb({ code: 1000, reason: "" });
      });
    },
    addEventListener(type: string, cb: (ev: any) => void) {
      listeners[type]!.push(cb);
    },
    emitMessage(data: string) {
      for (const cb of listeners.message) cb({ data });
    },
    emitError() {
      for (const cb of listeners.error) cb(undefined);
    },
    emitClose() {
      for (const cb of listeners.close) cb({ code: 1000, reason: "" });
    },
  };
  return sock;
}

/** A fetchImpl that resolves the fetch()-upgrade with a fake webSocket immediately. */
function fetchImplWithSocket(sock: ReturnType<typeof createFakeRawSocket>) {
  return vi.fn(async () => ({ status: 101, webSocket: sock }) as any);
}

async function flushMicrotasks() {
  await Promise.resolve();
  await Promise.resolve();
}

describe("downmixStereo16LEToMono", () => {
  it("takes the left channel of each stereo frame", () => {
    // Two stereo frames: L=0x1234 R=0x5678, L=0x9abc R=0xdef0 (LE byte order)
    const stereo = new Uint8Array([0x34, 0x12, 0x78, 0x56, 0xbc, 0x9a, 0xf0, 0xde]);
    const mono = downmixStereo16LEToMono(stereo);
    expect(Array.from(mono)).toEqual([0x34, 0x12, 0xbc, 0x9a]);
  });

  it("drops a dangling half-frame at the end", () => {
    const stereo = new Uint8Array([0x01, 0x02, 0x03, 0x04, 0x05]); // 1 full frame + 1 byte
    const mono = downmixStereo16LEToMono(stereo);
    expect(Array.from(mono)).toEqual([0x01, 0x02]);
  });
});

describe("streamingTranscribeElevenLabs", () => {
  it("throws when ELEVENLABS_API_KEY is missing", async () => {
    const pcm = new Uint8Array(16);
    const env = {} as any;
    await expect(streamingTranscribeElevenLabs(pcm, env, vi.fn())).rejects.toThrow(
      "ELEVENLABS_API_KEY not provisioned",
    );
  });

  it("opens the fetch()-upgrade with xi-api-key header and the scribe_v2_realtime model", async () => {
    const sock = createFakeRawSocket();
    const fetchImpl = fetchImplWithSocket(sock);
    const env = { ELEVENLABS_API_KEY: "test-key" } as any;
    const pcm = new Uint8Array(16);

    const resultP = streamingTranscribeElevenLabs(pcm, env, fetchImpl);
    await flushMicrotasks();
    sock.emitMessage(JSON.stringify({ message_type: "committed_transcript", text: "hello world" }));

    const result = await resultP;
    expect(result).toEqual({ isFinal: true, transcript: "hello world" });

    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain("wss://api.elevenlabs.io/v1/speech-to-text/realtime");
    expect(url).toContain("model_id=scribe_v2_realtime");
    expect((init.headers as Record<string, string>)["xi-api-key"]).toBe("test-key");
    expect(sock.accepted).toBe(true);
  });

  it("resolves the committed transcript and ignores partials in the result", async () => {
    const sock = createFakeRawSocket();
    const fetchImpl = fetchImplWithSocket(sock);
    const env = { ELEVENLABS_API_KEY: "test-key" } as any;

    const resultP = streamingTranscribeElevenLabs(new Uint8Array(16), env, fetchImpl);
    await flushMicrotasks();

    sock.emitMessage(JSON.stringify({ message_type: "session_started", session_id: "s1" }));
    sock.emitMessage(JSON.stringify({ message_type: "partial_transcript", text: "hel" }));
    sock.emitMessage(JSON.stringify({ message_type: "committed_transcript", text: "hello" }));

    const result = await resultP;
    expect(result).toEqual({ isFinal: true, transcript: "hello" });
  });

  it("sends audio as input_audio_chunk messages then a final commit:true chunk", async () => {
    const sock = createFakeRawSocket();
    const fetchImpl = fetchImplWithSocket(sock);
    const env = { ELEVENLABS_API_KEY: "test-key" } as any;
    // 8-byte stereo -> downmixed to 4-byte mono -> one small chunk.
    const pcm = new Uint8Array(8);

    const resultP = streamingTranscribeElevenLabs(pcm, env, fetchImpl);
    await flushMicrotasks();

    expect(sock.sent.length).toBeGreaterThanOrEqual(1);
    const last = JSON.parse(sock.sent[sock.sent.length - 1]!);
    expect(last).toMatchObject({ message_type: "input_audio_chunk", commit: true, audio_base_64: "" });

    sock.emitMessage(JSON.stringify({ message_type: "committed_transcript", text: "ok" }));
    await resultP;
  });

  it("rejects on a vendor error event", async () => {
    const sock = createFakeRawSocket();
    const fetchImpl = fetchImplWithSocket(sock);
    const env = { ELEVENLABS_API_KEY: "test-key" } as any;

    const resultP = streamingTranscribeElevenLabs(new Uint8Array(16), env, fetchImpl);
    await flushMicrotasks();
    sock.emitMessage(JSON.stringify({ message_type: "auth_error", error: "invalid key" }));

    await expect(resultP).rejects.toThrow(/auth_error/);
  });

  it("rejects on WebSocket error", async () => {
    const sock = createFakeRawSocket();
    const fetchImpl = fetchImplWithSocket(sock);
    const env = { ELEVENLABS_API_KEY: "test-key" } as any;

    const resultP = streamingTranscribeElevenLabs(new Uint8Array(16), env, fetchImpl);
    await flushMicrotasks();
    sock.emitError();

    await expect(resultP).rejects.toThrow("ElevenLabs Scribe Realtime WebSocket error");
  });

  it("throws when the fetch()-upgrade does not return a webSocket", async () => {
    const fetchImpl = vi.fn(async () => ({ status: 401 }) as any);
    const env = { ELEVENLABS_API_KEY: "test-key" } as any;

    await expect(streamingTranscribeElevenLabs(new Uint8Array(16), env, fetchImpl)).rejects.toThrow(
      /upgrade failed \(401\)/,
    );
  });

  it("resolves with last known transcript when the socket closes without a commit", async () => {
    const sock = createFakeRawSocket();
    const fetchImpl = fetchImplWithSocket(sock);
    const env = { ELEVENLABS_API_KEY: "test-key" } as any;

    const resultP = streamingTranscribeElevenLabs(new Uint8Array(16), env, fetchImpl);
    await flushMicrotasks();
    sock.emitMessage(JSON.stringify({ message_type: "partial_transcript", text: "partial" }));
    sock.emitClose();

    const result = await resultP;
    expect(result).toEqual({ isFinal: true, transcript: "partial" });
  });
});
