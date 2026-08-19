/// <reference types="@cloudflare/workers-types" />
/**
 * Task #81 — Streaming STT adapter: Deepgram WebSocket backend.
 *
 * Opens a WebSocket to Deepgram's streaming listen endpoint, sends the accumulated PCM in chunks,
 * and resolves with the final transcript. The streaming path processes audio incrementally as chunks
 * arrive, yielding lower time-to-final than the batch POST (WAV → JSON in transcribeViaProvider).
 *
 * TurnTakingCore is NOT modified — this plugs into the existing `transcribe` seam.
 * Behind the VOICE_AGENT_STREAMING_STT env flag (default OFF → byte-identical batch path).
 *
 * The v1 contract stays final-driven: the adapter resolves `{ isFinal: true, transcript }` when
 * Deepgram emits its final result. Partial transcripts are NOT surfaced to the core (the seam only
 * exposes finals today), but the streaming path processes them internally for lower latency.
 */
import { AgentSessionError } from "./agent-session.js";
import type { AgentTurnEnv, SttResult } from "./agent-turn.js";

/**
 * Client-side WebSocket interface — the standard browser `WebSocket` API for outbound connections.
 * The CF Workers `WebSocket` type in `@cloudflare/workers-types` covers the hibernation (server-side)
 * API; outbound client sockets use the same runtime but with `on*` event handler properties.
 */
interface OutboundWebSocket {
  onopen: (() => void) | null;
  onmessage: ((ev: { data: string | ArrayBuffer }) => void) | null;
  onerror: (() => void) | null;
  onclose: ((ev: { code: number; reason: string }) => void) | null;
  send(data: string | ArrayBuffer | Uint8Array): void;
  close(code?: number, reason?: string): void;
  readonly readyState: number;
}

/** Deepgram WebSocket chunk size — 4 KB keeps the socket fed without fragmenting. */
const CHUNK_SIZE = 4096;
/** Hard timeout on the streaming session — 30 s covers any reasonable utterance length. */
const STREAMING_TIMEOUT_MS = 30_000;

/**
 * Stream PCM to Deepgram via WebSocket and resolve the final transcript. The contract matches the
 * batch `transcribe` seam: `{ isFinal: true, transcript }` — no partials are surfaced to the core
 * (v1 endpointing is final-driven).
 *
 * Fails CLOSED: throws `AgentSessionError` on a missing key, WebSocket error, or timeout.
 */
export async function streamingTranscribe(
  pcm: Uint8Array,
  env: AgentTurnEnv,
): Promise<SttResult> {
  const apiKey = env.DEEPGRAM_API_KEY;
  if (!apiKey) {
    throw new AgentSessionError("STT_NOT_CONFIGURED", "DEEPGRAM_API_KEY not provisioned", 503);
  }

  // Deepgram streaming listen — linear16 PCM @ 48 kHz / stereo, endpointing enabled so the
  // server flushes the final transcript as soon as it detects the end of the utterance.
  const params = new URLSearchParams({
    encoding: "linear16",
    sample_rate: "48000",
    channels: "2",
    interim_results: "false",
    smart_format: "true",
    endpointing: "300",
    utterance_end_ms: "1000",
  });
  const url = `wss://api.deepgram.com/v1/listen?${params}`;

  return new Promise<SttResult>((resolve, reject) => {
    // The CF Workers runtime exposes the standard browser WebSocket constructor for outbound
    // connections from DOs. The @cloudflare/workers-types package only types the hibernation
    // (server-side) WebSocket; we bridge via the OutboundWebSocket interface above.
    const ws = new (globalThis.WebSocket as unknown as new (url: string, protocols?: string | string[]) => OutboundWebSocket)(url, ["token", apiKey]);
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
        reject(new AgentSessionError("STT_TIMEOUT", "Deepgram streaming STT timed out", 504));
      }
    }, STREAMING_TIMEOUT_MS);

    ws.onopen = () => {
      // Stream the full PCM buffer in CHUNK_SIZE slices — Deepgram processes incrementally.
      for (let off = 0; off < pcm.length; off += CHUNK_SIZE) {
        ws.send(pcm.slice(off, off + CHUNK_SIZE));
      }
      // Signal end-of-audio so Deepgram flushes the final transcript.
      ws.send(JSON.stringify({ type: "CloseStream" }));
    };

    ws.onmessage = (ev) => {
      if (settled) return;
      try {
        const msg = JSON.parse(
          typeof ev.data === "string" ? ev.data : new TextDecoder().decode(ev.data),
        ) as {
          channel?: { alternatives?: Array<{ transcript?: string }> };
          is_final?: boolean;
        };
        const alt = msg.channel?.alternatives?.[0]?.transcript;
        if (typeof alt === "string" && alt.length > 0) transcript = alt;
        if (msg.is_final === true) {
          settled = true;
          clearTimeout(timeout);
          try {
            ws.close();
          } catch {
            /* already closing */
          }
          resolve({ isFinal: true, transcript });
        }
      } catch {
        // Malformed message — ignore and wait for a valid one.
      }
    };

    ws.onerror = () => {
      if (!settled) {
        settled = true;
        clearTimeout(timeout);
        reject(new AgentSessionError("STT_UPSTREAM", "Deepgram WebSocket error", 502));
      }
    };

    ws.onclose = () => {
      // Reject closures that do not carry a validated final result.
        
            if (!settled) {
        settled = true;
        clearTimeout(timeout);
        reject(new AgentSessionError("STT_UPSTREAM", "Deepgram WebSocket closed before final result", 502));
      }
    };
  });
}
