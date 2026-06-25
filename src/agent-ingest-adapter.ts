/// <reference types="@cloudflare/workers-types" />
/**
 * Task #81 (LK-rip Phase 6b) — Voice-agent INGEST adapter primitives.
 *
 * The egress half (subscribe: SFU → us, decoded PCM in) is the PROVEN container-adapter.ts path
 * (`createWebsocketAdapter` location:"remote" + `decodePacket`). This module is the INGEST half
 * (publish: us → SFU, PCM out): create a `location:"local"` WS media-transport adapter so the SFU
 * publishes a NEW WebRTC track sourced from PCM frames we send over the adapter WebSocket.
 *
 * ── WHAT IS VERIFIED vs WHAT THE LIVE SPIKE MUST CONFIRM ────────────────────────────────────────
 * VERIFIED (cf-ws-adapter-contract.md, vs cloudflare/realtime-examples): the create-adapter REST shape,
 * the proto3 `Packet { sequenceNumber=1; timestamp=2; payload=5 }` wire format (one Packet per WS binary
 * frame, no length prefix), and that audio is 16-bit LE PCM / 48 kHz / stereo, ≤32 KB per message.
 *
 * UNVERIFIED — flagged in VOICE-MEDIA-PATH-SPIKE.md §Gaps(1) — and the reason this module exists behind a
 * SEAM: the repo has only EXERCISED egress (location:"remote"). For ingest (location:"local") the exact
 * SEND-side framing is NOT yet proven against the live adapter: does the SFU expect us to (a) re-wrap each
 * PCM chunk in the SAME Packet proto, or (b) send raw PCM binary? We model (a) — Packet-wrapped, symmetric
 * with the verified egress decoder — as the DEFAULT, because it is the symmetric reading of a bidirectional
 * adapter, but the live spike MUST confirm it and may flip `framing` to "raw". Both are implemented here so
 * the flip is a one-line config change, not a rewrite. THIS IS THE ONE ADAPTER-CONTRACT ASSUMPTION the
 * live spike has to verify (item (a) of the spike's "Live spike to confirm before step 2").
 *
 * No `@wave-av/content-hash`, no I/O beyond the injectable fetch. Pure + unit-testable.
 */
import {
  SfuAdapterError,
  DEFAULT_SFU_API_BASE,
} from "./encoders/container-adapter.js";

// CF app ids are long hex; SFU session ids are opaque url-safe tokens. Guard before interpolating (SSRF-safe).
const APPID = /^[0-9a-f]{32,}$/i;
const SESSIONID = /^[0-9a-zA-Z_-]{8,128}$/;
/** Max bytes of PCM payload per WS message (contract: audio ≤32 KB per adapter message). */
export const MAX_PCM_MESSAGE_BYTES = 32 * 1024;

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/** One track to PUBLISH back into the session: `location:"local"` — the SFU creates a new WebRTC track from it. */
export interface IngestAdapterTrack {
  location: "local";
  sessionId: string;
  trackName: string;
  /** wss:// the SFU connects to receive OUR PCM (symmetric with the egress `endpoint`). */
  endpoint: string;
  inputCodec: "pcm";
}

export interface CreateIngestAdapterParams {
  appId: string;
  /** CF Calls SFU app bearer (NOT the RTK account token) — from CF_CALLS_APP_* via env. */
  bearer: string;
  tracks: IngestAdapterTrack[];
  sfuApiBase?: string;
}

export interface CreateIngestAdapterResult {
  adapterId?: string;
  raw: unknown;
}

/**
 * Create a CF Realtime websocket media-transport adapter in INGEST mode (`location:"local"`). Mirrors
 * `createWebsocketAdapter` (egress) but with local tracks + inputCodec. POST {base}/apps/{appId}/adapters/
 * websocket/new with `{tracks}` and a Bearer; the SFU then connects our endpoint and publishes the PCM we
 * send as a new track. Throws SfuAdapterError at the boundary; never logs the bearer or the raw body.
 *
 * ⚠️ LIVE-SPIKE: the create payload key for an ingest track (`inputCodec` vs `outputCodec`, `location:"local"`
 * acceptance) follows the documented adapter API but has not been exercised in-repo — confirm in the spike.
 */
