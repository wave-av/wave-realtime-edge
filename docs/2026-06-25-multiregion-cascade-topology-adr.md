# Multi-region cascaded SFU + per-region record + distribution (ADR) — #82 EX P1

_Date: 2026-06-25 · Design for `src/room.ts` (Room DO) + `src/encoders/recorder-target.ts`
(Recorder container) · Task #82 (EX) P1 · DESIGN / no code change · INERT_

## North Star (this node)

**Every participant in a global production connects to the WAVE SFU at their NEAREST
healthy region, the room's media fans out region-to-region over a cascade (not a single
colo), each region records its own leg, and the storage substrate deduplicates what is
byte-identical — so a London↔Sydney↔São-Paulo show has no participant paying a trans-Pacific
first hop and no recording is stored twice for nothing.** This ADR pins the cascade topology
and the per-region recorder placement; it changes no code (the hard-gate is
`architecture-doc-before-multiquarter-code`).

## Today (grounded baseline — what `src/` actually does)

- **One Room DO per `(org, room)`.** `worker.ts` routes every publish/subscribe to
  `env.ROOM.idFromName(\`${org}:${room}\`)` — a single Durable Object instance is the room.
- **No region pinning.** There is **zero** `locationHint` / jurisdiction hint in the
  codebase (grepped: none in `worker.ts`). Cloudflare places the Room DO near whoever
  touches it FIRST — so a room created by a London publisher lives in `weur`, and a Sydney
  subscriber pays a London round-trip for every media frame. This is the limitation #82 fixes.
- **One recorder per room.** `recorder-target.ts` binds a single `RECORDER` Container DO
  (`idFromName`, ◆-gated), co-located with the Room DO. One colo records; distant legs are
  recorded only as they survive the single-colo relay.
- **Realtime mixes are SKIP / unique-per-conference.** Per `wave-storage-meter` registry,
  `wave-realtime-recordings` is `dedupTier: SKIP` — "a realtime mix is unique per conference
  (~0 byte-identical recurrence)". So per-region recordings are NOT byte-identical to each
  other; the dedup substrate does not silently collapse them (see §Record).

## Decision — cascade topology (primary + regional relays)

A room is a **tree**, not a point:

```
                       ┌──────────────────────────────┐
                       │  PRIMARY Room DO (org:room)   │  authoritative roster + signaling
                       │  placed at the EVENT origin   │  (the producer's region)
                       └───────────────┬──────────────┘
            ┌──────────────────────────┼──────────────────────────┐
            ▼                          ▼                          ▼
   ┌─────────────────┐        ┌─────────────────┐        ┌─────────────────┐
   │ Relay DO  weur  │        │ Relay DO  apac  │        │ Relay DO  sam   │   one per ACTIVE region
   │ locationHint    │        │ locationHint    │        │ locationHint    │   (lazily spawned)
   └────────┬────────┘        └────────┬────────┘        └────────┬────────┘
   nearest-region participants connect here (WHIP/WHEP); relays peer to PRIMARY
```

- **Primary Room DO** = `idFromName(\`${org}:${room}\`)` (unchanged key — stable roster,
  signaling, agent session). It holds the authoritative participant list and the selective-
  forwarding decisions.
- **Regional Relay DO** = a NEW namespace keyed `idFromName(\`${org}:${room}:${region}\`)`
  created **with a `locationHint`** for that region. Spawned **lazily** — a region's relay
  exists only once a participant from that region joins (no idle fan-out tax;
  `meter-before-allocate`). A participant's region is derived from `request.cf.continent` /
  colo at the edge worker, never from client-supplied data.
- **Relay ↔ Primary peering** = DO-to-DO `fetch` (Workers RPC). The primary selectively
  forwards each published track to every relay with ≥1 subscriber for it; the relay
  re-distributes locally. This is the cascade: one inter-region hop per (track × active
  region), not per participant.

