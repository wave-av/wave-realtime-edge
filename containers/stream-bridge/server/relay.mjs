/**
 * #91 B2 / #35 — source-to-whip relay orchestration (contract §5: `source-pull → (passthrough) → publish`).
 *
 * This is the runtime-agnostic CORE of the republisher, dependency-injected so it unit-tests with NO werift /
 * no live network (the WebRTC stack + RTP wiring live in the injected source + index.mjs). `pull` is the source
 * leg (#35: LL-HLS via `./hls-source.mjs` `hlsPull` — see below), `publish` is `@wave-av/whip-publish` v0.2.0's
 * export; `pcFactory` builds a werift `RTCPeerConnection` for the WHIP-out leg.
 *
 * SOURCE = LL-HLS, not WHEP (#211, proven 2026-07-18): CF Stream Live's `/webRTC/play` (WHEP egress) serves ONLY
 * WHIP-ingested inputs (409 forever for RTMP/SRT), so the source is pulled over LL-HLS. `runRelay` is source-agnostic
 * — it only knows the `pull({ srcUrl, auth, onTrack, onState, pcFactory }) -> { stop }` contract — so swapping the
 * source touched only the injected `pull` (hls-source.mjs) + index.mjs's wiring; the WHIP-out leg is unchanged.
 *
 * Flow:
 *   1. `pull({ srcUrl, pcFactory, onTrack, onState })` — open the source leg; collect its tracks as they arrive.
 *   2. once the source leg reaches `connected` (its tracks are present), `publish({ endpoint: whipUrl,
 *      key: whipKey, source: { tracks }, pcFactory })` — the WHIP-out leg republishes the SAME tracks
 *      VERBATIM (relay source mode, #758 — addTrack, zero transcode).
 *   3. `stop()` tears BOTH legs down (idempotent): WHIP DELETE → SFU close, then source close.
 *
 * Fail-LOUD (frozen invariant §9.5): a source failure (no live media) or a WHIP-out failure throws — there is
 * no silent fallback. The caller (index.mjs `/start`) surfaces the error so B1's reconcile re-dispatches.
 *
 * NOTE (proven-live scope): the source→WHIP *RTP forwarding* fidelity (ffmpeg VP8/Opus RTP → werift outbound sender,
 * PT/SSRC re-stamped to the negotiated codec) is a werift-runtime concern proven only at ◆ go-live (§7.6: real RTMPS
 * push → LL-HLS → an SFU track id). This module proves the ORCHESTRATION (pull→collect→publish→teardown), which is
 * what unit-tests can assert without live media.
 */

/**
 * Run one source-to-whip relay. Resolves once the WHIP-out leg is established (returns a handle with `stop`);
 * rejects (fail-loud) if either leg fails to come up.
 *
 * @param {object} o
 * @param {string} o.sourceUrl - the LL-HLS manifest URL for the CF Stream live_input (source-in).
 * @param {string} o.whipUrl  - the gateway WHIP endpoint (https://gateway.wave.online/v1/whip/publish).
 * @param {string} o.whipKey  - the bridge `wk_` key (gateway derives org/keyId server-side from it).
 * @param {string} [o.sourceAuth] - optional Bearer for a signed/token-gated source (contract Q-2).
 * @param {Function} o.pull    - the source leg opener (`./hls-source.mjs` `hlsPull`; DI'd for tests).
 * @param {Function} o.publish - `@wave-av/whip-publish` publish().
 * @param {Function} o.pcFactory - builds an RTCPeerConnection (werift) for the WHIP-out leg.
 * @param {Function} [o.adaptTrack] - maps a source track to the WHIP-out publish track. Default identity — the
 *   LL-HLS source already produces writable werift relay tracks, so no per-track mapping is needed (unlike the
 *   old WHEP source, whose received tracks required a relay-track adapter).
 * @param {Function} [o.log]   - structured logger (defaults to no-op).
 * @returns {Promise<{stop: () => Promise<void>, trackCount: number}>}
 */
