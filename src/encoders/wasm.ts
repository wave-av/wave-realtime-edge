/// <reference types="@cloudflare/workers-types" />
/**
 * RT-P1.5 — Adapter B: in-worker WASM ffmpeg encoder (design §4) — SCAFFOLD ONLY.
 *
 * BLOCKED-ON-RT-P0.1-spike + feasibility-gated: B taps the same WS media-transport frames as A but encodes
 * + muxes inside the Worker/DO via a WASM ffmpeg build, removing the Container hop for low-volume / small
 * rooms. It is gated on (a) the §7 WS spike (same as A) AND (b) the Worker/DO 128 MB + CPU-time budget —
 * full-motion video likely exceeds the isolate (that is precisely why A/Container is the durable target);
 * B is viable for audio-only / low-FPS as a no-Container fallback. Build LAST.
 *
 * This is an INTENTIONAL stub that fails loud — NOT part of the buildable RT-P1.5 slice. It NEVER imports
 * `@wave-av/content-hash`.
 */
import type { EncoderEnv, EncoderHandle, RecordingEncoder, RecordingSession } from "./encoder.js";

const NOT_SPIKED =
  "RT-P1.5 adapter B (ffmpeg.wasm) is BLOCKED-ON-RT-P0.1-spike (design §4/§7) and feasibility-gated on the " +
  "Worker/DO 128 MB + CPU budget. Build LAST, after the WS spike + a bundle-size/feasibility check.";

export class WasmEncoder implements RecordingEncoder {
  readonly kind = "wasm" as const;
  constructor(private readonly env: EncoderEnv) {}
  async begin(_session: RecordingSession): Promise<EncoderHandle | null> {
    throw new Error(NOT_SPIKED);
  }
}
