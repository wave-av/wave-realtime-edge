/**
 * #91 B2 — whep-to-whip relay orchestration (frozen-contract §5: `whep-pull → (passthrough) → publish`).
 *
 * This is the GPU/runtime-agnostic CORE of the republisher, dependency-injected so it unit-tests with NO
 * werift / no live network (the WebRTC stack + RTP wiring live in index.mjs). `pull` and `publish` are the
 * `@wave-av/whip-publish` v0.2.0 exports; `pcFactory` builds a werift `RTCPeerConnection` for each leg.
 *
 * Flow:
 *   1. `pull({ whepUrl, pcFactory, onTrack })` — open the WHEP-in leg; collect inbound tracks as they arrive.
 *   2. once the WHEP leg reaches `connected` (its tracks are present), `publish({ endpoint: whipUrl,
 *      key: whipKey, source: { tracks }, pcFactory })` — the WHIP-out leg republishes the SAME tracks
 *      VERBATIM (relay source mode, #758 — addTrack, zero transcode).
 *   3. `stop()` tears BOTH legs down (idempotent): WHIP DELETE → SFU close, then WHEP DELETE → close.
 *
 * Fail-LOUD (frozen invariant §9.5): a WHEP failure (no live egress) or a WHIP-out failure throws — there is
 * no silent HLS fallback. The caller (index.mjs `/start`) surfaces the error so B1's reconcile re-dispatches.
 *
 * NOTE (proven-live scope): the WHEP→WHIP *RTP forwarding* itself (received track → outbound sender) is a
 * werift-runtime concern wired in index.mjs and is proven only at ◆ go-live (§7.6: real RTMPS push → an SFU
 * track id). This module proves the ORCHESTRATION (pull→collect→publish→teardown), which is what unit-tests
 * can assert without live media.
 */

/**
 * Run one whep-to-whip relay. Resolves once the WHIP-out leg is established (returns a handle with `stop`);
 * rejects (fail-loud) if either leg fails to come up.
 *
 * @param {object} o
 * @param {string} o.whepUrl  - the CF Stream live_input WHEP play URL (WHEP-in).
 * @param {string} o.whipUrl  - the gateway WHIP endpoint (https://gateway.wave.online/v1/whip/publish).
 * @param {string} o.whipKey  - the bridge `wk_` key (gateway derives org/keyId server-side from it).
 * @param {string} [o.whepAuth] - optional Bearer for a signed/token-gated WHEP source (contract Q-2).
 * @param {Function} o.pull    - `@wave-av/whip-publish` pull().
 * @param {Function} o.publish - `@wave-av/whip-publish` publish().
 * @param {Function} o.pcFactory - builds an RTCPeerConnection (werift) per leg.
 * @param {Function} [o.adaptTrack] - maps a WHEP-in received track to the WHIP-out publish track. Default
 *   identity (unit tests). index.mjs supplies the werift adapter: a NEW writable relay track fed by the
 *   received track's `onReceiveRtp` (werift can't republish a received track object directly).
 * @param {Function} [o.log]   - structured logger (defaults to no-op).
 * @returns {Promise<{stop: () => Promise<void>, trackCount: number}>}
 */
export async function runRelay(o) {
  const { whepUrl, whipUrl, whipKey, whepAuth, pull, publish, pcFactory } = o;
  const adaptTrack = o.adaptTrack ?? ((t) => t);
  const log = o.log ?? (() => {});

  if (!whepUrl) throw new Error("runRelay: whepUrl is required");
  if (!whipUrl) throw new Error("runRelay: whipUrl is required");
  if (!whipKey) throw new Error("runRelay: whipKey is required (bridge wk_ key)");

  const tracks = [];
  let whipSession = null;
  let whepSession = null;
  let stopped = false;

  const stop = async () => {
    if (stopped) return;
    stopped = true;
    // WHIP-out first (stop the SFU publish + meter), then WHEP-in. Both best-effort; never mask the first error.
    try {
      await whipSession?.stop();
    } catch (e) {
      log("relay-whip-stop-error", { message: String(e).slice(0, 200) });
    }
    try {
      await whepSession?.stop();
    } catch (e) {
      log("relay-whep-stop-error", { message: String(e).slice(0, 200) });
    }
    log("relay-stopped", { tracks: tracks.length });
  };

  try {
    // 1. WHEP-in: open the pull leg, collect inbound tracks, resolve when connected.
    const connected = new Promise((resolve, reject) => {
      whepSession = undefined; // assigned by pull() below; guard the race in onState
      const onTrack = (track) => {
        tracks.push(adaptTrack(track)); // identity in tests; werift relay-track mapping in index.mjs
        log("relay-whep-track", { kind: track?.kind, total: tracks.length });
      };
      const onState = (state) => {
        log("relay-whep-state", { state });
        if (state === "connected") resolve();
        else if (state === "failed") reject(new Error("WHEP-in leg failed (no live egress)"));
      };
      pull({ whepUrl, auth: whepAuth, onTrack, onState, pcFactory })
        .then((s) => {
          whepSession = s;
          // If the leg connected before the promise wiring (fast fake), the onState above already resolved.
        })
        .catch(reject);
    });
    await connected;

    if (tracks.length === 0) {
      // A connected WHEP leg with no media is a misconfigured source — fail loud rather than publish nothing.
      throw new Error("WHEP-in connected but surfaced no tracks");
    }

    // 2. WHIP-out: republish the collected tracks verbatim (relay source mode, #758 — no transcode).
    whipSession = await publish({
      endpoint: whipUrl,
      key: whipKey,
      source: { tracks },
      pcFactory,
      onState: (state) => log("relay-whip-state", { state }),
    });
    log("relay-up", { tracks: tracks.length, resource: whipSession?.resourceUrl });

    return { stop, get trackCount() { return tracks.length; } };
  } catch (err) {
    // Fail-loud: tear down whatever came up, then rethrow the original cause.
    await stop().catch(() => {});
    throw err;
  }
}
