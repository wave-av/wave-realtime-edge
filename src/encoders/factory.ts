/**
 * RT-P1.5 — `selectEncoder` factory + `DisarmedEncoder` (design §1).
 *
 * The factory picks the adapter from env (`RT_ENCODER`, default "managed" = C), and DEFAULTS OFF: unless
 * `RT_RECORD==="1"`, it returns a `DisarmedEncoder` whose `begin` is a no-op (`null`). This makes the whole
 * feature INERT until armed — config-no-silent-noop compliant, deployable as a dormant capability.
 *
 * Every armed adapter's terminal action is `recorder.append`/`finalize` on the SKIP-tier `RealtimeRecorder`
 * — that single sink mechanically guarantees the SKIP invariant. NOTHING here imports `@wave-av/content-hash`.
 *
 * A (container) and B (wasm) are BLOCKED-ON-RT-P0.1-spike scaffolds: selecting them while armed throws loud
 * (NOT_SPIKED) — never a silent no-op. C (managed) is the buildable, shippable path.
 */
import type { EncoderEnv, EncoderHandle, RecordingEncoder, RecordingSession } from "./encoder.js";
import { ManagedEncoder } from "./managed.js";
import { ContainerEncoder, type ContainerEncoderDeps } from "./container.js";
import { WasmEncoder } from "./wasm.js";

/**
 * RT-R10 (#72) — optional deps the host runtime supplies. On the Worker this is empty (the default), keeping the
 * container path byte-identical. A self-host runtime passes `{ localWriterFor }` so `RECORDER_SINK=localfs|fanout`
 * lands a real local file (the Node fs writer stays out of the Worker bundle — it is injected, not imported here).
 */
export interface SelectEncoderDeps {
  container?: ContainerEncoderDeps;
}

/** The inert encoder: recording is disarmed, so `begin` records nothing and returns null. */
export class DisarmedEncoder implements RecordingEncoder {
  readonly kind = "managed" as const; // nominal; never armed
  async begin(_session: RecordingSession): Promise<EncoderHandle | null> {
    return null;
  }
}

/**
 * Select the recording encoder for this env. Disarmed (inert) unless `RT_RECORD==="1"`. When armed, the
 * adapter is chosen by `RT_ENCODER` (default "managed"); A/B throw NOT_SPIKED at `begin` until the §7 spike.
 */
export function selectEncoder(env: EncoderEnv, deps: SelectEncoderDeps = {}): RecordingEncoder {
  if (env.RT_RECORD !== "1") return new DisarmedEncoder(); // inert default
  switch (env.RT_ENCODER ?? "managed") {
    case "container":
      return new ContainerEncoder(env, deps.container); // A — BLOCKED-ON-RT-P0.1-spike
    case "wasm":
      return new WasmEncoder(env); // B — BLOCKED-ON-RT-P0.1-spike + feasibility-gated
    case "managed":
    default:
      return new ManagedEncoder(env); // C — the buildable, shippable path
  }
}
