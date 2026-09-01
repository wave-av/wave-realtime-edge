/// <reference types="@cloudflare/workers-types" />
/**
 * E1 (elevenlabs-surface-adoption epic, #4081) — Streaming STT adapter: ElevenLabs Scribe v2
 * Realtime WebSocket backend.
 *
 * A SECOND provider behind the SAME `streamingTranscribe`/`transcribe` seam Task #81 built for
 * Deepgram (`src/agent-stt-streaming.ts`) — selectable via `VOICE_AGENT_STREAMING_STT_PROVIDER`,
 * not a replacement. TurnTakingCore is NOT modified. Default provider stays "deepgram" (byte-
 * identical behavior when the selector is unset), matching the existing flag's own default-OFF
 * discipline (agent-turn-env.ts).
 *
 * Event contract verified against the ElevenLabs vendor docs (fetched live, 2026-09-01):
 *   - WS endpoint:  GET wss://api.elevenlabs.io/v1/speech-to-text/realtime?model_id=scribe_v2_realtime
 *     (https://elevenlabs.io/docs/api-reference/speech-to-text/v-1-speech-to-text-realtime —
 *     AsyncAPI spec)
 *   - Sent:     `input_audio_chunk` { message_type, audio_base_64, commit, sample_rate }
 *   - Received: `session_started`, `partial_transcript` { text }, `committed_transcript` { text },
 *     `committed_transcript_with_timestamps`, `committed_transcript_entities`, plus a fixed set of
 *     error message_types (`auth_error`, `quota_exceeded`, `transcriber_error`, `input_error`,
 *     `invalid_request`, `error`, `commit_throttled`, `unaccepted_terms`, `rate_limited`,
 *     `queue_overflow`, `resource_exhausted`, `session_time_limit_exceeded`,
 *     `chunk_size_exceeded`, `insufficient_audio_activity`)
 *     (https://elevenlabs.io/docs/eleven-api/guides/how-to/speech-to-text/realtime/event-reference)
 *   - Auth: EITHER a `xi-api-key` header OR a single-use `token` query param (client-side only).
 *     Server-side callers (us) use the header — matches the "Server-side streaming" guide
 *     (https://elevenlabs.io/docs/eleven-api/guides/how-to/speech-to-text/realtime/server-side-streaming).
 *
 * CF Workers detail: the browser-style `new WebSocket(url)` constructor (used by the Deepgram
 * adapter, auth via query param) does NOT accept custom headers in the Workers runtime — so an
 * `xi-api-key` HEADER requires the `fetch()`-based WebSocket upgrade (`Upgrade: websocket` header
 * on a normal `fetch`, then `response.webSocket.accept()`), which IS the documented CF Workers
 * pattern for an authenticated outbound WebSocket. This adapter uses that path via the injectable
 * `fetchImpl` (matches the FetchLike convention already used by agent-turn-providers.ts), so unit
 * tests fake the upgrade the same way other adapters fake `fetch` — no live network, no
 * WebSocket-global mocking needed.
 *
 * Audio: the accumulated `pcm` buffer handed to `transcribe()` is 48 kHz / 16-bit-LE / STEREO
 * (the ingest codec — same buffer the Deepgram adapter streams `channels:"2"`). ElevenLabs' Scribe
 * Realtime `AudioFormatEnum` has no stereo variant (pcm_8000|16000|22050|24000|44100|48000|
 * ulaw_8000 — implicitly mono, per the vendor's own PCM examples: "16 kHz, mono, 16-bit PCM,
 * little-endian"), so the stereo buffer is downmixed to mono (left channel) before send.
 *
 * Fails CLOSED: throws `AgentSessionError` on a missing key, upgrade failure, a vendor error
 * event, or timeout — the caller (agent-turn-env.ts buildTurnDeps) catches this and falls back to
 * the Deepgram streaming adapter, never drops the turn.
 */
import { AgentSessionError } from "./agent-session.js";
import type { AgentTurnEnv, SttResult } from "./agent-turn.js";
import type { FetchLike } from "./agent-turn-providers.js";

/** Same client-facing event shape the Deepgram adapter exposes — lets both adapters share one
 *  send/receive/settle loop shape even though the underlying transport differs (browser-style
 *  outbound WebSocket for Deepgram vs. a fetch()-upgraded CF Workers WebSocket here). */
interface OutboundWebSocket {
  onmessage: ((ev: { data: string | ArrayBuffer }) => void) | null;
  onerror: (() => void) | null;
  onclose: ((ev: { code: number; reason: string }) => void) | null;
  send(data: string | ArrayBuffer | Uint8Array): void;
  close(code?: number, reason?: string): void;
}

