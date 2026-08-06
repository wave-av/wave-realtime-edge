// wave-voice-program E1 — MINIMAL ambient declarations for the handful of Node builtins the E1 latency harness
// uses. This repo compiles against `@cloudflare/workers-types` ONLY (tsconfig `types`), deliberately: the worker
// source must never see Node globals. But vitest runs in the `node` environment, and the E1 LIVE harness needs to
// synthesize its own real speech locally (`say` + `afconvert`) and read the resulting WAV. Declaring the exact
// three symbols used here — rather than adding `@types/node` to the project — keeps the worker's type surface
// unchanged (no Node globals leak into src/) while `tsc --noEmit` stays clean. Same pattern as
// rt-encoder-server.d.ts (#135).
declare module "node:child_process" {
  export function execFileSync(file: string, args: readonly string[]): unknown;
}

declare module "node:fs" {
  /** The subset of Node's Buffer the E1 harness touches (RIFF chunk walk over the generated WAV). */
  interface NodeBufferLike extends Uint8Array {
    toString(encoding: string, start: number, end: number): string;
    readUInt32LE(offset: number): number;
  }
  export function readFileSync(path: string): NodeBufferLike;
}

declare module "node:os" {
  export function tmpdir(): string;
}

/** Only `process.env` is read (E1_LIVE / E1_SAMPLES + the doppler-injected creds). */
declare const process: { env: Record<string, string | undefined> };