export async function createIngestAdapter(
  deps: { fetchImpl?: FetchLike },
  params: CreateIngestAdapterParams,
): Promise<CreateIngestAdapterResult> {
  if (!APPID.test(params.appId || "")) throw new SfuAdapterError("BAD_APP_ID", "invalid SFU app id", 400);
  if (!params.bearer) throw new SfuAdapterError("NOT_CONFIGURED", "SFU bearer token missing", 503);
  if (!Array.isArray(params.tracks) || params.tracks.length === 0) {
    throw new SfuAdapterError("BAD_REQUEST", "at least one track is required", 400);
  }
  for (const t of params.tracks) {
    if (!/^wss:\/\//.test(t.endpoint || "")) {
      throw new SfuAdapterError("BAD_ENDPOINT", "adapter endpoint must be a wss:// URL", 400);
    }
    if (!SESSIONID.test(t.sessionId || "")) {
      throw new SfuAdapterError("BAD_SESSION", "invalid sfu session id", 400);
    }
  }
  const base = (params.sfuApiBase ?? DEFAULT_SFU_API_BASE).replace(/\/+$/, "");
  const doFetch = deps.fetchImpl ?? fetch;
  const res = await doFetch(`${base}/apps/${params.appId}/adapters/websocket/new`, {
    method: "POST",
    headers: { Authorization: `Bearer ${params.bearer}`, "Content-Type": "application/json" },
    body: JSON.stringify({ tracks: params.tracks }),
  });
  let json: unknown = null;
  try {
    json = await res.json();
  } catch {
    json = null;
  }
  if (!res.ok) {
    console.warn(`sfu-ingest-adapter status=${res.status} ok=${res.ok}`); // observability only — never the token
    throw new SfuAdapterError("UPSTREAM", `create ingest adapter returned ${res.status}`, 502);
  }
  const obj = json && typeof json === "object" ? (json as Record<string, unknown>) : {};
  const id = obj.adapterId ?? obj.id;
  return { adapterId: id != null ? String(id) : undefined, raw: json };
}

// ── Send-side framing ────────────────────────────────────────────────────────────────────────────────────

/** How we frame outbound PCM on the ingest WS. SEE module header — "packet" is the modeled default; the live
 *  spike may flip to "raw". Kept a discriminated value so the choice is one config, never a code rewrite. */
export type IngestFraming = "packet" | "raw";

/** Append a base-128 varint to `out`. Multiplication (not <<) so values >2^31 don't corrupt via 32-bit math. */
function writeVarint(out: number[], value: number): void {
  let v = value;
  if (v < 0 || !Number.isFinite(v)) throw new SfuAdapterError("BAD_PACKET", "varint must be a non-negative finite int", 400);
  while (v >= 0x80) {
    out.push((v & 0x7f) | 0x80);
    v = Math.floor(v / 128);
  }
  out.push(v & 0x7f);
}

/**
 * Encode ONE outbound PCM chunk into the wire bytes for an ingest WS binary frame.
 *
 *  - framing "packet" (DEFAULT, modeled symmetric to the verified egress decoder): a proto3
 *    `Packet { sequenceNumber=1; timestamp=2; payload=5 }` — exactly what `decodePacket` reads. Field 1 (tag
 *    0x08) seq, field 2 (tag 0x10) ts, field 5 (tag 0x2A, len-delimited) the PCM payload.
 *  - framing "raw": the PCM bytes verbatim (the alternative the spike may prove correct).
 *
 * Throws if the payload exceeds the contract's ≤32 KB per-message ceiling (callers must chunk first).
 */
export function encodeIngestFrame(
  payload: Uint8Array,
  meta: { sequenceNumber: number; timestamp: number },
  framing: IngestFraming = "packet",
): Uint8Array {
  if (payload.length > MAX_PCM_MESSAGE_BYTES) {
    throw new SfuAdapterError("FRAME_TOO_LARGE", `PCM frame ${payload.length} > ${MAX_PCM_MESSAGE_BYTES} byte ceiling`, 400);
  }
  if (framing === "raw") return payload.slice();
  const head: number[] = [];
  writeVarint(head, 0x08); // field 1, wire 0 (varint)
  writeVarint(head, meta.sequenceNumber);
  writeVarint(head, 0x10); // field 2, wire 0 (varint)
  writeVarint(head, meta.timestamp);
  writeVarint(head, 0x2a); // field 5, wire 2 (length-delimited)
  writeVarint(head, payload.length);
  const out = new Uint8Array(head.length + payload.length);
  out.set(head, 0);
  out.set(payload, head.length);
  return out;
}

/** Split a large PCM buffer into ≤MAX_PCM_MESSAGE_BYTES chunks (just-in-time sending keeps barge-in tight). */
export function chunkPcm(pcm: Uint8Array, maxBytes = MAX_PCM_MESSAGE_BYTES): Uint8Array[] {
  if (pcm.length === 0) return [];
  const chunks: Uint8Array[] = [];
  for (let off = 0; off < pcm.length; off += maxBytes) {
    chunks.push(pcm.subarray(off, Math.min(off + maxBytes, pcm.length)));
  }
  return chunks;
}
