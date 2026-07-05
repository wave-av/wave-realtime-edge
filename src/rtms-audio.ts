/**
 * Zoom RTMS audio transcode (#88 Zoom→wave bridge).
 *
 * Zoom Real-Time Media Streams deliver audio as MEDIA_DATA_AUDIO frames carrying
 * PCM `s16le`, 16 kHz, MONO (verified from Zoom's reference mock server:
 * `ffmpeg -f s16le -acodec pcm_s16le -ar 16000 -ac 1`). The CF Realtime SFU
 * media-transport adapter carries 16-bit LE PCM, 48 kHz, STEREO — the same
 * VERIFIED target `telephony-codec.ts` feeds for the Twilio bridge.
 *
 * This is the pure, deterministic transcode between those two worlds. No I/O:
 * the WebSocket handler that consumes it lands with the live-meeting spike
 * (Jake starts a Zoom meeting → RTMS pushes frames). Isolating the codec here
 * lets it be fully unit-tested now with zero prod exposure.
 *
 * We reuse the channel helpers from telephony-codec (shared with the Twilio
 * path); only the resample ratio differs (16 k↔48 k is ×3, vs 8 k↔48 k ×6).
 */

import { monoToStereo, stereoToMono } from "./telephony-codec.js";

const RTMS_UPSAMPLE_FACTOR = 3; // 16 kHz → 48 kHz

/** Zoom RTMS audio sample-rate enum (from the mock server AUDIO_SAMPLE_RATE table). */
export const RTMS_AUDIO_SAMPLE_RATE = {
  SR_8K: 0,
  SR_16K: 1,
  SR_32K: 2,
  SR_48K: 3,
} as const;

/** Decode a little-endian s16 PCM byte buffer into Int16 samples. */
export function pcmS16LeToInt16(bytes: Uint8Array): Int16Array {
  // Copy through a DataView so we honour LE byte order regardless of platform
  // endianness and any non-2-aligned offset of the incoming Uint8Array.
  const n = bytes.length >> 1;
  const out = new Int16Array(n);
  const view = new DataView(bytes.buffer, bytes.byteOffset, n * 2);
  for (let i = 0; i < n; i++) out[i] = view.getInt16(i * 2, true);
  return out;
}

/** Encode Int16 samples into a little-endian s16 PCM byte buffer. */
export function int16ToPcmS16Le(samples: Int16Array): Uint8Array {
  const out = new Uint8Array(samples.length * 2);
  const view = new DataView(out.buffer);
  for (let i = 0; i < samples.length; i++) view.setInt16(i * 2, samples[i]!, true);
  return out;
}

/**
 * Upsample 16 kHz → 48 kHz by linear interpolation (×3). Adequate for Zoom's
 * 16 kHz wideband voice; swap for a polyphase FIR if fidelity ever requires.
 */
export function upsample16kTo48k(pcm16k: Int16Array): Int16Array {
  const n = pcm16k.length;
  if (n === 0) return new Int16Array(0);
  const out = new Int16Array(n * RTMS_UPSAMPLE_FACTOR);
  for (let i = 0; i < n; i++) {
    const cur = pcm16k[i]!;
    const next = i + 1 < n ? pcm16k[i + 1]! : cur;
    for (let k = 0; k < RTMS_UPSAMPLE_FACTOR; k++) {
      const t = k / RTMS_UPSAMPLE_FACTOR;
      out[i * RTMS_UPSAMPLE_FACTOR + k] = Math.round(cur + (next - cur) * t);
    }
  }
  return out;
}

/**
 * Downsample 48 kHz → 16 kHz by 3-tap box averaging + decimation — a crude
 * anti-alias low-pass sufficient for voice. Output length = floor(input/3).
 */
export function downsample48kTo16k(pcm48k: Int16Array): Int16Array {
  const n = Math.floor(pcm48k.length / RTMS_UPSAMPLE_FACTOR);
  const out = new Int16Array(n);
  for (let i = 0; i < n; i++) {
    let sum = 0;
    for (let k = 0; k < RTMS_UPSAMPLE_FACTOR; k++) sum += pcm48k[i * RTMS_UPSAMPLE_FACTOR + k]!;
    out[i] = Math.round(sum / RTMS_UPSAMPLE_FACTOR);
  }
  return out;
}

/**
 * Zoom RTMS → SFU: PCM s16le (16 kHz mono) bytes → Int16 PCM (48 kHz stereo,
 * interleaved). This is what the bridge feeds into the CF Realtime ingest adapter.
 */
export function rtmsAudioToSfuPcm(rtmsPcmBytes: Uint8Array): Int16Array {
  return monoToStereo(upsample16kTo48k(pcmS16LeToInt16(rtmsPcmBytes)));
}

/**
 * SFU → Zoom RTMS: Int16 PCM (48 kHz stereo, interleaved) → PCM s16le
 * (16 kHz mono) bytes. Provided for symmetry / talk-back paths.
 */
export function sfuPcmToRtmsAudio(pcm48kStereo: Int16Array): Uint8Array {
  return int16ToPcmS16Le(downsample48kTo16k(stereoToMono(pcm48kStereo)));
}
