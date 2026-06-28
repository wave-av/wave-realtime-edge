// PER-LEG CAPABILITY-NEGOTIATION SELECTOR (#86 R2, design §3b/§3c) — the "any flavor on each end" brain.
// A media leg is THREE orthogonal choices negotiated per hop: encode-codec ⟂ transport ⟂ decode-codec
// (design §1a). selectLeg() composes the EXISTING primitives (selectEncoder / selectContainer from
// select.mjs) — it does NOT duplicate codec logic — and adds the transport ladder + objective scoring.
//
// HONEST-NEGATIVE BY CONSTRUCTION (design §3c): an unsatisfiable leg returns {excluded, reason} with a
// TYPED reason, NEVER a silent downgrade or a fake codec. Co-located with select.mjs so the recorder AND
// the #73 egress path share ONE policy. PURE, deterministic, host-adaptive — no GPU/network calls.

import { selectEncoder, selectContainer } from "./select.mjs";

/** Typed exclusion reasons (design §3c, mirroring the existing select.mjs / mesh-gpu vocabulary). */
export const LegExclusionReason = Object.freeze({
  CODEC_UNAVAILABLE: "CODEC_UNAVAILABLE", // no encode-runtime can encode ANY ladder codec
  DST_DECODE_UNSUPPORTED: "DST_DECODE_UNSUPPORTED", // dst decodes none of the encodable ladder codecs
  NO_COMMON_TRANSPORT: "NO_COMMON_TRANSPORT", // the ends share no transport at all
  TRANSPORT_NOT_ACTIVATED: "TRANSPORT_NOT_ACTIVATED", // shared transport(s) exist but none is activated
  REGION_PLACEMENT_VIOLATION: "REGION_PLACEMENT_VIOLATION", // live leg crosses continents
});

/** Codec fallback ladder, best (most efficient) first (design §3c). */
export const CODEC_LADDER = Object.freeze(["av1", "hevc", "h264"]);

// Map the ladder's display names to the registry codec keys (registry uses "h265" for HEVC). Exported so
// the negotiation wiring can translate a negotiated `encodeCodec` (ladder name) back to the registry key
// that buildCommand/selectEncoder expect — without re-deriving the mapping (one source of truth).
export const LADDER_TO_REGISTRY = Object.freeze({ av1: "av1", hevc: "h265", h264: "h264" });

/** Transport fallback ladder, lowest-latency first (design §3c). srt/rist are the same rung. */
export const TRANSPORT_LADDER = Object.freeze(["moq", "srt", "rist", "ll-hls"]);

/**
 * @typedef {Object} EncodeRuntime
 * @property {string} id          runtime label ("src-self-hw"|"mesh-node"|"cf-container-sw"|"browser").
 * @property {Set<string>} encoders  ffmpeg encoder names this runtime offers (drives selectEncoder).
 * @property {boolean} hardware   whether this runtime encodes in hardware (objective: lower cost+latency).
 * @property {boolean} local      whether this runtime is co-located with the source (objective).
 */

/**
 * @typedef {Object} Objective
 * @property {number} [costWeight=1]     weight on the cost term (higher = cost matters more).
 * @property {number} [latencyWeight=1]  weight on the latency term.
 * @property {boolean} [live=false]      a LIVE leg → region placement is enforced (same-continent only).
 */

/**
 * Decode the set of registry codec names a descriptor's `decode[]` supports (available:true only).
 * @param {{decode?:Array<{name:string,available:boolean}>}} descriptor
 * @returns {Set<string>}
 */
function decodeSet(descriptor) {
  const set = new Set();
  for (const c of descriptor?.decode || []) if (c && c.available) set.add(c.name);
  return set;
}

/**
 * Collect the candidate ENCODE runtimes for the source leg. The source self-HW runtime is derived from the
 * src descriptor's own encode list; additional runtimes (mesh node, cf-container SW, browser) are passed in
 * by the caller (the coordinator/gateway resolver supplies real mesh/cf caps in the follow-up wiring). Here
 * we accept them as explicit fixtures so the selector stays PURE and testable with no network.
 * @param {{encode?:Array<any>, region?:string}} srcDescriptor
 * @param {EncodeRuntime[]} extraRuntimes
 * @returns {EncodeRuntime[]}
 */
