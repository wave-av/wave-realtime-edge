// Task #81 step 7 — minimal WAV/RIFF wrapper for the agent egress PCM.
//
// The egress/ingest PCM is raw 16-bit LE, 48 kHz, STEREO (agent-ingest-adapter.ts). The WAVE transcribe
// spoke (and its engines: CF Whisper / Deepgram nova-3 / ElevenLabs Scribe) need a CONTAINER mime, not
// headerless raw PCM. We wrap the buffer in a standard 44-byte canonical WAV header before POST. Pure +
// byte-exact → unit-testable, zero transcode (the engines accept 48k/16-bit PCM natively inside WAV).

/** Agent PCM source params (matches the egress/ingest path). */
export const PCM_SAMPLE_RATE = 48_000;
export const PCM_BITS_PER_SAMPLE = 16;
export const PCM_CHANNELS = 2;
/** The container mime to send to the transcribe spoke. */
export const WAV_MIME = "audio/wav";

const WAV_HEADER_BYTES = 44;

function writeAscii(view: DataView, offset: number, s: string): void {
  for (let i = 0; i < s.length; i++) view.setUint8(offset + i, s.charCodeAt(i));
}

/**
 * Wrap raw interleaved 16-bit LE PCM in a canonical 44-byte WAV/RIFF header. Pure: returns a NEW buffer
 * (header + the PCM bytes copied in). Defaults match the agent egress codec (48 kHz / 16-bit / stereo).
 */
export function pcmToWav(
  pcm: Uint8Array,
  sampleRate: number = PCM_SAMPLE_RATE,
  channels: number = PCM_CHANNELS,
  bitsPerSample: number = PCM_BITS_PER_SAMPLE,
): Uint8Array {
  const dataLen = pcm.length;
  const blockAlign = (channels * bitsPerSample) >> 3;
  const byteRate = sampleRate * blockAlign;
  const out = new Uint8Array(WAV_HEADER_BYTES + dataLen);
  const view = new DataView(out.buffer);

  writeAscii(view, 0, "RIFF");
  view.setUint32(4, 36 + dataLen, true); // ChunkSize = 36 + Subchunk2Size
  writeAscii(view, 8, "WAVE");
  writeAscii(view, 12, "fmt ");
  view.setUint32(16, 16, true); // Subchunk1Size (PCM)
  view.setUint16(20, 1, true); // AudioFormat = 1 (PCM)
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitsPerSample, true);
  writeAscii(view, 36, "data");
  view.setUint32(40, dataLen, true); // Subchunk2Size

  out.set(pcm, WAV_HEADER_BYTES);
  return out;
}
