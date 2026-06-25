// Task #81 step 3 — buildTurnDeps live-wiring: env gating (fail-CLOSED when a cred is unset, never a fake), the
// gateway LLM request shape + SSE delta parsing, the ElevenLabs pcm_48000 request + chunk streaming, and that
// secrets are referenced not logged. Every fetch is a FAKE — no live network.
import { describe, it, expect, vi } from "vitest";
import {
  buildTurnDeps,
  normalizeGatewayEnv,
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
    await expect(collect(deps.complete([], []))).rejects.toMatchObject({ code: "LLM_NOT_CONFIGURED" });
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
    const deps = buildTurnDeps(env, media, fetchImpl, "org_acme"); // org → x-wave-org tenant attribution
    const msgs: LlmMessage[] = [
      { role: "system", content: "sys" },
      { role: "user", content: "hi" },
    ];
    const out = await collect(deps.complete(msgs, []));
    expect(out.map((e) => (e.type === "text" ? e.text : "")).join("")).toBe("Hello");
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    // The LLM proxy is the gateway's INTERNAL (service-token-gated) route, not the customer /v1/messages.
    expect(url).toBe("https://api.wave.online/v1/internal/messages");
    expect(url).not.toContain("secret-gw-token"); // secret never in the URL
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.model).toBe(DEFAULT_VOICE_LLM_MODEL);
    expect(body.system).toBe("sys");
    expect(body.stream).toBe(true);
    expect(body.messages.map((m: LlmMessage) => m.role)).toEqual(["user"]); // system hoisted out
    expect((init as RequestInit).headers).toMatchObject({ authorization: "Bearer secret-gw-token", "x-wave-org": "org_acme" });
  });

  it("honors VOICE_AGENT_LLM_MODEL override (Opus)", async () => {
    const fetchImpl = vi.fn(async () => sseResponse(["x"]));
    const env: AgentTurnEnv = {
      WAVE_GATEWAY_BASE: "https://api.wave.online",
      WAVE_GATEWAY_TOKEN: "t",
      VOICE_AGENT_LLM_MODEL: "claude-opus-4-5",
    };
    await collect(buildTurnDeps(env, media, fetchImpl).complete([{ role: "user", content: "q" }], []));
    const body = JSON.parse((fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1].body as string);
    expect(body.model).toBe("claude-opus-4-5");
  });

  it("throws LLM_UPSTREAM on a non-200", async () => {
    const fetchImpl = vi.fn(async () => new Response("nope", { status: 502 }));
    const env: AgentTurnEnv = { WAVE_GATEWAY_BASE: "https://api.wave.online", WAVE_GATEWAY_TOKEN: "t" };
    await expect(collect(buildTurnDeps(env, media, fetchImpl).complete([], []))).rejects.toMatchObject({
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

describe("buildTurnDeps — STT via the WAVE transcribe spoke (gateway-fronted, WAV-wrapped batch)", () => {
  it("WAV-wraps the PCM, posts to /v1/internal/transcribe?engine=auto with the service Bearer + x-wave-org, maps text->final", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ text: "hi there", durationSec: 1.2 }), { status: 200 }),
    );
    const env: AgentTurnEnv = { VOICE_AGENT_STT_BASE: "https://api.wave.online/", VOICE_AGENT_STT_TOKEN: "stt-secret" };
    const r = await buildTurnDeps(env, media, fetchImpl, "org_acme").transcribe(new Uint8Array([9, 9, 9, 9]));
    expect(r).toEqual({ isFinal: true, transcript: "hi there" }); // batch result IS the final user turn
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    // STT is reached via the gateway's INTERNAL (service-token-gated) route, not the customer /v1/transcribe.
    expect(url).toBe("https://api.wave.online/v1/internal/transcribe?engine=auto");
    expect(url).not.toContain("stt-secret"); // secret never in the URL
    expect((init as RequestInit).headers).toMatchObject({
      authorization: "Bearer stt-secret",
      "content-type": "audio/wav",
      "x-wave-org": "org_acme",
    });
    // The body is a WAV container (44-byte RIFF header) wrapping the raw PCM, not headerless PCM.
    const body = new Uint8Array((init as RequestInit).body as ArrayBuffer);
    expect(String.fromCharCode(body[0], body[1], body[2], body[3])).toBe("RIFF");
    expect(String.fromCharCode(body[8], body[9], body[10], body[11])).toBe("WAVE");
    expect(body.length).toBe(44 + 4); // header + the 4 PCM bytes
  });

  it("falls back to WAVE_GATEWAY_BASE/TOKEN when the STT-specific names are unset (one gateway origin)", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ text: "ok" }), { status: 200 }));
    const env: AgentTurnEnv = { WAVE_GATEWAY_BASE: "https://api.wave.online", WAVE_GATEWAY_TOKEN: "gw-tok" };
    const r = await buildTurnDeps(env, media, fetchImpl).transcribe(new Uint8Array([1]));
    expect(r.isFinal).toBe(true);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.wave.online/v1/internal/transcribe?engine=auto");
    expect((init as RequestInit).headers).toMatchObject({ authorization: "Bearer gw-tok" });
  });

  it("honors VOICE_AGENT_STT_ENGINE + VOICE_AGENT_STT_PATH overrides", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ text: "x" }), { status: 200 }));
    const env: AgentTurnEnv = {
      VOICE_AGENT_STT_BASE: "https://api.wave.online",
      VOICE_AGENT_STT_TOKEN: "t",
      VOICE_AGENT_STT_ENGINE: "deepgram",
      VOICE_AGENT_STT_PATH: "/v1/transcribe",
    };
    await buildTurnDeps(env, media, fetchImpl).transcribe(new Uint8Array([1]));
    const url = (fetchImpl.mock.calls[0] as unknown as [string])[0];
    expect(url).toBe("https://api.wave.online/v1/transcribe?engine=deepgram");
  });

  it("throws STT_UPSTREAM on a non-200", async () => {
    const fetchImpl = vi.fn(async () => new Response("nope", { status: 502 }));
    const env: AgentTurnEnv = { VOICE_AGENT_STT_BASE: "https://api.wave.online", VOICE_AGENT_STT_TOKEN: "t" };
    await expect(buildTurnDeps(env, media, fetchImpl).transcribe(new Uint8Array([1]))).rejects.toMatchObject({
      code: "STT_UPSTREAM",
    });
  });
});

