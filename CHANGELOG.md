# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- ci(deploy): deploy pipeline (`.github/workflows/deploy.yml`, workflow_dispatch) — install · typecheck · test · `wrangler deploy` (#30).
- wrangler: `ROOM` Durable Object binding + `v1` migration (`new_sqlite_classes: ["RoomDO"]`), `[observability]`, `workers_dev = false`, `GATEWAY_BASE_URL` var, and documented secrets (`CF_CALLS_APP_ID/SECRET`, `WAVE_SERVICE_TOKEN`).
- `RoomDO` re-exported from `src/worker.ts` so the DO binding/migration resolve on first deploy.
- `deploy:dry` npm script (`wrangler deploy --dry-run`).
