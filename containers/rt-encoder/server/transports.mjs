// rt-encoder TRANSPORT capability + REGION (#86 R1, design §3a). A CapabilityDescriptor self-describes
// which codec-agnostic PIPES this node speaks and whether each is ACTIVATED. The transport axis is
// orthogonal to codec: a MoQ track, an SRT caller leg, a WHEP subscriber each carry any codec opaquely
// (design §1a). This module is PURE DATA + tiny pure helpers — env-driven activation, no I/O — so the
// descriptor builder and the per-leg selector can reason about transports deterministically in CI.
//
// HONEST-NEGATIVE: a transport the node does NOT yet implement is listed with `activated:false` and a
// typed `blockers[]` reason — never silently omitted (which would read as "unknown") and never faked as
// live. This is the descriptor-level source of the selector's TRANSPORT_NOT_ACTIVATED exclusion.

/** @typedef {"moq"|"srt"|"rist"|"whip"|"whep"|"ll-hls"|"ws-adapter"} TransportProtocol */

/**
 * @typedef {Object} TransportCap
 * @property {TransportProtocol} protocol   the wire protocol name.
 * @property {boolean}           activated  whether this node actually speaks it live right now.
 * @property {string[]}          blockers   typed reasons it is NOT activated (empty when activated).
 */

// The protocols this edge node can in principle carry, with their DEFAULT activation. Today only the
// recorder WS-adapter lane is live in this repo; the rest are scaffolded (per-route 501 / roadmap) so they
// default to NOT activated with the real blocker reason. Activation is overridable via env (see below).
const TRANSPORT_DEFAULTS = Object.freeze([
  { protocol: "ws-adapter", activated: true, blockers: [] }, // CF Realtime WS-adapter (proven recorder lane, design S2)
  { protocol: "moq", activated: false, blockers: ["relay_binding_not_wired"] }, // moq.wave.online relay lives in wave-moq-edge
  { protocol: "srt", activated: false, blockers: ["ingress_protocol_requires_vm_listener"] }, // no CF UDP ingress
  { protocol: "rist", activated: false, blockers: ["ingress_protocol_requires_vm_listener"] },
  { protocol: "whip", activated: false, blockers: ["whip_ingress_not_wired_in_this_node"] }, // WHIP lives in the SFU worker
  { protocol: "whep", activated: false, blockers: ["whep_egress_not_wired_in_this_node"] },
  { protocol: "ll-hls", activated: false, blockers: ["llhls_producer_not_built"] }, // roadmap (design §1b E5)
]);

/**
 * Build this host's transport descriptor. Each protocol can be force-ACTIVATED via an env flag
 * `RT_TRANSPORT_<PROTOCOL>=1` (e.g. `RT_TRANSPORT_MOQ=1`, `RT_TRANSPORT_SRT=1`); the protocol name is
 * upper-cased and `-` → `_`. When forced active, blockers are cleared. This is config-driven (never
 * client-asserted) and defaults to the honest scaffolded state above.
 *
 * @param {Record<string,string|undefined>} [env=process.env]
 * @returns {TransportCap[]}
 */
export function buildTransports(env = process.env) {
  return TRANSPORT_DEFAULTS.map((t) => {
    const key = `RT_TRANSPORT_${t.protocol.toUpperCase().replace(/-/g, "_")}`;
    const forced = String(env[key] || "") === "1";
    if (forced) return { protocol: t.protocol, activated: true, blockers: [] };
    return { protocol: t.protocol, activated: t.activated, blockers: [...t.blockers] };
  });
}

/** The set of protocol names this node lists at all (activated or not). */
export const KNOWN_TRANSPORTS = Object.freeze(TRANSPORT_DEFAULTS.map((t) => t.protocol));

// ── Region ──────────────────────────────────────────────────────────────────────────────────────────
// No `continentOf` helper exists in this repo (grep = 0), so per design §3a we use a simple env-driven
// region string and derive a CONTINENT PREFIX from it for same-continent placement checks. The region is
// expected to be a Cloudflare-style code like "us-east", "eu-west", "ap-south"; the continent prefix is
// the segment before the first "-" (us/eu/ap/sa/af/me/oc), normalized.

/** Known continent prefixes (for normalization / validation). */
const CONTINENT_PREFIXES = Object.freeze(["us", "na", "eu", "ap", "as", "sa", "af", "me", "oc"]);

/**
 * Read this node's region from env (`RT_REGION`, default "unknown"). Lower-cased, trimmed. The descriptor
 * carries it verbatim; placement checks use continentOf() below.
 * @param {Record<string,string|undefined>} [env=process.env]
 * @returns {string}
 */
export function regionOf(env = process.env) {
  return String(env.RT_REGION || "unknown").trim().toLowerCase();
}

/**
 * Derive the CONTINENT prefix from a region string ("us-east" → "us", "eu-west-1" → "eu"). Returns
 * "unknown" when the region is empty/unknown or its prefix is not a recognized continent — so a missing
 * region NEVER spuriously matches another (two "unknown"s are treated as non-co-located by the selector).
 * @param {string} region
 * @returns {string} continent prefix or "unknown".
 */
export function continentOf(region) {
  const r = String(region || "").trim().toLowerCase();
  if (!r || r === "unknown") return "unknown";
  const prefix = r.split("-")[0];
  return CONTINENT_PREFIXES.includes(prefix) ? prefix : "unknown";
}

/**
 * @returns {boolean} whether two regions are SAME-CONTINENT. Two unknowns are NOT same-continent (we can't
 * prove co-location, so a live leg between unknowns is excluded — honest-negative, never a silent pass).
 */
export function sameContinent(regionA, regionB) {
  const a = continentOf(regionA);
  const b = continentOf(regionB);
  if (a === "unknown" || b === "unknown") return false;
  return a === b;
}
