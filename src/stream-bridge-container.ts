/// <reference types="@cloudflare/workers-types" />
/**
 * #91 B2 — StreamBridgeContainer: the Container Durable Object class for the CF Stream → SFU bridge
 * republisher (`MODE=whep-to-whip`, frozen-contract §5). Mirrors `RecorderContainer` (#72): a thin
 * `@cloudflare/containers` subclass; the media work lives in `containers/stream-bridge/` (a Node WebRTC
 * relay), NOT in the Workers isolate (no UDP/DTLS-SRTP/RTP — the honest-501 wall, §0).
 *
 * The B1 control plane reaches it by the deterministic `${org}:${uid}` DO id:
 *   getContainer(env.STREAM_BRIDGE, `${org}:${uid}`).fetch('/start' | '/stop')   (see stream-bridge.ts)
 * `/start` (body `{room, uid}`) pulls the live_input's WHEP and republishes it through the EXISTING
 * `/v1/whip/publish` gateway path into the SFU; `/stop` tears the relay down (WHIP DELETE → SFU close →
 * stop meter). Media terminates in the container + the SFU, never on a Worker (frozen invariant §9.2).
 *
 * INERT: the matching `[[containers]] StreamBridgeContainer` + `[[durable_objects.bindings]]` blocks in
 * wrangler.toml stay COMMENTED until a Jake-named ◆ go-live (image build + bridge `wk_` key mint + webhook
 * secret + `STREAM_BRIDGE_ENABLED=1`). Exporting the class costs nothing at rest — it only becomes a live
 * container when the binding + image are provisioned. `defaultPort` matches the container server's PORT
 * (8080); `sleepAfter` lets an idle republisher hibernate (cost control), exactly like RecorderContainer.
 *
 * PURE RELAY: this DO holds NO R2, NO media state, NO creds beyond the per-start control payload — the
 * canonical recording is owned downstream by the RoomDO/recorder (single-writer / A-DO invariant). The
 * bridge `wk_` key lives container-side (env), resolved server-side by the gateway from the key (§9.1).
 */
import { Container } from "@cloudflare/containers";

/** Path A — the WAVE-owned whep-to-whip republisher container. Same image self-hosts for Path B (no DO there). */
export class StreamBridgeContainer extends Container {
  defaultPort = 8080;
  sleepAfter = "5m";
}
