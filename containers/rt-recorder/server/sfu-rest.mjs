// rt-recorder (#151) — PURE CF Realtime SFU REST client for the subscriber (recvonly) flow.
//
// This is the exact, PROVEN three-call subscribe handshake from harness/browser-pub-sfu-proof.mjs, extracted
// as an injectable client so it is unit-testable with a fake fetch (no live SFU, no secret). The recorder's
// werift PeerConnection drives the SDP; this client only speaks the SFU REST:
//
//   1. createSession(offerSdp)               → POST /apps/{app}/sessions/new   { sessionId, sessionDescription }
//   2. pullRemoteTrack(sessionId, pub, name) → POST /apps/{app}/sessions/{id}/tracks/new (location:"remote")
//                                              → { requiresImmediateRenegotiation, sessionDescription, ... }
//   3. renegotiate(sessionId, answerSdp)     → PUT  /apps/{app}/sessions/{id}/renegotiate  → HTTP status
//
// The Bearer app secret NEVER appears in a log — the caller passes it in; this module only puts it in the
// Authorization header. Errors carry the status + a truncated body (actionable-error-message-standard) with
// NO secret echo.

/**
 * Build an SFU REST client bound to one app's creds.
 * @param {{ fetchImpl?: typeof fetch, sfuBase?: string, appId: string, appSecret: string }} cfg
 */
export function makeSfuClient({ fetchImpl, sfuBase, appId, appSecret }) {
  if (!appId || !appSecret) throw new Error("makeSfuClient: appId + appSecret required");
  const doFetch = (fetchImpl ?? fetch).bind(globalThis);
  const base = (sfuBase ?? "https://rtc.live.cloudflare.com/v1").replace(/\/+$/, "");
  const auth = { Authorization: `Bearer ${appSecret}`, "Content-Type": "application/json" };
  const url = (path) => `${base}/apps/${appId}${path}`;

  async function post(path, body) {
    const res = await doFetch(url(path), { method: "POST", headers: auth, body: JSON.stringify(body) });
    const txt = await res.text();
    // NB: never include the request body/headers in the error — the Bearer secret must not leak to logs.
    if (!res.ok) throw new Error(`SFU POST ${path} ${res.status}: ${txt.slice(0, 300)}`);
    return JSON.parse(txt);
  }

  return {
    /** Create a subscriber session from our recvonly offer. Returns { sessionId, sessionDescription }. */
    async createSession(offerSdp) {
      return post(`/sessions/new`, { sessionDescription: { type: "offer", sdp: offerSdp } });
    },

    /**
     * Pull a remote (published) track into this session. The SFU answers with an offer requiring immediate
     * renegotiation (its media direction changes). Returns the raw SFU response.
     */
    async pullRemoteTrack(sessionId, publisherSessionId, trackName) {
      return post(`/sessions/${sessionId}/tracks/new`, {
        tracks: [{ location: "remote", sessionId: publisherSessionId, trackName }],
      });
    },

    /** Answer the SFU's renegotiation offer. Returns the HTTP status (200 on success). */
    async renegotiate(sessionId, answerSdp) {
      const res = await doFetch(url(`/sessions/${sessionId}/renegotiate`), {
        method: "PUT",
        headers: auth,
        body: JSON.stringify({ sessionDescription: { type: "answer", sdp: answerSdp } }),
      });
      return res.status;
    },
  };
}
