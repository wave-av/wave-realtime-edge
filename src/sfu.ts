// P5.1 — Cloudflare Realtime (Calls) SFU client.
//
// A THIN, typed wrapper over the Cloudflare Realtime SFU REST API — the media-plane primitive
// (RTP forwarding, simulcast, TURN, global edge). This is the raw push/pull *tracks* API used to
// own rooms in WAVE's control plane, and is DISTINCT from RealtimeKit (`realtimekit.ts`, the managed
// meeting product). The two coexist; this file adds the SFU substrate per the P5 design (§3.1).
//
// CF Realtime SFU contract (CF docs, 2026-06-19):
//   POST /apps/{appId}/sessions/new                      → { sessionId }
//   POST /apps/{appId}/sessions/{id}/tracks/new          → push (local) / pull (remote) tracks
//   PUT  /apps/{appId}/sessions/{id}/tracks/close        → close tracks
//   POST /apps/{appId}/sessions/{id}/datachannels/new    → open data channels
// Auth is the App SECRET as a Bearer token. The App ID + App Secret + base URL come from config/env
// (DO NOT hardcode). The provisioned CF Realtime app supplies these via env: CF_CALLS_APP_ID and
// CF_CALLS_APP_SECRET (Doppler wave/prd; app "wispy-feather-fa96" on the WAVE account). Wire the
// worker as `new SfuClient({ appId: env.CF_CALLS_APP_ID, appSecret: env.CF_CALLS_APP_SECRET })` —
// the default baseUrl resolves to https://rtc.live.cloudflare.com/v1/apps/{CF_CALLS_APP_ID}.
//
// NO room logic lives here (that is the Room DO). NO live network in tests — the HTTP client is
// injectable (`FetchLike`) so every path is mocked. Fixed host literal (SSRF-safe); ids are
// validated before interpolation.

const DEFAULT_BASE_URL = "https://rtc.live.cloudflare.com/v1"; // fixed default — no request-derived URLs (SSRF-safe)
const APPID = /^[0-9a-f]{32,}$/i; // CF app ids are long hex; guard before interpolating
const SESSIONID = /^[0-9a-zA-Z_-]{8,128}$/; // CF session ids are opaque url-safe tokens

/** Config for the CF Realtime SFU client. Sourced from env (Doppler later) — never hardcoded. */
export interface SfuConfig {
  appId: string;
  appSecret: string;
  /** Base URL for the CF Realtime API. Defaults to the public CF host; overridable for tests/staging. */
  baseUrl?: string;
}

/** A WebRTC SDP offer/answer payload (passed through to/from the SFU verbatim). */
export interface SessionDescription {
  type: "offer" | "answer";
  sdp: string;
}

/** One track to push (local) — references a transceiver mid + an RTP track name. */
export interface LocalTrack {
  location: "local";
  mid: string;
  trackName: string;
}

/** One track to pull (remote) — references another session's published track by name. */
export interface RemoteTrack {
  location: "remote";
  sessionId: string;
  trackName: string;
}

export type TrackRequest = LocalTrack | RemoteTrack;

/** A track object as echoed back by the SFU (mid + name + per-track status). */
export interface TrackResponse {
  mid?: string;
  trackName: string;
  sessionId?: string;
  error?: { errorCode?: string; errorDescription?: string };
}

export interface NewSessionResult {
  sessionId: string;
  /** The SFU's SDP answer, present when the session was created from a client offer. */
  sessionDescription?: SessionDescription;
}

export interface TracksResult {
  tracks: TrackResponse[];
  /** SFU's renegotiation answer when pushing/pulling required an SDP exchange. */
  sessionDescription?: SessionDescription;
  requiresImmediateRenegotiation?: boolean;
}

export interface DataChannelRequest {
  location: "local" | "remote";
  dataChannelName: string;
  /** For a remote (subscribe) channel: the publishing session id. */
  sessionId?: string;
}

export interface DataChannelResult {
  dataChannels: { id?: number; dataChannelName: string }[];
}

