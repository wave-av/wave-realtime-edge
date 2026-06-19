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
    const res = await this.fetchImpl(`${this.baseUrl}/apps/${this.appId}${path}`, {
      method,
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${this.appSecret}` },
      body: JSON.stringify(body ?? {}),
    });
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
      offer ? { sessionDescription: offer } : {},
    );
    const sessionId = String(data.sessionId ?? "");
    if (!SESSIONID.test(sessionId)) throw new SfuError("REALTIME_UPSTREAM", "session id missing/invalid", 502);
    return { sessionId, sessionDescription: data.sessionDescription };
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