function encodeRuntimes(srcDescriptor, extraRuntimes) {
  const selfEncoders = new Set();
  let selfHardware = false;
  for (const c of srcDescriptor?.encode || []) {
    if (c && c.available && c.encoder) {
      selfEncoders.add(c.encoder);
      if (c.encoderKind === "hw") selfHardware = true;
    }
  }
  const self = { id: "src-self", encoders: selfEncoders, hardware: selfHardware, local: true };
  return [self, ...(Array.isArray(extraRuntimes) ? extraRuntimes : [])];
}

/**
 * Try to ENCODE a given ladder codec on ANY runtime, reusing selectEncoder (honest-fail per rung). Returns
 * the first runtime that can, with the chosen encoder — or null if NONE can encode it.
 * @param {string} registryCodec  registry key ("av1"|"h265"|"h264").
 * @param {EncodeRuntime[]} runtimes
 * @returns {{runtime:EncodeRuntime, encoder:string, kind:string, accel:string, container:string}|null}
 */
function encodeOnAny(registryCodec, runtimes) {
  for (const rt of runtimes) {
    try {
      const sel = selectEncoder("video", registryCodec, rt.encoders);
      return { runtime: rt, encoder: sel.encoder, kind: sel.kind, accel: sel.accel, container: sel.container };
    } catch {
      // CodecUnavailableError on this runtime → try the next runtime (honest-fail, no substitution).
    }
  }
  return null;
}

/** Lower score = better (cheaper + lower-latency). HW+local+MoQ → low; SW+cross-continent+HLS → high. */
function scoreLeg({ encode, transportIdx, crossContinent }, objective) {
  const costW = Number.isFinite(objective.costWeight) ? objective.costWeight : 1;
  const latW = Number.isFinite(objective.latencyWeight) ? objective.latencyWeight : 1;
  // Cost: hardware encode is cheaper than software; remote runtime adds cost.
  const encodeCost = (encode.kind === "hw" ? 0 : 2) + (encode.runtime.local ? 0 : 1);
  // Latency: transport rung (MoQ=0 fastest → HLS=highest) + cross-continent penalty.
  const transportLatency = transportIdx + (crossContinent ? 3 : 0);
  return costW * encodeCost + latW * transportLatency;
}

/**
 * Negotiate ONE leg src→dst. Walks the CODEC ladder (gated by dst DECODE support AND some encode runtime),
 * then the TRANSPORT ladder (both ends speak it AND it is activated), applies region placement for live
 * legs, and scores the feasible tuple. Returns the negotiated tuple OR a typed {excluded, reason}.
 *
 * @param {Object} srcDescriptor  CapabilityDescriptor of the producing end ({encode,transports,region,...}).
 * @param {Object} dstDescriptor  CapabilityDescriptor of the consuming end ({decode,transports,region,...}).
 * @param {Objective & {extraEncodeRuntimes?:EncodeRuntime[]}} [objective]
 * @returns {{encodeCodec:string, transport:string, container:string, runtime:string, score:number}
 *          | {excluded:true, reason:string, detail?:string}}
 */
