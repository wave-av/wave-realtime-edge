// Task #81 step 3 — buildTurnDeps live-wiring: env gating (fail-CLOSED when a cred is unset, never a fake), the
// gateway LLM request shape + SSE delta parsing, the ElevenLabs pcm_48000 request + chunk streaming, and that
// secrets are referenced not logged. Every fetch is a FAKE — no live network.
import { describe, it, expect, vi } from "vitest";
import {
  buildTurnDeps,
  DEFAULT_VOICE_LLM_MODEL,
  ELEVENLABS_OUTPUT_FORMAT,
  type AgentTurnEnv,
  type LlmMessage,
} from "../src/agent-turn.js";
import type { AgentMediaDeps } from "../src/agent-session.js";

const media: AgentMediaDeps = {
  createEgress: vi.fn(),
  createIngest: vi.fn(),
  ingestSocket: () => null,
  now: () => 0,
  log: () => {},
};

function sseResponse(deltas: string[]): Response {
  const lines = deltas
    .map((t) => `data: ${JSON.stringify({ type: "content_block_delta", delta: { type: "text_delta", text: t } })}\n\n`)
    .join("");
  return new Response(`${lines}data: [DONE]\n\n`, { status: 200, headers: { "content-type": "text/event-stream" } });
}

async function collect<T>(it: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const v of it) out.push(v);
  return out;
}

describe("buildTurnDeps — env gating (fail CLOSED, never a fake)", () => {
  it("throws *_NOT_CONFIGURED when creds are unset", async () => {
    const deps = buildTurnDeps({ VOICE_AGENT_PROVIDER: "wave" } as AgentTurnEnv, media, vi.fn());
    await expect(deps.transcribe(new Uint8Array([1]))).rejects.toMatchObject({ code: "STT_NOT_CONFIGURED" });
    await expect(collect(deps.complete([]))).rejects.toMatchObject({ code: "LLM_NOT_CONFIGURED" });
    await expect(collect(deps.synthesize("hi"))).rejects.toMatchObject({ code: "TTS_NOT_CONFIGURED" });
  });
});

describe("buildTurnDeps — gateway LLM streaming", () => {
  it("posts model+system+turns to the gateway and yields text deltas; token never in the URL", async () => {
    const fetchImpl = vi.fn(async () => sseResponse(["Hel", "lo"]));
    const env: AgentTurnEnv = {
      VOICE_AGENT_PROVIDER: "wave",
      WAVE_GATEWAY_BASE: "https://api.wave.online/",
      WAVE_GATEWAY_TOKEN: "secret-gw-token",
    };
    const deps = buildTurnDeps(env, media, fetchImpl);
    const msgs: LlmMessage[] = [
      { role: "system", content: "sys" },
      { role: "user", content: "hi" },
    ];
    const out = await collect(deps.complete(msgs));
    expect(out.join("")).toBe("Hello");
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.wave.online/v1/messages");
    expect(url).not.toContain("secret-gw-token"); // secret never in the URL
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.model).toBe(DEFAULT_VOICE_LLM_MODEL);
    expect(body.system).toBe("sys");
    expect(body.stream).toBe(true);
    expect(body.messages.map((m: LlmMessage) => m.role)).toEqual(["user"]); // system hoisted out
    expect((init as RequestInit).headers).toMatchObject({ authorization: "Bearer secret-gw-token" });
  });

  it("honors VOICE_AGENT_LLM_MODEL override (Opus)", async () => {
    const fetchImpl = vi.fn(async () => sseResponse(["x"]));
    const env: AgentTurnEnv = {
      WAVE_GATEWAY_BASE: "https://api.wave.online",
      WAVE_GATEWAY_TOKEN: "t",
      VOICE_AGENT_LLM_MODEL: "claude-opus-4-5",
    };
    await collect(buildTurnDeps(env, media, fetchImpl).complete([{ role: "user", content: "q" }]));
    const body = JSON.parse((fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1].body as string);
    expect(body.model).toBe("claude-opus-4-5");
  });

  it("throws LLM_UPSTREAM on a non-200", async () => {
    const fetchImpl = vi.fn(async () => new Response("nope", { status: 502 }));
    const env: AgentTurnEnv = { WAVE_GATEWAY_BASE: "https://api.wave.online", WAVE_GATEWAY_TOKEN: "t" };
    await expect(collect(buildTurnDeps(env, media, fetchImpl).complete([]))).rejects.toMatchObject({
      code: "LLM_UPSTREAM",
    });
  });
});

describe("buildTurnDeps — ElevenLabs TTS streaming", () => {
  it("requests pcm_48000 with the voice id + xi-api-key and streams the PCM body in chunks", async () => {
    const pcmA = new Uint8Array([1, 2]);
    const pcmB = new Uint8Array([3, 4]);
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(pcmA);
        c.enqueue(pcmB);
        c.close();
      },
    });
    const fetchImpl = vi.fn(async () => new Response(stream, { status: 200 }));
    const env: AgentTurnEnv = { ELEVENLABS_API_KEY: "xi-secret", ELEVENLABS_VOICE_ID: "voice123" };
    const out = await collect(buildTurnDeps(env, media, fetchImpl).synthesize("hello"));
    expect(out.map((c) => Array.from(c))).toEqual([[1, 2], [3, 4]]);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain("/text-to-speech/voice123/stream");
    expect(url).toContain(`output_format=${ELEVENLABS_OUTPUT_FORMAT}`);
    expect(url).not.toContain("xi-secret"); // key never in the URL
    expect((init as RequestInit).headers).toMatchObject({ "xi-api-key": "xi-secret" });
  });

  it("throws TTS_UPSTREAM on a non-200", async () => {
    const fetchImpl = vi.fn(async () => new Response("nope", { status: 500 }));
    const env: AgentTurnEnv = { ELEVENLABS_API_KEY: "k", ELEVENLABS_VOICE_ID: "v" };
    await expect(collect(buildTurnDeps(env, media, fetchImpl).synthesize("x"))).rejects.toMatchObject({
      code: "TTS_UPSTREAM",
    });
  });
});

describe("buildTurnDeps — STT provider", () => {
  it("posts PCM and parses {isFinal,transcript}", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ isFinal: true, transcript: "hi there" }), { status: 200 }),
    );
    const env: AgentTurnEnv = { VOICE_AGENT_STT_BASE: "https://stt.wave.online", VOICE_AGENT_STT_KEY: "stt-secret" };
    const r = await buildTurnDeps(env, media, fetchImpl).transcribe(new Uint8Array([9]));
    expect(r).toEqual({ isFinal: true, transcript: "hi there" });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://stt.wave.online/v1/transcribe/stream");
    expect(url).not.toContain("stt-secret");
    expect((init as RequestInit).headers).toMatchObject({ authorization: "Bearer stt-secret" });
  });
});
