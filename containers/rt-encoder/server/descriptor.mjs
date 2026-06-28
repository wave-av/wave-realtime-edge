// rt-encoder CAPABILITY DESCRIPTOR (#86 R1, design §3a) — the full self-described node capability surface
// that the per-leg selector (leg-select.mjs) and the coordinator/gateway resolver (C1/G1, follow-up) key
// off. It COMPOSES the existing primitives — it does not reinvent codec logic:
//   - encode[]  : selectEncoder over the registry vs the host encoder set (THE EXISTING encode half).
//   - decode[]  : decode.mjs probe (`ffmpeg -decoders`) — NEW (the asymmetric half).
//   - transports: transports.mjs static list with env-driven activation — NEW.
//   - region    : transports.mjs regionOf() (env-driven; no continentOf helper exists in this repo) — NEW.
//   - hwaccels  : capability.mjs parseHwaccels — EXISTING.
//   - maxResFps : optional best-effort throughput ceiling per codec (static stub) — NEW, absence-tolerant.
//
// SELF-DESCRIBED, NEVER CLIENT-ASSERTED (design §3a): every field is derived from THIS host's probes/env.
// The `/capabilities` endpoint stays byte-stable on its existing `{hwaccels, codecs}` keys; the descriptor
// fields are ADDITIVE (see toCapabilitiesResponse / additive wiring in index.mjs).

import { CODECS } from "./codecs.mjs";
import { selectEncoder } from "./select.mjs";
import { emptyCapability } from "./capability.mjs";
import { emptyDecodeCapability } from "./decode.mjs";
import { buildTransports, regionOf } from "./transports.mjs";

/**
 * @typedef {Object} CodecImpl
 * @property {string} name                 registry codec name (e.g. "av1","h264","opus").
 * @property {"video"|"audio"} media       media kind.
 * @property {boolean} available           whether this host has an impl for it.
 * @property {string} [encoder]            chosen ffmpeg encoder name (encode list only; absent on decode).
 * @property {"hw"|"sw"} [encoderKind]     hardware|software (encode list only).
 * @property {string} [accel]              accel family ("none" for sw; encode list only).
 */

/**
 * @typedef {Object} CapabilityDescriptor
 * @property {string} region                          continent-prefixable region (design §3a).
 * @property {CodecImpl[]} encode                     codecs this host can ENCODE (existing half).
 * @property {CodecImpl[]} decode                     codecs this host can DECODE (new half).
 * @property {import("./transports.mjs").TransportCap[]} transports  pipes spoken {protocol,activated,blockers}.
 * @property {Record<string,{w:number,h:number,fps:number}>} maxResFps  best-effort per-codec throughput ceiling.
 * @property {string[]} hwaccels                      hardware-accel methods (existing).
 */

/**
 * Build the ENCODE half: for each registry codec, ask selectEncoder over the host encoder set. Available
 * → carry the chosen impl; honest-fail (CodecUnavailableError) → available:false. This is EXACTLY the
 * shape the live `/capabilities` endpoint already returns per-codec — reused here so encode stays stable.
 * @param {Set<string>} encoders host encoder name set.
 * @returns {CodecImpl[]}
 */
export function buildEncodeList(encoders) {
  const out = [];
  for (const [name, entry] of Object.entries(CODECS)) {
    try {
      const sel = selectEncoder(entry.media, name, encoders);
      out.push({ name, media: entry.media, available: true, encoder: sel.encoder, encoderKind: sel.kind, accel: sel.accel });
    } catch {
      out.push({ name, media: entry.media, available: false });
    }
  }
  return out;
}

/**
 * Build the DECODE half from the probed decodable-codec set. A registry codec is decode-available iff the
 * `ffmpeg -decoders` probe reported a decoder mapping to it (decode.mjs decodableCodecs). No encoder/accel
 * fields — decode impls are not selected the way encoders are (the recorder is encode-only; decode caps
 * matter at the DESTINATION node, e.g. Ampere AV1 NVDEC).
 * @param {Set<string>} decodeCodecs registry codec names decodable on this host.
 * @returns {CodecImpl[]}
 */
export function buildDecodeList(decodeCodecs) {
  const set = decodeCodecs instanceof Set ? decodeCodecs : new Set(decodeCodecs || []);
  const out = [];
  for (const [name, entry] of Object.entries(CODECS)) {
    out.push({ name, media: entry.media, available: set.has(name) });
  }
  return out;
}

/**
 * Assemble the full CapabilityDescriptor from probed host state + env. PURE given its inputs (caller does
 * the impure probes via capability.mjs/decode.mjs and passes the sets in).
 *
 * @param {Object} p
 * @param {import("./capability.mjs").Capability} [p.capability]  encode probe ({encoders,hwaccels}).
 * @param {{decodeCodecs:Set<string>}} [p.decode]                 decode probe (decodableCodecs set).
 * @param {Record<string,string|undefined>} [p.env=process.env]
 * @param {Record<string,{w:number,h:number,fps:number}>} [p.maxResFps]  optional throughput ceilings.
 * @returns {CapabilityDescriptor}
 */
export function buildCapabilityDescriptor({ capability = emptyCapability(), decode = emptyDecodeCapability(), env = process.env, maxResFps } = {}) {
  return {
    region: regionOf(env),
    encode: buildEncodeList(capability.encoders),
    decode: buildDecodeList(decode.decodeCodecs),
    transports: buildTransports(env),
    maxResFps: maxResFps && typeof maxResFps === "object" ? { ...maxResFps } : {},
    hwaccels: [...(capability.hwaccels || [])],
  };
}

/**
 * Render the descriptor into the `/capabilities` HTTP response shape, PRESERVING the existing byte-stable
 * keys (`hwaccels`, `codecs:{name:{media,available,encoder,encoderKind,accel}}`) and ADDING the new
 * descriptor fields (`region`, `decode`, `transports`, `maxResFps`). The existing `codecs` map is rebuilt
 * verbatim from the encode list so a client reading only `{hwaccels,codecs}` sees NO change.
 * @param {CapabilityDescriptor} d
 * @returns {Object} the additive /capabilities JSON payload.
 */
export function toCapabilitiesResponse(d) {
  const codecs = {};
  for (const c of d.encode) {
    codecs[c.name] = c.available
      ? { media: c.media, available: true, encoder: c.encoder, encoderKind: c.encoderKind, accel: c.accel }
      : { media: c.media, available: false };
  }
  return {
    // EXISTING (byte-stable) keys first — unchanged shape.
    hwaccels: d.hwaccels,
    codecs,
    // ADDITIVE descriptor fields (#86) — a client reading {hwaccels,codecs} ignores these.
    region: d.region,
    decode: d.decode,
    transports: d.transports,
    maxResFps: d.maxResFps,
  };
}