export function selectLeg(srcDescriptor, dstDescriptor, objective = {}) {
  const dstDecode = decodeSet(dstDescriptor);
  const runtimes = encodeRuntimes(srcDescriptor, objective.extraEncodeRuntimes);

  // ── 1. CODEC ladder ── pick the first ladder codec that dst can DECODE and some runtime can ENCODE.
  let chosenCodec = null; // ladder display name
  let chosenEncode = null; // {runtime,encoder,kind,accel,container}
  let anyEncodable = false; // did ANY ladder codec have an encode runtime (regardless of dst decode)?
  let anyDstDecodable = false; // does dst decode ANY ladder codec (regardless of our encode)?
  for (const ladder of CODEC_LADDER) {
    const reg = LADDER_TO_REGISTRY[ladder];
    const dstCan = dstDecode.has(reg);
    const enc = encodeOnAny(reg, runtimes);
    if (enc) anyEncodable = true;
    if (dstCan) anyDstDecodable = true;
    if (dstCan && enc) {
      chosenCodec = ladder;
      chosenEncode = enc;
      break;
    }
  }
  if (!chosenCodec) {
    // Distinguish the two honest-negatives: nothing can encode (CODEC_UNAVAILABLE) vs dst can't decode
    // anything we could produce (DST_DECODE_UNSUPPORTED — the asymmetric case the design hinges on).
    if (!anyEncodable) {
      return { excluded: true, reason: LegExclusionReason.CODEC_UNAVAILABLE, detail: "no encode runtime for any ladder codec" };
    }
    return {
      excluded: true,
      reason: LegExclusionReason.DST_DECODE_UNSUPPORTED,
      detail: anyDstDecodable ? "dst decodes a ladder codec but no runtime can encode it for this dst" : "dst decodes none of [av1,hevc,h264]",
    };
  }

  // ── 2. TRANSPORT ladder ── shared protocol that BOTH ends speak AND is activated on both.
  const srcT = transportMap(srcDescriptor);
  const dstT = transportMap(dstDescriptor);
  let chosenTransport = null;
  let chosenTransportIdx = -1;
  let sharedAny = false; // both ends list it (activated or not)
  for (let i = 0; i < TRANSPORT_LADDER.length; i++) {
    const p = TRANSPORT_LADDER[i];
    const s = srcT.get(p);
    const d = dstT.get(p);
    if (s && d) sharedAny = true;
    if (s && d && s.activated && d.activated) {
      chosenTransport = p;
      chosenTransportIdx = i;
      break;
    }
  }
  if (!chosenTransport) {
    if (!sharedAny) {
      return { excluded: true, reason: LegExclusionReason.NO_COMMON_TRANSPORT, detail: "ends share no ladder transport" };
    }
    return { excluded: true, reason: LegExclusionReason.TRANSPORT_NOT_ACTIVATED, detail: "shared transport(s) present but not activated on both ends" };
  }

  // ── 3. REGION placement ── live legs must be same-continent (design §3b/§3c).
  const crossContinent = !sameContinentRegions(srcDescriptor?.region, dstDescriptor?.region);
  if (objective.live && crossContinent) {
    return { excluded: true, reason: LegExclusionReason.REGION_PLACEMENT_VIOLATION, detail: `live leg crosses continents (${srcDescriptor?.region} → ${dstDescriptor?.region})` };
  }

  // ── 4. OBJECTIVE ── score the feasible tuple (deterministic).
  const score = scoreLeg({ encode: chosenEncode, transportIdx: chosenTransportIdx, crossContinent }, objective);

  return {
    encodeCodec: chosenCodec,
    transport: chosenTransport,
    container: chosenEncode.container,
    runtime: chosenEncode.runtime.id,
    score,
  };
}

/** Build a protocol→TransportCap map from a descriptor's transports[]. */
function transportMap(descriptor) {
  const m = new Map();
  for (const t of descriptor?.transports || []) if (t && t.protocol) m.set(t.protocol, t);
  return m;
}

// Region helpers — duplicated minimally here to keep leg-select.mjs free of an import cycle and PURE.
// (transports.mjs owns the canonical continentOf/sameContinent; this mirrors it for the selector's needs.)
const CONTINENT_PREFIXES = new Set(["us", "na", "eu", "ap", "as", "sa", "af", "me", "oc"]);
function continentPrefix(region) {
  const r = String(region || "").trim().toLowerCase();
  if (!r || r === "unknown") return "unknown";
  const p = r.split("-")[0];
  return CONTINENT_PREFIXES.has(p) ? p : "unknown";
}
function sameContinentRegions(a, b) {
  const ca = continentPrefix(a);
  const cb = continentPrefix(b);
  if (ca === "unknown" || cb === "unknown") return false;
  return ca === cb;
}