describe("buildTurnDeps — voice_agent_minutes metering emit", () => {
  const usage = { org: "org1", room: "room1", agentId: "a1", turnId: "t0", turnWallMs: 30_000 };

  it("posts voice_agent_minutes to /v1/internal/usage with the service token (fractional minutes)", async () => {
    const fetchImpl = vi.fn(async () => new Response("{}", { status: 200 }));
    const env: AgentTurnEnv = { GATEWAY_BASE_URL: "https://api.wave.online", WAVE_SERVICE_TOKEN: "svc-tok" };
    await buildTurnDeps(env, media, fetchImpl).emitMeter(usage);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.wave.online/v1/internal/usage");
    expect(url).not.toContain("svc-tok");
    expect((init as RequestInit).headers).toMatchObject({ authorization: "Bearer svc-tok" });
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.org).toBe("org1");
    expect(body.usage.meter).toBe("voice_agent_minutes");
    expect(body.usage.meter_value).toBeCloseTo(0.5, 6); // 30s = 0.5 min, NOT truncated
    expect(body.usage.event_id).toBe("room1:a1:t0:voice_agent_minutes"); // idempotent key
  });

  it("is INERT (no network) when the meter is unprovisioned", async () => {
    const fetchImpl = vi.fn(async () => new Response("{}", { status: 200 }));
    await buildTurnDeps({} as AgentTurnEnv, media, fetchImpl).emitMeter(usage);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("is FAIL-OPEN — a transport error does not throw out of emitMeter", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("network down");
    });
    const env: AgentTurnEnv = { GATEWAY_BASE_URL: "https://api.wave.online", WAVE_SERVICE_TOKEN: "t" };
    await expect(buildTurnDeps(env, media, fetchImpl).emitMeter(usage)).resolves.toBeUndefined();
  });
});

