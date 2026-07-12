# ADR 2026-07-12 — Ingest architecture: direct-WHIP primary; recorder+negotiation via RoomDO

**Status:** Accepted · **Task:** #91 (Bridge ingest → WAVE SFU/recorder/negotiation) · **Supersedes** the implicit "bridge pulls CF Stream over WHEP" assumption in the CF-Stream-bridge contract.

## Context

Task #91 aimed to close "the real ingest gap": get externally-produced media into the WAVE SFU **and** through the recorder + capability-negotiation pipeline. Two ingest lanes were prototyped:

1. **Direct WHIP** — publisher → gateway `POST /v1/whip/publish` (x402/auth) → this worker's SFU listener. **Proven live end-to-end** (#109: synthetic publisher → 201 publish / 204 teardown, real RTP against the prod SFU).
2. **CF-Stream bridge** — a container pulls a CF Stream `live_input` over **WHEP** and republishes into the SFU.

Grounding sweep (2026-07-12) established the current wiring:

- WHIP ingest connects media to the SFU (`src/whip.ts` → `sfu.newSession(offer)`), but **does not** route through the recorder (`selectRecorderTarget` / `RecorderContainer`) or negotiation (`x-dst-capabilities`). Those seams live **only** in the `RoomDO` (legacy RealtimeKit) path.
- The CF-Stream-bridge control plane (`src/stream-bridge.ts` + `StreamBridgeContainer`) is complete, but the **WHEP-in leg fails**: CF Stream's `/webRTC/play` does **not** negotiate as a standard WHEP source (fast HTTP-layer 409 / whep-state "failed" in ~1s with the input LIVE). This is an HTTP-contract rejection, not an ICE timeout.
- Per-protocol direct containers (`SrtBridgeContainer`, `RtmpsBridgeContainer`, …) are defined + exported but **inert** (bindings commented in `wrangler.toml`).

## Decision

1. **Direct WHIP is the PRIMARY ingest path.** It is proven, standards-compliant, gateway-metered, and requires no third-party intermediary.
2. **Close the recorder+negotiation gap by routing the WHIP publish through a `RoomDO` room** rather than the bare `sfu.newSession` call. The RoomDO already owns the single-writer recorder tap and the `x-dst-capabilities` negotiation; reusing it keeps ONE recorder architecture and preserves the single-writer / A-DO invariant. A WHIP resource maps to a room key (org-scoped, from the mint or a caller-supplied room). Gated behind a default-off flag so the proven WHIP→SFU path stays byte-identical until armed.
3. **PARK the CF-Stream-WHEP-pull bridge.** CF Stream is not a WHEP source; do not invest in reverse-engineering its playback contract. Keep `stream-bridge` inert. If CF-Stream origination is ever required, revisit via CF "Live Outputs" pushing SRT/RTMP to a WAVE listener (accepting the repackage tension) — not WHEP-pull.
4. **SRT/RTMP direct-to-WAVE ingest is ◆-deferred.** The inert `ingest-bridge` containers are the vehicle; arm them (uncomment bindings, provision image) only when a broadcaster needs SRT/RTMP direct. Broadcasters who can speak WHIP use the primary path today.

## Consequences

- The ingest story becomes **"publish WHIP directly to WAVE"** (open-standard, one API), with SRT/RTMP as an on-demand direct lane — no CF-Stream dependency in the hot path.
- Recording + negotiation for ingested media reuse the proven RoomDO tap (validated live in #138) — no second recorder.
- Follow-ups: **#144** wire WHIP→RoomDO (inert-flagged) · **#145** live receipt (direct-WHIP publish → recorded AV1 + negotiation).

## Alternatives rejected

- **Nail CF's WHEP-playback contract** — external, undocumented, fragile; keeps a third party in the ingest hot path for no proven benefit.
- **Parallel recorder tap in the WHIP handler** — duplicates recorder logic and risks violating single-writer when the same media also traverses a room. Rejected in favour of the one-recorder RoomDO route.
