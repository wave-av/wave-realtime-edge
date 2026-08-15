/// <reference types="@cloudflare/workers-types" />
/**
 * #314 slice g-prep — MoqPublishContainer: the Container Durable Object class the per-participant MoQ egress
 * path (moq-forward-target.ts) reaches via `getContainer(env.MOQ_PUBLISH, "${org}:${meetingUuid}")`. Mirrors
 * `RecorderContainer` (recorder-container.ts) verbatim — same `@cloudflare/containers` Container subclass shape,
 * same defaultPort/sleepAfter — which itself mirrors wave-bridge-edge's proven `MoqContainer` on account d674452f.
 *
 * INERT: the matching `[[containers]] MOQ_PUBLISH` + `[[durable_objects.bindings]]` blocks in wrangler.toml stay
 * COMMENTED until a Jake-named ◆ attach (see #314). Exporting the class costs nothing at rest — it only becomes
 * a live container when the binding + image are provisioned. With `env.MOQ_PUBLISH` unbound,
 * `createMoqForwardTarget` (moq-forward-target.ts) returns null and the whole per-participant egress path never
 * reaches this class.
 *
 * PURE TRANSCODE/PUBLISH RELAY: this DO holds NO room/participant state — the canonical state is owned by
 * ZoomRtmsBridgeDO (single-writer / A-DO invariant). NEVER imports `@wave-av/content-hash` (SKIP; bundle-guarded).
 */
import { Container } from "@cloudflare/containers";

/** Path A-style container the worker reaches for per-participant MoQ publish (encode + relay to MoQ egress). */
export class MoqPublishContainer extends Container {
  defaultPort = 8080;
  sleepAfter = "5m";
}