/**
 * Typed boundary error → mapped to a normalized {error,message} envelope + HTTP status by the worker.
 * Mirrors RtkError from realtimekit.ts for one consistent error contract across the spoke.
 */
export class SfuError extends Error {
  constructor(public code: string, message: string, public status = 502) {
    super(message);
    this.name = "SfuError";
  }
}

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/**
 * The CF Realtime SFU client. Construct once per request with config from env; pass an injected
 * `fetchImpl` in tests so no live network is touched. Every method throws SfuError at its boundary.
 */
export class SfuClient {
  private readonly appId: string;
  private readonly appSecret: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: FetchLike;

  constructor(cfg: SfuConfig, fetchImpl: FetchLike = fetch) {
    if (!APPID.test(cfg.appId || "") || !cfg.appSecret) {
      // FAIL-CLOSED on an unconfigured app (matches realtimekit's 503 NOT_CONFIGURED contract).
      throw new SfuError("REALTIME_NOT_CONFIGURED", "CF Realtime SFU is not configured (app id/secret)", 503);
    }
    this.appId = cfg.appId;
    this.appSecret = cfg.appSecret;
    // Normalize: strip a trailing slash so path joins are clean. Only the configured/default host is used.
    this.baseUrl = (cfg.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.fetchImpl = fetchImpl;
  }

  /** POST helper → JSON object, or SfuError on any non-2xx / non-JSON / unparseable boundary. */
  private async call<T>(method: "POST" | "PUT", path: string, body: unknown): Promise<T> {
    // Detach from `this` before invoking: calling `this.fetchImpl(...)` would set the callee's `this` to
    // this SfuClient instance, and the global `fetch` builtin throws "Illegal invocation" unless called
    // with its own (global) receiver. A local binding makes `this` undefined (module strict mode), which
    // both the real fetch and any injected mock accept. Regression: test/sfu.test.ts asserts this.
    const doFetch = this.fetchImpl;
    // Send a request body ONLY when there is one. CF Realtime rejects an empty JSON object on its
    // body-optional endpoints: POST /sessions/new WITHOUT an offer returns 400 "decoding_error: Body
    // JSON validation error: sessionDescription" for `{}`, but 201 for no body at all. So pass the body
    // (and the JSON Content-Type) only when `body != null`; a no-offer newSession sends neither.
    // CF Realtime's edge firewall BLOCKS a request that carries NO `User-Agent`: a Workers `fetch()` sends
    // none, so rtc.live.cloudflare.com replied 403 "error code: 1010" / 400 — surfaced to the publisher as a
    // 503 and the exact reason a real WHIP publish never reached the SFU (#100B). Verified live against the
    // wave-realtime-sfu app: an absent UA is blocked, but ANY non-empty UA → 201 + SDP answer. Send an
    // explicit UA so every SfuClient call actually reaches the CF Realtime API.
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.appSecret}`,
      "User-Agent": "wave-realtime-edge/1.0",
    };
    const init: RequestInit = { method, headers };
    if (body != null) {
      headers["Content-Type"] = "application/json";
      init.body = JSON.stringify(body);
    }
    const res = await doFetch(`${this.baseUrl}/apps/${this.appId}${path}`, init);
    let json: unknown = null;
    try {
      json = await res.json();
    } catch {
      json = null; // non-JSON upstream
    }
    if (!res.ok || json == null || typeof json !== "object") {
      // Observability only — never the app secret or the raw upstream body.
      console.warn(`sfu-upstream path=${path} status=${res.status} ok=${res.ok}`);
      throw new SfuError("REALTIME_UPSTREAM", `CF Realtime ${path} returned ${res.status}`, 502);
    }
    return json as T;
  }

  /** Create a new SFU session. Returns the opaque session id used by all subsequent calls. */
  async newSession(offer?: SessionDescription): Promise<NewSessionResult> {
    const data = await this.call<{ sessionId?: string; sessionDescription?: SessionDescription }>(
      "POST",
      "/sessions/new",
      offer ? { sessionDescription: offer } : undefined, // no offer → no body (CF rejects `{}` here)
    );
    const sessionId = String(data.sessionId ?? "");
    if (!SESSIONID.test(sessionId)) throw new SfuError("REALTIME_UPSTREAM", "session id missing/invalid", 502);
    return { sessionId, sessionDescription: data.sessionDescription };
  }

  /**
   * #35 — liveness probe for one SFU session: `GET /sessions/{id}`. Used by the WHIP orphan sweeper to
   * decide whether a publish session whose client never sent a teardown DELETE is actually over.
   *
   * FOUR-STATE by design (this is a BILLING decision, so ambiguity must never close a live session):
   *   "gone"    — the SFU 404s the session, or every track is inactive. Unambiguously over.
   *   "alive"   — the session answers and still has a non-inactive track.
   *   "idle"    — the session answers but reports ZERO tracks.
   *   "unknown" — any transport/parse/non-5xx-classifiable failure. The sweeper treats this as ALIVE.
   *
   * "idle" exists because of a LIVE-OBSERVED CF behaviour (#35, 2026-07-18): when a publisher dies without
   * a teardown, CF Realtime does NOT 404 the session — it keeps answering 200 with `tracks: []`, observed
   * still doing so 35 minutes later. Collapsing that into "alive" (the original assumption that CF would
   * eventually GC) meant an orphaned session was refreshed forever and NEVER billed, defeating the sweeper
   * entirely. It is reported separately rather than as "gone" because a session probed moments after
   * publish can legitimately have no tracks yet — only the caller knows the session's age, so only the
   * caller can safely age it out.
   *
   * Deliberately does NOT reuse `call()`: that helper throws one uniform SfuError on every non-2xx, which
   * cannot distinguish "404 → the session is legitimately over" from "502 → we simply could not tell".
   */
  async sessionLiveness(sessionId: string): Promise<"alive" | "gone" | "idle" | "unknown"> {
    if (!SESSIONID.test(sessionId)) return "unknown"; // never bill/close on a malformed id
    const doFetch = this.fetchImpl; // detach from `this` (see call() — global fetch rejects a bound receiver)
    let res: Response;
    try {
      res = await doFetch(`${this.baseUrl}/apps/${this.appId}/sessions/${sessionId}`, {
        method: "GET",
        headers: { Authorization: `Bearer ${this.appSecret}`, "User-Agent": "wave-realtime-edge/1.0" },
      });
    } catch {
      return "unknown"; // transport failure — cannot tell, so the sweeper must assume the session is live
    }
    if (res.status === 404) return "gone"; // the SFU no longer knows this session → the publish is over
    if (!res.ok) return "unknown";
    let json: unknown = null;
    try {
      json = await res.json();
    } catch {
      return "unknown"; // non-JSON upstream — cannot tell
    }
    const tracks = (json as { tracks?: { status?: string }[] } | null)?.tracks;
    // All tracks inactive ⇒ unambiguously finished.
    if (Array.isArray(tracks) && tracks.length > 0 && tracks.every((t) => t?.status === "inactive")) return "gone";
    // Answered with no tracks. This is WEAKER evidence than it looks, and callers must not read it as death:
    // a WHIP publish is created with `newSession(offer)` and never calls `pushTracks` (whip.ts), so the SFU
    // registers NO tracks against the session and answers `{"tracks":[]}` for the whole life of a healthy
    // publish. Verified live 2026-07-19 against a session that was actively bridging media (#233).
    // So "idle" means only "this API cannot tell" for such sessions — it does NOT distinguish mid-negotiation,
    // a dead publisher, and a perfectly healthy WHIP broadcast. whip-sweep.ts refuses to bill on it alone.
    if (!Array.isArray(tracks) || tracks.length === 0) return "idle";
    return "alive";
  }

  /** Push local tracks into a session (publish). `offer` carries the renegotiation SDP when required. */
  async pushTracks(sessionId: string, tracks: LocalTrack[], offer?: SessionDescription): Promise<TracksResult> {
    return this.tracksNew(sessionId, tracks, offer);
  }

  /** Pull remote tracks into a session (subscribe to another session's published tracks). */
  async pullTracks(sessionId: string, tracks: RemoteTrack[]): Promise<TracksResult> {
    return this.tracksNew(sessionId, tracks);
  }

  /** Shared `/tracks/new` body assembly + response normalization for push and pull. */
  private async tracksNew(sessionId: string, tracks: TrackRequest[], offer?: SessionDescription): Promise<TracksResult> {
    this.assertSession(sessionId);
    if (!Array.isArray(tracks) || tracks.length === 0) {
      throw new SfuError("BAD_REQUEST", "at least one track is required", 400);
    }
    const data = await this.call<{
      tracks?: TrackResponse[];
      sessionDescription?: SessionDescription;
      requiresImmediateRenegotiation?: boolean;
      errorCode?: string;
      errorDescription?: string;
    }>("POST", `/sessions/${sessionId}/tracks/new`, offer ? { sessionDescription: offer, tracks } : { tracks });

    if (data.errorCode) {
      throw new SfuError("REALTIME_UPSTREAM", `CF Realtime tracks/new error ${data.errorCode}`, 502);
    }
    return {
      tracks: Array.isArray(data.tracks) ? data.tracks : [],
      sessionDescription: data.sessionDescription,
      requiresImmediateRenegotiation: data.requiresImmediateRenegotiation,
    };
  }

  /** Close (stop) tracks on a session. `mids` are the local transceiver mids to close. */
  async closeTracks(sessionId: string, mids: string[], offer?: SessionDescription): Promise<TracksResult> {
    this.assertSession(sessionId);
    if (!Array.isArray(mids) || mids.length === 0) {
      throw new SfuError("BAD_REQUEST", "at least one mid is required to close", 400);
    }
    const data = await this.call<{ tracks?: TrackResponse[]; sessionDescription?: SessionDescription }>(
      "PUT",
      `/sessions/${sessionId}/tracks/close`,
      { tracks: mids.map((mid) => ({ mid })), force: false, ...(offer ? { sessionDescription: offer } : {}) },
    );
    return { tracks: Array.isArray(data.tracks) ? data.tracks : [], sessionDescription: data.sessionDescription };
  }

  /**
   * Renegotiate a session: forward a client-side SDP (typically the `answer` to the SFU's offer after a
   * pull required immediate renegotiation, or a fresh client `offer`) so the PeerConnection re-syncs.
   * CF Realtime contract: `PUT /sessions/{id}/renegotiate` with the sessionDescription. Returns the
   * SFU's resulting sessionDescription when one is produced.
   */
  async renegotiate(sessionId: string, sdp: SessionDescription): Promise<TracksResult> {
    this.assertSession(sessionId);
    if (!sdp || (sdp.type !== "offer" && sdp.type !== "answer") || !sdp.sdp) {
      throw new SfuError("BAD_REQUEST", "a valid sessionDescription is required to renegotiate", 400);
    }
    const data = await this.call<{ sessionDescription?: SessionDescription }>(
      "PUT",
      `/sessions/${sessionId}/renegotiate`,
      { sessionDescription: sdp },
    );
    return { tracks: [], sessionDescription: data.sessionDescription };
  }

  /** Open a data channel (local = create, remote = subscribe to a peer's channel). */
  async newDataChannel(sessionId: string, channels: DataChannelRequest[]): Promise<DataChannelResult> {
    this.assertSession(sessionId);
    if (!Array.isArray(channels) || channels.length === 0) {
      throw new SfuError("BAD_REQUEST", "at least one data channel is required", 400);
    }
    const data = await this.call<{ dataChannels?: { id?: number; dataChannelName: string }[] }>(
      "POST",
      `/sessions/${sessionId}/datachannels/new`,
      { dataChannels: channels },
    );
    return { dataChannels: Array.isArray(data.dataChannels) ? data.dataChannels : [] };
  }

  /** Guard a session id before path interpolation (SSRF / injection safety). */
  private assertSession(sessionId: string): void {
    if (!SESSIONID.test(sessionId || "")) {
      throw new SfuError("BAD_REQUEST", "invalid session id", 400);
    }
  }
}
