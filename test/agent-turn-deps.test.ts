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
import { upmixMonoToStereo16LE } from "../src/agent-turn-providers.js";
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

async function* fromChunks(chunks: number[][]): AsyncIterable<Uint8Array> {
  for (const c of chunks) yield new Uint8Array(c);
}

describe("upmixMonoToStereo16LE — mono pcm_48000 → stereo interleaved (#30)", () => {
  it("duplicates each 16-bit LE sample into L=R within a chunk", async () => {
    const out = await collect(upmixMonoToStereo16LE(fromChunks([[0x10, 0x20, 0x30, 0x40]])));
    // two mono samples (0x2010, 0x4030) → [lo,hi,lo,hi] each
    expect(out.map((c) => Array.from(c))).toEqual([[0x10, 0x20, 0x10, 0x20, 0x30, 0x40, 0x30, 0x40]]);
  });

  it("carries an odd trailing byte across a chunk boundary (no sample dropped or misaligned)", async () => {
    // sample bytes [0xAA,0xBB] are split: 0xAA ends chunk1, 0xBB starts chunk2.
    const out = await collect(upmixMonoToStereo16LE(fromChunks([[0xaa], [0xbb, 0xcc, 0xdd]])));
    const flat = out.flatMap((c) => Array.from(c));
    // sample1 = 0xBBAA → L,R ; sample2 = 0xDDCC → L,R
    expect(flat).toEqual([0xaa, 0xbb, 0xaa, 0xbb, 0xcc, 0xdd, 0xcc, 0xdd]);
  });

  it("handles a lone-byte chunk by holding it until the next chunk completes the sample", async () => {
    const out = await collect(upmixMonoToStereo16LE(fromChunks([[0x01], [0x02]])));
    expect(out.flatMap((c) => Array.from(c))).toEqual([0x01, 0x02, 0x01, 0x02]);
  });

  it("skips empty chunks and drops a dangling final half-sample (inaudible end-of-utterance byte)", async () => {
    const out = await collect(upmixMonoToStereo16LE(fromChunks([[], [0x05, 0x06, 0x07], []])));
    // one full sample 0x0605; 0x07 has no pair at stream end → dropped
    expect(out.flatMap((c) => Array.from(c))).toEqual([0x05, 0x06, 0x05, 0x06]);
  });

  it("output byte length is always a multiple of 4 (stereo frame aligned)", async () => {
    const out = await collect(upmixMonoToStereo16LE(fromChunks([[1, 2, 3], [4, 5], [6, 7, 8, 9]])));
    for (const c of out) expect(c.length % 4).toBe(0);
  });
});

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
    // synthesize upmixes the MONO pcm_48000 to STEREO interleaved (L=R) for the CF ingest path (#30):
    // [1,2] (one mono sample) → [1,2,1,2]; [3,4] → [3,4,3,4].
    expect(out.map((c) => Array.from(c))).toEqual([[1, 2, 1, 2], [3, 4, 3, 4]]);
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

describe("buildTurnDeps — fetch body cleanup (DO fetch-pool deadlock guard)", () => {
  // A ReadableStream whose cancel() is observable, so we can assert the body is released rather than abandoned
  // (an un-drained / un-cancelled Response deadlocks the DO's concurrent-fetch pool — the #26 bug).
  function spyStream(): { stream: ReadableStream<Uint8Array>; cancelled: () => boolean } {
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      pull(c) { c.enqueue(new Uint8Array([1, 2, 3, 4])); }, // unbounded → never auto-closes; must be cancelled
      cancel() { cancelled = true; },
    });
    return { stream, cancelled: () => cancelled };
  }

  it("cancels the response body on a non-OK STT error (does not leak the Response)", async () => {
    const { stream, cancelled } = spyStream();
    const fetchImpl = vi.fn(async () => new Response(stream, { status: 502 }));
    const env: AgentTurnEnv = { VOICE_AGENT_STT_BASE: "https://api.wave.online", VOICE_AGENT_STT_TOKEN: "t" };
    await expect(buildTurnDeps(env, media, fetchImpl).transcribe(new Uint8Array([1]))).rejects.toMatchObject({
      code: "STT_UPSTREAM",
    });
    expect(cancelled()).toBe(true);
  });

  it("cancels the LLM stream when the consumer breaks early (barge-in abort)", async () => {
    // Emit valid SSE text deltas UNBOUNDEDLY so the consumer actually yields events (and the stream never
    // self-closes) — it must be cancelled on the early break, not abandoned.
    const enc = new TextEncoder();
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      pull(c) {
        c.enqueue(enc.encode(`data: ${JSON.stringify({ type: "content_block_delta", delta: { type: "text_delta", text: "x" } })}\n\n`));
      },
      cancel() { cancelled = true; },
    });
    const fetchImpl = vi.fn(async () => new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } }));
    const env: AgentTurnEnv = { WAVE_GATEWAY_BASE: "https://api.wave.online", WAVE_GATEWAY_TOKEN: "t" };
    // Take the first event, then break — simulates the turn aborting mid-stream on barge-in.
    for await (const _evt of buildTurnDeps(env, media, fetchImpl).complete([{ role: "user", content: "q" }], [])) {
      break;
    }
    expect(cancelled).toBe(true);
  });

  it("cancels the TTS stream when the consumer breaks early (barge-in abort)", async () => {
    const { stream, cancelled } = spyStream();
    const fetchImpl = vi.fn(async () => new Response(stream, { status: 200 }));
    const env: AgentTurnEnv = { ELEVENLABS_API_KEY: "k", ELEVENLABS_VOICE_ID: "v" };
    for await (const _chunk of buildTurnDeps(env, media, fetchImpl).synthesize("hello")) {
      break; // abort after the first PCM chunk
    }
    expect(cancelled()).toBe(true);
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
