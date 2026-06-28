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

/** Path A — the WAVE-owned portable encode container. Same image self-hosts for Path B (no DO there). */
export class RecorderContainer extends Container {
  defaultPort = 8080;
  sleepAfter = "5m";
}
