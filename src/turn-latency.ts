// wave-realtime-edge — voice-agent turn-latency measurement harness (E1 Task 7).
//
// E1's Done-check requires the p50/p95 per-hop latency over ≥30 turns — first-audio-byte from
// end-of-user-speech — with the command that produced it. This module is the PURE, testable half:
// one sample shape, one collector, and the percentile math. The timing MARKS live in agent-turn.ts
// (additive `deps.now()` timestamps at the four hop boundaries — no core rewrite, per the E1 hard-gate).
//
// The four hops (the sub-second budget E1 budgets explicitly):
//   1. end-of-user-speech → STT-final        (the batch-STT named risk)
//   2. STT-final → LLM-first-token
//   3. LLM-first-token → TTS-first-audio-byte
//   4. (total) end-of-user-speech → first-audio-byte

/** One turn's four timestamps (ms epoch, from deps.now()). All optional — a hop that never ran (e.g. a
 *  tool turn with no spoken reply) just leaves its mark undefined, and the collector skips it. */
export interface TurnHopMarks {
  turnId: string;
  speechEndMs: number;
  sttFinalMs?: number;
  llmFirstTokenMs?: number;
  ttsFirstAudioMs?: number;
}

/** Per-hop latency deltas, derived from the marks. A hop with a missing boundary is null (skipped). */
export interface TurnHopLatency {
  turnId: string;
  sttMs: number | null;
  llmMs: number | null;
  ttsMs: number | null;
  totalMs: number | null;
}

export function hopLatencies(m: TurnHopMarks): TurnHopLatency {
  return {
    turnId: m.turnId,
    sttMs: m.sttFinalMs !== undefined ? m.sttFinalMs - m.speechEndMs : null,
    llmMs: m.llmFirstTokenMs !== undefined && m.sttFinalMs !== undefined ? m.llmFirstTokenMs - m.sttFinalMs : null,
    ttsMs: m.ttsFirstAudioMs !== undefined && m.llmFirstTokenMs !== undefined ? m.ttsFirstAudioMs - m.llmFirstTokenMs : null,
    totalMs: m.ttsFirstAudioMs !== undefined ? m.ttsFirstAudioMs - m.speechEndMs : null,
  };
}

/** p50 and p95 over a list of numbers (nearest-rank, no interpolation — sufficient for the receipt). */
export function p50p95(nums: number[]): { p50: number; p95: number; n: number } {
  if (nums.length === 0) return { p50: 0, p95: 0, n: 0 };
  const sorted = [...nums].sort((a, b) => a - b);
  const q = (p: number) => sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
  return { p50: q(50), p95: q(95), n: sorted.length };
}

export interface HopDistribution {
  hop: "stt" | "llm" | "tts" | "total";
  p50: number;
  p95: number;
  n: number;
}

/** Collect ≥30 turns' marks and emit the per-hop p50/p95 distribution the Done-check names. */
export class LatencyCollector {
  private marks: TurnHopMarks[] = [];

  record(m: TurnHopMarks): void {
    this.marks.push(m);
  }

  count(): number {
    return this.marks.length;
  }

  distribution(): HopDistribution[] {
    const lat = this.marks.map(hopLatencies);
    const pick = (f: (l: TurnHopLatency) => number | null): number[] =>
      lat.map(f).filter((x): x is number => x !== null);
    return (
      (["stt", "llm", "tts", "total"] as const).map((hop) => {
        const { p50, p95, n } = p50p95(
          pick((l) => (hop === "stt" ? l.sttMs : hop === "llm" ? l.llmMs : hop === "tts" ? l.ttsMs : l.totalMs)),
        );
        return { hop, p50, p95, n };
      })
    );
  }
}
