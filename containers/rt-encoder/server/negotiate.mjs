// rt-encoder NEGOTIATION WIRING (#86 R3) — the thin, PURE glue that turns an /encode request's optional DST
// capability descriptor into a negotiated target codec, by calling the per-leg selector (leg-select.mjs).
//
// INERT BY DEFAULT (config-no-silent-noop): this is invoked ONLY when NEGOTIATION_ENABLED === "true". When
// the flag is OFF — or when it is ON but the request carries NO dst descriptor — the caller keeps today's
// byte-identical behavior (the explicit x-target-codec / default path). Negotiation NEVER silently changes
// the proven path; it only replaces the chosen target codec when the operator has both opted in AND the
// request supplied a real DST capability surface to negotiate against.
//
// HONEST-FAIL (proven-live-or-not-done / no-error-masking): if selectLeg returns a typed exclusion, this
// surfaces a structured negotiation failure ({ negotiated:false, reason, detail }) — the caller maps it to
// an explicit 422, NEVER a downgrade or a substituted codec. PURE: no I/O, deterministic given its inputs.

import { selectLeg, LADDER_TO_REGISTRY } from "./leg-select.mjs";

/** Truthy iff the operator has explicitly turned negotiation on. Default-off: absent/anything-else → off. */
export function negotiationEnabled(env = process.env) {
  return String(env.NEGOTIATION_ENABLED || "").toLowerCase() === "true";
}

/**
 * Parse a DST CapabilityDescriptor carried on the request as a base64-encoded JSON header. Returns the
 * parsed object, or null when the header is absent (→ caller falls through to legacy behavior). THROWS a
 * NegotiationInputError on a present-but-malformed header (honest-fail: a corrupt descriptor must not be
 * silently treated as "no descriptor" and skip negotiation the operator asked for).
 * @param {string|undefined} headerValue  value of x-dst-capabilities (base64 of the descriptor JSON).
 * @returns {object|null}
 */
export function parseDstDescriptor(headerValue) {
  const raw = typeof headerValue === "string" ? headerValue.trim() : "";
  if (!raw) return null;
  let json;
  try {
    json = Buffer.from(raw, "base64").toString("utf8");
  } catch {
    throw new NegotiationInputError("x-dst-capabilities is not valid base64");
  }
  let obj;
  try {
    obj = JSON.parse(json);
  } catch {
    throw new NegotiationInputError("x-dst-capabilities did not decode to JSON");
  }
  if (!obj || typeof obj !== "object") {
    throw new NegotiationInputError("x-dst-capabilities did not decode to a descriptor object");
  }
  return obj;
}

/** A present-but-malformed dst descriptor header (caller → 400). Distinct from a negotiation EXCLUSION. */
export class NegotiationInputError extends Error {
  constructor(message) {
    super(message);
    this.name = "NegotiationInputError";
  }
}

/**
 * Negotiate the target codec for THIS encode leg. The rt-encoder host IS the source; `srcDescriptor` is its
 * own self-described CapabilityDescriptor (built from the host probe), `dstDescriptor` is the consuming
 * end's descriptor supplied on the request. Runs selectLeg and translates the ladder-named result to the
 * registry codec key buildCommand expects.
 *
 * @param {object} srcDescriptor  this host's CapabilityDescriptor.
 * @param {object} dstDescriptor  the consumer's CapabilityDescriptor (from x-dst-capabilities).
 * @param {import("./leg-select.mjs").Objective} [objective]
 * @returns {{ negotiated:true, targetCodec:string, transport:string, container:string, runtime:string, score:number }
 *          | { negotiated:false, reason:string, detail?:string }}
 */
export function negotiateTargetCodec(srcDescriptor, dstDescriptor, objective = {}) {
  const leg = selectLeg(srcDescriptor, dstDescriptor, objective);
  if (leg.excluded) {
    // Typed honest-negative — caller surfaces this as an explicit 422, never a downgrade.
    return { negotiated: false, reason: leg.reason, detail: leg.detail };
  }
  const targetCodec = LADDER_TO_REGISTRY[leg.encodeCodec] || leg.encodeCodec;
  return {
    negotiated: true,
    targetCodec,
    transport: leg.transport,
    container: leg.container,
    runtime: leg.runtime,
    score: leg.score,
  };
}
