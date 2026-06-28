# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- feat(rt-encoder): per-leg capability-negotiation layer (#86, inert/verify-only). Full `CapabilityDescriptor` (`server/descriptor.mjs`) — adds a `ffmpeg -decoders` probe (`server/decode.mjs` `parseDecoders`/`decodableCodecs`), a static env-driven `transports` list + region helper (`server/transports.mjs`), and `maxResFps` — composed into the additive `/capabilities` response (existing `{hwaccels, codecs}` encode output byte-stable). The pure per-leg selector `selectLeg` (`server/leg-select.mjs`) negotiates encode-codec ⟂ transport ⟂ decode-codec with honest-negative typed exclusions (`CODEC_UNAVAILABLE`/`DST_DECODE_UNSUPPORTED`/`NO_COMMON_TRANSPORT`/`TRANSPORT_NOT_ACTIVATED`/`REGION_PLACEMENT_VIOLATION`). No live behavior change; wires into the coordinator/gateway resolver in a follow-up (C1/G1).
- ci(deploy): deploy pipeline (`.github/workflows/deploy.yml`, workflow_dispatch) — install · typecheck · test · `wrangler deploy` (#30).
- wrangler: `ROOM` Durable Object binding + `v1` migration (`new_sqlite_classes: ["RoomDO"]`), `[observability]`, `workers_dev = false`, `GATEWAY_BASE_URL` var, and documented secrets (`CF_CALLS_APP_ID/SECRET`, `WAVE_SERVICE_TOKEN`).
- `RoomDO` re-exported from `src/worker.ts` so the DO binding/migration resolve on first deploy.
- `deploy:dry` npm script (`wrangler deploy --dry-run`).
