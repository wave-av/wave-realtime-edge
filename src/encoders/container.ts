/// <reference types="@cloudflare/workers-types" />
/**
 * RT-P1.5 — Adapter A: CF Container WAVE-owned encoder (design §3) — SCAFFOLD ONLY.
 *
 * BLOCKED-ON-RT-P0.1-spike: A taps published tracks over the CF Realtime WS media-transport adapter
 * (PCM audio + JPEG video frames), encodes (JPEG→VP8, PCM→Opus), muxes via the WAVE WebM muxer (§5), and
 * streams the result into the SKIP-tier `RealtimeRecorder`. The WS endpoint URL + frame schema + auth are
 * un-modelled in `sfu.ts` and gated on the §7 spike (◆ when deployed against the live CF-Calls app). Until
 * the spike returns receipts, A cannot be built green — so this is an INTENTIONAL stub that fails loud.
 *
 * This file is NOT part of the buildable RT-P1.5 slice; it exists so the factory's switch is exhaustive and
 * so the seam is visible. It NEVER imports `@wave-av/content-hash` (the muxer it will use is SKIP-clean).
 */
import type { EncoderEnv, EncoderHandle, RecordingEncoder, RecordingSession } from "./encoder.js";

const NOT_SPIKED =
  "RT-P1.5 adapter A (CF Container) is BLOCKED-ON-RT-P0.1-spike (design §3/§7): the CF Realtime WS " +
  "media-transport endpoint + frame schema + auth are not yet captured. Build after the spike returns receipts.";

export class ContainerEncoder implements RecordingEncoder {
  readonly kind = "container" as const;
  constructor(private readonly env: EncoderEnv) {}
  async begin(_session: RecordingSession): Promise<EncoderHandle | null> {
    throw new Error(NOT_SPIKED);
  }
}