describe("normalizeGatewayEnv — one convention provisions ALL gateway paths (config-no-silent-noop)", () => {
  it("fills BOTH name pairs from the voice-runtime names", () => {
    const r = normalizeGatewayEnv({ WAVE_GATEWAY_BASE: "https://api.wave.online", WAVE_GATEWAY_TOKEN: "tok" });
    expect(r.WAVE_GATEWAY_BASE).toBe("https://api.wave.online");
    expect(r.GATEWAY_BASE_URL).toBe("https://api.wave.online"); // metering name backfilled
    expect(r.WAVE_GATEWAY_TOKEN).toBe("tok");
    expect(r.WAVE_SERVICE_TOKEN).toBe("tok"); // metering token backfilled
  });

  it("fills BOTH name pairs from the established edge names", () => {
    const r = normalizeGatewayEnv({ GATEWAY_BASE_URL: "https://api.wave.online", WAVE_SERVICE_TOKEN: "svc" });
    expect(r.WAVE_GATEWAY_BASE).toBe("https://api.wave.online"); // LLM/STT name backfilled
    expect(r.WAVE_GATEWAY_TOKEN).toBe("svc");
    expect(r.GATEWAY_BASE_URL).toBe("https://api.wave.online");
    expect(r.WAVE_SERVICE_TOKEN).toBe("svc");
  });

  it("voice names WIN when both conventions are present (deterministic precedence)", () => {
    const r = normalizeGatewayEnv({
      WAVE_GATEWAY_BASE: "https://voice.example",
      WAVE_GATEWAY_TOKEN: "voice-tok",
      GATEWAY_BASE_URL: "https://edge.example",
      WAVE_SERVICE_TOKEN: "edge-tok",
    });
    expect(r.WAVE_GATEWAY_BASE).toBe("https://voice.example");
    expect(r.WAVE_GATEWAY_TOKEN).toBe("voice-tok");
    // The metering names keep their own explicit value (not clobbered) — both remain set, no silent loss.
    expect(r.GATEWAY_BASE_URL).toBe("https://edge.example");
    expect(r.WAVE_SERVICE_TOKEN).toBe("edge-tok");
  });
});

describe("buildTurnDeps — the established edge convention alone provisions LLM + STT (not just metering)", () => {
  it("GATEWAY_BASE_URL + WAVE_SERVICE_TOKEN drives the LLM proxy (no LLM_NOT_CONFIGURED)", async () => {
    const fetchImpl = vi.fn(async () => sseResponse(["ok"]));
    const env: AgentTurnEnv = { GATEWAY_BASE_URL: "https://api.wave.online", WAVE_SERVICE_TOKEN: "svc-tok" };
    const out = await collect(buildTurnDeps(env, media, fetchImpl).complete([{ role: "user", content: "hi" }], []));
    expect(out.map((e) => (e.type === "text" ? e.text : "")).join("")).toBe("ok");
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.wave.online/v1/internal/messages");
    expect((init as RequestInit).headers).toMatchObject({ authorization: "Bearer svc-tok" });
  });

  it("GATEWAY_BASE_URL + WAVE_SERVICE_TOKEN drives STT (no STT_NOT_CONFIGURED)", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ text: "hi" }), { status: 200 }));
    const env: AgentTurnEnv = { GATEWAY_BASE_URL: "https://api.wave.online", WAVE_SERVICE_TOKEN: "svc-tok" };
    const r = await buildTurnDeps(env, media, fetchImpl).transcribe(new Uint8Array([1]));
    expect(r).toEqual({ isFinal: true, transcript: "hi" });
    expect((fetchImpl.mock.calls[0] as unknown as [string])[0]).toBe("https://api.wave.online/v1/internal/transcribe?engine=auto");
  });
});

describe("buildTurnDeps — the voice-runtime convention alone provisions metering (not just LLM)", () => {
  it("WAVE_GATEWAY_BASE + WAVE_GATEWAY_TOKEN drives the meter emit (no silent metering no-op)", async () => {
    const fetchImpl = vi.fn(async () => new Response("{}", { status: 200 }));
    const env: AgentTurnEnv = { WAVE_GATEWAY_BASE: "https://api.wave.online", WAVE_GATEWAY_TOKEN: "gw-tok" };
    await buildTurnDeps(env, media, fetchImpl).emitMeter({
      org: "org1", room: "room1", agentId: "a1", turnId: "t0", turnWallMs: 60_000,
    });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.wave.online/v1/internal/usage");
    expect((init as RequestInit).headers).toMatchObject({ authorization: "Bearer gw-tok" });
  });
});