/** CF Workers' fetch()-upgraded Response carries a `.webSocket` when the upgrade succeeds. Typed
 *  narrowly here rather than pulling in the full Workers Response override. */
interface UpgradedResponse {
  status: number;
  webSocket?: {
    accept(): void;
    send(data: string | ArrayBuffer | Uint8Array): void;
    close(code?: number, reason?: string): void;
    addEventListener(type: "message", cb: (ev: { data: string | ArrayBuffer }) => void): void;
    addEventListener(type: "close", cb: (ev: { code: number; reason: string }) => void): void;
    addEventListener(type: "error", cb: () => void): void;
  };
}

/** Audio chunk size sent per `input_audio_chunk` message — 8 KB mirrors the vendor's own
 *  server-side-streaming example chunk size. */
const CHUNK_SIZE = 8192;
/** Hard timeout on the streaming session — matches the Deepgram adapter's budget. */
const STREAMING_TIMEOUT_MS = 30_000;
/** Scribe Realtime model id (DIGEST S7/S8). */
const MODEL_ID = "scribe_v2_realtime";
/** The `pcm` buffer handed in is 48 kHz stereo — Scribe Realtime wants mono at this rate. */
const SAMPLE_RATE = 48_000;

/** message_type values the vendor spec marks as terminal errors (event-reference.md "Error handling"). */
const ERROR_MESSAGE_TYPES = new Set([
  "auth_error",
  "quota_exceeded",
  "transcriber_error",
  "input_error",
  "invalid_request",
  "error",
  "commit_throttled",
  "unaccepted_terms",
  "rate_limited",
  "queue_overflow",
  "resource_exhausted",
  "session_time_limit_exceeded",
  "chunk_size_exceeded",
  "insufficient_audio_activity",
]);

/** Downmix 48 kHz/16-bit-LE STEREO interleaved PCM to MONO (left channel). Pure, whole-buffer —
 *  the streaming seam hands the FULL accumulated turn buffer per call (no cross-call carry). An
 *  odd trailing byte (a half-frame) is dropped — inaudible at end-of-utterance. */
export function downmixStereo16LEToMono(stereo: Uint8Array): Uint8Array {
  const frames = stereo.length >> 2; // 4 bytes per stereo frame (L:2 + R:2)
  const mono = new Uint8Array(frames * 2);
  for (let f = 0; f < frames; f++) {
    mono[f * 2] = stereo[f * 4]!;
    mono[f * 2 + 1] = stereo[f * 4 + 1]!;
  }
  return mono;
}

/** Base64-encode a byte buffer without spreading the whole array into `String.fromCharCode`
 *  (safe for arbitrarily large buffers; CHUNK_SIZE keeps each call small regardless). */
function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]!);
  return btoa(binary);
}

/**
 * Open the ElevenLabs Scribe Realtime WebSocket via the CF Workers fetch()-upgrade pattern (the
 * ONLY way to attach the `xi-api-key` header to an outbound Workers WebSocket — the browser-style
 * `new WebSocket(url)` constructor does not accept headers in this runtime). Injectable via
 * `fetchImpl` so tests fake the upgrade without a live network or a WebSocket-global mock.
 */
async function connectScribeRealtime(
  fetchImpl: FetchLike,
  apiKey: string,
): Promise<OutboundWebSocket> {
  const params = new URLSearchParams({
    model_id: MODEL_ID,
    audio_format: `pcm_${SAMPLE_RATE}`,
    commit_strategy: "manual",
  });
  const url = `wss://api.elevenlabs.io/v1/speech-to-text/realtime?${params}`;
  const res = (await fetchImpl(url, {
    headers: { Upgrade: "websocket", "xi-api-key": apiKey } as unknown as HeadersInit,
  } as RequestInit)) as unknown as UpgradedResponse;
  const raw = res.webSocket;
  if (!raw) {
    throw new AgentSessionError(
      "STT_UPSTREAM",
      `ElevenLabs Scribe Realtime WebSocket upgrade failed (${res.status})`,
      502,
    );
  }
  raw.accept();
  const wrapped: OutboundWebSocket = {
    onmessage: null,
    onerror: null,
    onclose: null,
    send: (data) => raw.send(data),
    close: (code, reason) => raw.close(code, reason),
  };
  raw.addEventListener("message", (ev) => wrapped.onmessage?.(ev));
  raw.addEventListener("close", (ev) => wrapped.onclose?.(ev));
  raw.addEventListener("error", () => wrapped.onerror?.());
  // Unlike the browser-style outbound WebSocket the Deepgram adapter uses (async connect, an
  // "open" event fires later), the fetch()-upgrade IS the connect — by the time accept() returns,
  // the socket is already open. No "open" event/race to wait on; the caller sends immediately.
  return wrapped;
}