**Why a relay DO and not LiveKit's mesh:** the substrate decision (REALTIME.md §See-also) is
still custom-DO. The relay reuses the SAME Room DO code with a `parentRoom` pointer — no new
media engine, only a fan-out role flag. If the substrate later flips to LiveKit, the cascade
maps onto LiveKit's own SFU-mesh and this ADR's *placement + record + distribution* rules
still hold (they are substrate-agnostic).

## Decision — per-region recorder placement

| Option | What | Verdict |
|---|---|---|
| **A. Record only at primary** | one recorder, sees the full mix via cascade | ❌ a relay→primary network blip loses a region's local leg; defeats "every leg captured" |
| **B. Record at every relay (chosen)** | each Relay DO co-locates its own `RECORDER` container; records the LOCAL region's received tracks | ✅ region-local capture survives inter-region loss; nearest-colo write latency |
| **C. Record per participant** | one recorder per publisher | ❌ N× the container cost; no mix |

**Chosen: B — per-region recorder.** Each active region records its locally-received mix to
`wave-realtime-recordings` under a **region-scoped key** (`…/${region}/…`). Because realtime
mixes are unique-per-conference (SKIP tier), the storage substrate does **not** collapse
distinct regions' recordings — and it must not: they are genuinely different vantage points,
each a retained canonical object. Where two regions DO produce a byte-identical artifact
(e.g. an identical re-uploaded asset, not a live mix), the existing content-hash dedup
(`(org|pool, bucket, hash)`, #46) collapses it for free. **The dedup story here is: collapse
the byte-identical, never the merely-similar — region legs stay distinct.** A later
post-production "stitch to one master" is an EDIT operation (a new logical asset), not a
storage-layer dedup, and is explicitly out of scope for P1.

## Decision — distribution (subscriber routing)

WHEP subscribers are routed to the **nearest healthy region's relay**
(`route-each-request-to-nearest-healthy-node`):

1. Edge worker reads `request.cf.colo`/continent → maps to the nearest region with a live relay.
2. If that region has no relay yet → spawn one (lazy) OR fall back to the next-nearest healthy
   relay (a `scored-transport-fallback-ladder`, mirroring the codec ladder in #86 P2).
3. Health = the relay DO answering a liveness ping within budget; an unhealthy relay is
   skipped down the ladder, never served.

## Invariants this pins (for P2/P3 to implement, not violate)

- **Stable identity:** the primary key stays `(org, room)`; relays are a strict suffix
  `(org, room, region)`. No existing route changes meaning.
- **Lazy + metered:** no relay/recorder exists for a region with zero participants
  (`meter-before-allocate`); each spawn is a future ◆-gated cost the meter sees first.
- **Data residency:** `locationHint` is also the hook for `data-residency-pinned-at-
  infrastructure-layer` — a room can be CONSTRAINED to a jurisdiction set by refusing relays
  outside it (a forward policy, not P1 mechanism).
- **Never collapse distinct legs:** per-region recordings are retained-distinct; only
  byte-identical content dedups.

## ◆ Gated crossing (NOT crossed here)

This ADR writes no code and spawns no DO. The live crossings, owned by **#82 P2/P3**:

- **P2 — per-region recorder:** add the relay DO role + `locationHint` + region-scoped
  recorder; prove a 2-region session records in BOTH regions (the done-check). The recorder
  spawn inherits the existing RT-P2.4 ◆ (container attach) per region.
- **P3 — distribution:** nearest-healthy WHEP routing + the fallback ladder; prove a
  subscriber is served by its nearest region.

Each is a per-region, metered, Jake-named crossing — never a blanket global flip. Kill-
criterion (`meter-before-allocate`): do not arm multi-region for a room class until a real
cross-region event demands it; single-region rooms stay single-DO and pay nothing extra.

## Forward / out of scope for P1

- Cross-region **agent session** placement (the `AGENT_SESSION` DO) — follows the primary for
  now; revisit if voice-agent latency to distant participants matters.
- LiveKit-substrate variant of the cascade (kept mappable, not designed here).
- Post-production multi-leg stitch-to-master (an edit pipeline, not storage).
