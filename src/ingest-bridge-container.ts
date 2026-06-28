/// <reference types="@cloudflare/workers-types" />
/**
 * F (#55) — Per-protocol direct-ingest (Plane-2) Container Durable Object classes. Mirrors
 * `StreamBridgeContainer` (#91 B2): thin `@cloudflare/containers` subclasses; ALL media work (terminate the
 * contribution protocol, demux, decode, re-encode to a WebRTC-negotiable codec, WHIP-publish) lives in the
 * per-protocol container IMAGES (Builder A / per-protocol Dockerfiles, OUT of scope here), NEVER in the
 * Workers isolate (frozen invariant #2 / contract §9.2). This file declares ONLY the Worker-side binding
 * shape so the control plane can reach a container by the deterministic `${org}:${room}` DO id:
 *   getContainer(env.<PROTO>_BRIDGE, `${org}:${room}`).fetch('/start' | '/stop')   (see ingest-bridge.ts)
 *
 * INERT: the matching `[[containers]]` + `[[durable_objects.bindings]]` blocks in wrangler.toml stay COMMENTED
 * until each leg's Jake-named ◆ go-live (per-protocol image build + bridge wk_ key + INGEST_BRIDGE_ENABLED=1 +
 * the per-protocol binding). Exporting these classes costs nothing at rest — a class only becomes a live
 * container when its binding + image are provisioned. `defaultPort`/`sleepAfter` match the stream-bridge
 * container (8080 / idle-hibernate for cost control).
 *
 * One class per protocol so each leg builds + arms + meters + sleeps independently (the §6 non-overlapping
 * builder split). The per-protocol MODE/engine (ffmpeg srt/rtmp · librist · moq-rs/moq.ts) is the container
 * image's concern, selected by env in the image — not modeled here.
 */
import { Container } from "@cloudflare/containers";

/** SRT direct-ingest republisher container (non-CF host or CF-managed SRT ingest; contract §4). */
export class SrtBridgeContainer extends Container {
  defaultPort = 8080;
  sleepAfter = "5m";
}

/** RIST direct-ingest republisher container (librist; non-CF host only; contract §4). */
export class RistBridgeContainer extends Container {
  defaultPort = 8080;
  sleepAfter = "5m";
}

/** RTMPS direct-ingest republisher container (ffmpeg listener; non-CF host or CF Stream reuse; contract §4). */
export class RtmpsBridgeContainer extends Container {
  defaultPort = 8080;
  sleepAfter = "5m";
}

/** MoQ direct-ingest republisher container (CF-native; first ◆ candidate; contract §4/§6-A). */
export class MoqBridgeContainer extends Container {
  defaultPort = 8080;
  sleepAfter = "5m";
}