export async function runRelay(o) {
  const { sourceUrl, whipUrl, whipKey, sourceAuth, pull, publish, pcFactory } = o;
  const adaptTrack = o.adaptTrack ?? ((t) => t);
  const log = o.log ?? (() => {});

  if (!sourceUrl) throw new Error("runRelay: sourceUrl is required");
  if (!whipUrl) throw new Error("runRelay: whipUrl is required");
  if (!whipKey) throw new Error("runRelay: whipKey is required (bridge wk_ key)");

  const tracks = [];
  let whipSession = null;
  let sourceSession = null;
  let stopped = false;

  // Liveness of each leg, so /health can answer truthfully instead of a static ok:true.
  //
  // Both legs' state callbacks used to be LOG-ONLY. When the WHIP leg died mid-session nothing
  // reacted: the relay handle still existed, /health still said ok, and the poll — which infers
  // health purely from the CF input being live — kept believing it was bridging. Observed
  // 2026-07-19: the media path was dead ~4 minutes with nothing reporting it (#235).
  //
  // "closed"/"failed"/"disconnected" are terminal for our purposes: a WHIP publish does not
  // self-recover here, so the honest answer is dead, and the control plane restarts us.
  let whipState = "new";
  let sourceState = "new";
  const TERMINAL = new Set(["closed", "failed", "disconnected"]);

  /** Is media ACTUALLY flowing end to end? Both legs must be non-terminal and the relay not stopped. */
  const isAlive = () => !stopped && !TERMINAL.has(whipState) && !TERMINAL.has(sourceState);

  const stop = async () => {
    if (stopped) return;
    stopped = true;
    // WHIP-out first (stop the SFU publish + meter), then source-in. Both best-effort; never mask the first error.
    try {
      await whipSession?.stop();
    } catch (e) {
      log("relay-whip-stop-error", { message: String(e).slice(0, 200) });
    }
    try {
      await sourceSession?.stop();
    } catch (e) {
      log("relay-source-stop-error", { message: String(e).slice(0, 200) });
    }
    log("relay-stopped", { tracks: tracks.length });
  };

  try {
    // 1. source-in: open the pull leg, collect inbound tracks, resolve when connected.
    const connected = new Promise((resolve, reject) => {
      sourceSession = undefined; // assigned by pull() below; guard the race in onState
      const onTrack = (track) => {
        tracks.push(adaptTrack(track)); // identity — LL-HLS source produces writable relay tracks directly
        log("relay-source-track", { kind: track?.kind, total: tracks.length });
      };
      const onState = (state) => {
        sourceState = state;
        log("relay-source-state", { state });
        if (state === "connected") resolve();
        else if (state === "failed") reject(new Error("source leg failed (no live media)"));
      };
      pull({ srcUrl: sourceUrl, auth: sourceAuth, onTrack, onState, pcFactory })
        .then((s) => {
          sourceSession = s;
          // If the leg connected before the promise wiring (fast fake), the onState above already resolved.
        })
        .catch(reject);
    });
    await connected;

    if (tracks.length === 0) {
      // A connected source leg with no media is a misconfigured source — fail loud rather than publish nothing.
      throw new Error("source connected but surfaced no tracks");
    }

    // 2. WHIP-out: republish the collected tracks verbatim (relay source mode, #758 — no transcode).
    whipSession = await publish({
      endpoint: whipUrl,
      key: whipKey,
      source: { tracks },
      pcFactory,
      onState: (state) => {
        whipState = state;
        log("relay-whip-state", { state });
        // Loud on death. Previously this transition was swallowed into a debug line and the bridge
        // stayed "up" forever from the control plane's point of view.
        if (TERMINAL.has(state)) log("relay-whip-dead", { state, tracks: tracks.length });
      },
    });
    log("relay-up", { tracks: tracks.length, resource: whipSession?.resourceUrl });

    return {
      stop,
      get trackCount() {
        return tracks.length;
      },
      get alive() {
        return isAlive();
      },
      get state() {
        return { whip: whipState, source: sourceState, stopped };
      },
    };
  } catch (err) {
    // Fail-loud: tear down whatever came up, then rethrow the original cause.
    await stop().catch(() => {});
    throw err;
  }
}