/**
 * Stream PCM to ElevenLabs Scribe v2 Realtime and resolve the final (committed) transcript. The
 * contract matches the batch/Deepgram seam exactly: `{ isFinal: true, transcript }` — partials
 * are tracked internally (as a fallback value) but not surfaced to the core.
 *
 * Fails CLOSED: throws `AgentSessionError` on a missing key, upgrade failure, WS error, a vendor
 * error event, or timeout. The caller (buildTurnDeps) catches this and falls back to Deepgram.
 */
export async function streamingTranscribeElevenLabs(
  pcm: Uint8Array,
  env: AgentTurnEnv,
  fetchImpl: FetchLike = fetch as unknown as FetchLike,
): Promise<SttResult> {
  const apiKey = env.ELEVENLABS_API_KEY;
  if (!apiKey) {
    throw new AgentSessionError(
      "STT_NOT_CONFIGURED",
      "ELEVENLABS_API_KEY not provisioned",
      503,
    );
  }

  const mono = downmixStereo16LEToMono(pcm);
  const ws = await connectScribeRealtime(fetchImpl, apiKey);

  return new Promise<SttResult>((resolve, reject) => {
    let settled = false;
    let transcript = "";

    const timeout = setTimeout(() => {
      if (!settled) {
        settled = true;
        try {
          ws.close();
        } catch {
          /* best-effort cleanup */
        }
        reject(new AgentSessionError("STT_TIMEOUT", "ElevenLabs streaming STT timed out", 504));
      }
    }, STREAMING_TIMEOUT_MS);

    const sendAudio = () => {
      for (let off = 0; off < mono.length; off += CHUNK_SIZE) {
        const chunk = mono.slice(off, off + CHUNK_SIZE);
        ws.send(
          JSON.stringify({
            message_type: "input_audio_chunk",
            audio_base_64: toBase64(chunk),
            commit: false,
            sample_rate: SAMPLE_RATE,
          }),
        );
      }
      // Final empty commit — signals end-of-utterance so Scribe settles the committed transcript
      // (mirrors the vendor's own server-side-streaming example idiom).
      ws.send(
        JSON.stringify({
          message_type: "input_audio_chunk",
          audio_base_64: "",
          commit: true,
          sample_rate: SAMPLE_RATE,
        }),
      );
    };

    ws.onmessage = (ev) => {
      if (settled) return;
      try {
        const msg = JSON.parse(
          typeof ev.data === "string" ? ev.data : new TextDecoder().decode(ev.data),
        ) as { message_type?: string; text?: string; error?: string };
        const type = msg.message_type;
        if (type === undefined) return;

        if (ERROR_MESSAGE_TYPES.has(type)) {
          settled = true;
          clearTimeout(timeout);
          try {
            ws.close();
          } catch {
            /* already closing */
          }
          reject(
            new AgentSessionError(
              "STT_UPSTREAM",
              `ElevenLabs Scribe Realtime error: ${type}${msg.error ? ` — ${msg.error}` : ""}`,
              502,
            ),
          );
          return;
        }

        if (type === "partial_transcript" && typeof msg.text === "string") {
          transcript = msg.text;
          return;
        }

        if (type === "committed_transcript" && typeof msg.text === "string") {
          transcript = msg.text;
          settled = true;
          clearTimeout(timeout);
          try {
            ws.close();
          } catch {
            /* already closing */
          }
          resolve({ isFinal: true, transcript });
          return;
        }
        // session_started / committed_transcript_with_timestamps / committed_transcript_entities /
        // unrecognized types — no action needed for the v1 contract (final-driven, text-only).
      } catch {
        // Malformed message — ignore and wait for a valid one.
      }
    };

    ws.onerror = () => {
      if (!settled) {
        settled = true;
        clearTimeout(timeout);
        reject(new AgentSessionError("STT_UPSTREAM", "ElevenLabs Scribe Realtime WebSocket error", 502));
      }
    };

    ws.onclose = () => {
      // Fallback: if the socket closed without a committed_transcript (network issue, server-side
      // close), treat the last known (possibly partial) transcript as final — better than failing
      // the turn. Mirrors the Deepgram adapter's onclose behavior exactly.
      if (!settled) {
        settled = true;
        clearTimeout(timeout);
        resolve({ isFinal: true, transcript });
      }
    };

    // The fetch()-upgrade already completed the connection (see connectScribeRealtime) — send as
    // soon as the message/error/close listeners above are wired, no "open" event to wait on.
    sendAudio();
  });
}
