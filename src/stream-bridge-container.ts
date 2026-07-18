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

/**
 * The subset of the Worker Env this DO forwards into the container. These are `wrangler secret put` /
 * `[vars]` bindings on the WORKER — `@cloudflare/containers` does NOT inherit Worker bindings into the
 * container, so each must be handed across explicitly via `envVars` (see constructor). Names match exactly
 * what `containers/stream-bridge/server/index.mjs` reads (`process.env.*`).
 *
 * SOURCE = LL-HLS (#35/#211, v5 image): the container reads LLHLS_SRC_URL_TEMPLATE (or LLHLS_SRC_URL) for
 * the live_input manifest URL. The old WHEP_SRC_URL_TEMPLATE / WHEP_SRC_URL names are REMOVED — those were
 * the pre-v5 WHEP-pull source vars; the v5 image never reads them (index.mjs only reads LLHLS_* keys). A
 * mismatch here (forwarding WHEP_* when the image reads LLHLS_*) = empty sourceUrl → relay throws
 * "hlsPull: srcUrl is required" on every /start → bridge silently fails while the container appears healthy.
 */
export interface StreamBridgeContainerEnv {
  LLHLS_SRC_URL_TEMPLATE?: string; // SECRET. LL-HLS manifest URL template ({uid} placeholder) — primary source
  LLHLS_SRC_URL?: string; // SECRET. Explicit LL-HLS manifest URL — fallback when no template (single input)
  WHIP_DST_URL?: string; // SECRET. SFU WHIP publish endpoint the relay republishes into
  WHIP_KEY?: string; // SECRET. Bridge wk_ key authorizing the WHIP publish (resolved server-side by the gateway)
  SOURCE_AUTH?: string; // SECRET (optional). Bearer for a signed/token-gated LL-HLS source manifest (contract Q-2)
}

/** The container env keys, in the order the server reads them; only DEFINED values are forwarded. */
const FORWARDED_ENV_KEYS = [
  "LLHLS_SRC_URL_TEMPLATE",
  "LLHLS_SRC_URL",
  "WHIP_DST_URL",
  "WHIP_KEY",
  "SOURCE_AUTH",
] as const satisfies readonly (keyof StreamBridgeContainerEnv)[];

/** Path A — the WAVE-owned whep-to-whip republisher container. Same image self-hosts for Path B (no DO there). */
export class StreamBridgeContainer extends Container<StreamBridgeContainerEnv> {
  defaultPort = 8080;
  sleepAfter = "5m";

  constructor(ctx: DurableObjectState<StreamBridgeContainerEnv>, env: StreamBridgeContainerEnv) {
    super(ctx, env);
    // Worker bindings are NOT inherited by the container — forward the WHEP/WHIP secrets explicitly. Omit
    // undefined so we never set empty-string env (the server treats absence and "" differently).
    const forwarded: Record<string, string> = {};
    for (const key of FORWARDED_ENV_KEYS) {
      const value = env[key];
      if (value !== undefined) forwarded[key] = value;
    }
    this.envVars = forwarded;
  }
}
