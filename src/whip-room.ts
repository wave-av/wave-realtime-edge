// #144 (#91-B) — WHIP → RoomDO recorder+negotiation wiring (pure helpers + the DO forward).
//
// The proven direct-WHIP path (whip.ts handlePublish) does a bare `sfu.newSession(offer)`: media lands on the
// CF Realtime SFU but NEVER traverses the recorder tap (RoomRecording / RecorderContainer) or the capability
// negotiation (x-dst-capabilities) — those seams live ONLY in the RoomDO (per the #91 ADR,
// docs/2026-07-12-ingest-architecture-adr.md). This module closes that gap by routing a WHIP publish THROUGH a
// RoomDO room (the `whip-publish` intent → Signaling.whipPublish), so the room owns the single-writer recorder
// + negotiation — the "one-recorder RoomDO route" the ADR chose over a parallel tap in the WHIP handler.
//
// INERT by default: everything here is reached ONLY when `WHIP_ROOM_RECORDING` is truthy AND a ROOM binding is
// present. Off → whip.ts keeps the byte-identical direct SFU path. And even when ON, publishViaRoom fails SOFT:
// any error falls back to the direct path (media-safety > recording, design §4) — flagging recording on can
// never break the proven publish.
import type { SessionDescription } from "./sfu.js";

/** A WHIP media section derived from the offer/answer SDP: the transceiver mid + its kind. */
export interface WhipSdpTrack {
  mid: string;
  kind: "audio" | "video";
}

/** The env fields the WHIP→room wiring reads: the flag + the RoomDO binding. Both optional → inert. */
export interface WhipRoomEnv {
  WHIP_ROOM_RECORDING?: string | boolean; // [vars] flag — falsy/absent → direct SFU path (recorder-less), unchanged
  ROOM?: { idFromName(name: string): unknown; get(id: unknown): { fetch(req: Request): Promise<Response> } };
}

/** Header a WHIP publisher (via the gateway) may set to target a NAMED room (else a per-resource room is used). */
export const WHIP_ROOM_HEADER = "x-wave-room";
/** Room-name / mid safety: url-safe segment (also the SFU trackName + registry-key alphabet). */
const SAFE_SEGMENT = /^[0-9a-zA-Z_-]{1,128}$/;

/** True only when an operator has flipped `WHIP_ROOM_RECORDING` on. Default (absent/"0"/false) → direct path. */
export function whipRoomRecordingEnabled(env: WhipRoomEnv): boolean {
  const v = env.WHIP_ROOM_RECORDING;
  return v === true || v === "1" || v === "true";
}

/**
 * Derive the room a WHIP publish attaches to. A caller-supplied `x-wave-room` (validated) lets a publisher
 * join an EXISTING room (e.g. contribute an ingest feed into a live session); absent/invalid → a per-resource
 * room `whip:{resourceId}` so each publish is isolated + addressable. Org-scoping is applied by the DO id
 * (`{org}:{room}`) at the call site — this returns only the room segment.
 */
export function deriveWhipRoom(resourceId: string, callerRoom?: string | null): string {
  if (callerRoom && SAFE_SEGMENT.test(callerRoom)) return callerRoom;
  return `whip:${resourceId}`;
}

/** A deterministic, url-safe SFU trackName for a WHIP-published mid (server-derived — WHIP carries no names). */
export function buildWhipTrackName(sessionId: string, mid: string): string {
  const safeMid = mid.replace(/[^0-9a-zA-Z_-]/g, "").slice(0, 32) || "0";
  return `whip-${sessionId}-${safeMid}`;
}

/**
 * Parse the media sections of an SDP into (mid, kind) pairs — the tracks a WHIP publisher is sending. Pure and
 * defensive: iterates `m=audio`/`m=video` sections (data-channel `m=application` is ignored — not recordable),
 * capturing the first `a=mid:` line in each. A section with no explicit mid falls back to its ordinal index
 * (WebRTC offers always carry a=mid, but a missing one must not drop the track from the recorder).
 */
export function parseSdpTracks(sdp: string): WhipSdpTrack[] {
  const out: WhipSdpTrack[] = [];
  if (!sdp) return out;
  let cur: { kind: "audio" | "video"; mid: string | null } | null = null;
  let index = -1;
  const flush = () => {
    if (cur) out.push({ kind: cur.kind, mid: cur.mid ?? String(index) });
  };
  for (const raw of sdp.split(/\r\n|\r|\n/)) {
    if (raw.startsWith("m=")) {
      flush();
      index += 1;
      const kind = raw.slice(2).split(/\s/)[0]; // "audio" | "video" | "application" | …
      cur = kind === "audio" || kind === "video" ? { kind, mid: null } : null;
    } else if (cur && cur.mid == null && raw.startsWith("a=mid:")) {
      cur.mid = raw.slice("a=mid:".length).trim();
    }
  }
  flush();
  return out;
}

/** Result of a successful room-routed WHIP publish: the SFU session + the answer SDP + the room it attached to. */
export interface WhipRoomPublishResult {
  sessionId: string;
  answerSdp: string;
  room: string;
}

/**
 * Route a WHIP publish through the RoomDO `whip-publish` intent (DO id = `{org}:{room}`), so the room creates
 * the SFU session AND arms its recorder + negotiation. Returns the session + answer on success, or `null` on
 * ANY failure — the caller then falls back to the proven direct SFU path (media-safety > recording). This is
 * signaling-only glue: media still terminates at the CF Realtime SFU; the DO never holds media.
 */
export async function publishViaRoom(
  env: WhipRoomEnv,
  org: string,
  offer: SessionDescription,
  resourceId: string,
  callerRoom: string | null,
  participantId: string,
): Promise<WhipRoomPublishResult | null> {
  if (!env.ROOM) return null;
  const room = deriveWhipRoom(resourceId, callerRoom);
  try {
    const stub = env.ROOM.get(env.ROOM.idFromName(`${org}:${room}`));
    const res = await stub.fetch(
      new Request("https://room/whip-publish", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ offer, ctx: { org, room, participantId, role: "speaker" } }),
      }),
    );
    if (!res.ok) return null;
    const json = (await res.json()) as { sessionId?: string; sessionDescription?: SessionDescription };
    const sessionId = json.sessionId ?? "";
    const answerSdp = json.sessionDescription?.type === "answer" ? json.sessionDescription.sdp : "";
    if (!sessionId || !answerSdp) return null;
    return { sessionId, answerSdp, room };
  } catch {
    return null; // fail-soft → direct path
  }
}
