/// <reference types="@cloudflare/workers-types" />
/**
 * RT-R10 (#72) — RecorderContainer: the Container Durable Object class for Path A (CF Containers).
 *
 * Mirrors wave-bridge-edge's `MoqContainer` verbatim (the PROVEN CF-Containers precedent on account d674452f):
 *   import { Container } from '@cloudflare/containers'; class X extends Container { defaultPort=8080; sleepAfter='5m' }
 * The Worker reaches it via `getContainer(env.RECORDER, id).fetch('/encode')` (see CfContainerTarget in
 * recorder-target.ts) to transcode JPEG→VP8 / PCM→Opus — work the Workers isolate can't host (no libvpx/libopus).
 *
 * INERT: the matching `[[containers]] RECORDER` + `[[durable_objects.bindings]]` blocks in wrangler.toml stay
 * COMMENTED until a Jake-named ◆ attach. Exporting the class costs nothing at rest — it only becomes a live
 * container when the binding + image are provisioned. `defaultPort` matches the rt-encoder server's PORT (8080);
 * `sleepAfter` lets an idle encoder instance hibernate (cost control), exactly like MoqContainer.
 *
 * PURE TRANSCODE: this DO holds NO R2, NO recording state — the canonical object is owned by the RoomDO /
 * RealtimeRecorder (single-writer / A-DO invariant). NEVER imports `@wave-av/content-hash` (SKIP; bundle-guarded).
 */
import { Container } from "@cloudflare/containers";

/**
 * #136 (Canary C1) — the worker-env keys whose presence arms a container-side encode behaviour. The rt-encoder
 * server gates on `process.env.AV1_DEFAULT` (command.mjs:av1DefaultEnabled) and `process.env.NEGOTIATION_ENABLED`
 * (negotiate.mjs:negotiationEnabled), each default-OFF. We forward ONLY the keys the worker env actually sets, so
 * a worker env that sets neither (PROD / the live #127 recorder) yields an EMPTY forward set → `this.envVars`
 * stays undefined → the container starts byte-identically to today. The CANARY worker env sets both → the
 * container receives them and runs AV1 + negotiation. NO other worker secret/var is ever forwarded.
 */
const FORWARDED_CONTAINER_ENV_KEYS = ["AV1_DEFAULT", "NEGOTIATION_ENABLED"] as const;

/** Minimal shape we read off the worker env: the optional encode-flag vars, nothing else. */
interface RecorderContainerEnv {
  AV1_DEFAULT?: string;
  NEGOTIATION_ENABLED?: string;
}

/**
 * Build the container env-var forward set from the worker env. Returns the subset of FORWARDED_CONTAINER_ENV_KEYS
 * that are PRESENT and non-empty on the worker env (absent/"" keys are omitted entirely so the container's own
 * default-off gates apply). Returns `undefined` when nothing is forwarded → the Container starts with no override.
 */
export function recorderContainerEnvVars(env: RecorderContainerEnv | undefined): Record<string, string> | undefined {
  if (!env) return undefined;
  const out: Record<string, string> = {};
  for (const key of FORWARDED_CONTAINER_ENV_KEYS) {
    const v = env[key];
    if (typeof v === "string" && v.length > 0) out[key] = v;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/** Path A — the WAVE-owned portable encode container. Same image self-hosts for Path B (no DO there). */
export class RecorderContainer extends Container<RecorderContainerEnv> {
  defaultPort = 8080;
  sleepAfter = "5m";

  constructor(ctx: ConstructorParameters<typeof Container>[0], env: RecorderContainerEnv) {
    super(ctx, env);
    // #136 Canary: forward AV1_DEFAULT / NEGOTIATION_ENABLED into the container process ONLY when the worker env
    // sets them. PROD sets neither → `envVars` stays undefined → byte-identical container start. The canary
    // worker sets both → the encode container runs AV1 + negotiation. `start()` consumes `this.envVars`.
    const forwarded = recorderContainerEnvVars(env);
    if (forwarded) this.envVars = forwarded;
  }
}
