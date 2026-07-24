// wave-realtime-edge — edge entry for CF Realtime.
//   GET  /health     → 200 liveness (public)
//   POST /rtk/join   → CF-3.1.2: RealtimeKit join (create meeting + mint participant token)
//   POST /rtk/turn   → CF-3: mint short-lived TURN/ICE credentials (raw WebRTC / WHIP-WHEP NAT traversal)
//   <other>          → 501 (raw-SFU WHIP/WHEP surfaces are a follow-up; D2 = CF Realtime SFU)
//
// PROTECTING PAID ENDPOINTS (the whole point): /rtk/join mints RealtimeKit participant tokens and /rtk/turn
// mints TURN credentials — both cost money when used. Access is EITHER (a) via the WAVE gateway —
// api.wave.online, which authenticates + CHARGES the caller over x402/MPP and then forwards with a trusted
// internal header, OR (b) nothing. When WAVE_INTERNAL_SECRET is set (every deployed env), a direct/unpaid
// call that lacks the matching `x-wave-internal` header gets 401. Unset (local/test) → no enforcement, which
// preserves the gateway-delegated contract + the existing contract tests.
//
// Route logic + helpers live in src/route-dispatch.ts (split from this file, task #56, to stay under 800 lines).
// This entry module keeps ALL DO/container re-exports for wrangler binding resolution — those MUST live here.
import { dispatch, scheduledHandler, type Env } from "./route-dispatch";

// Re-export the Room Durable Object so the wrangler `ROOM` binding + migration (v1, new_sqlite_classes)
// resolve from this main module. The class is defined in room.ts (P5 substrate) and its fetch() control
// plane runs the P5.2 Signaling orchestration (join/publish/subscribe/renegotiate/leave); the worker
// routes POST /v1/realtime/rooms/:room/:intent to it below. Exporting it here lets the binding deploy.
// E3.P2/P4 (#127) — data-residency sink wiring (used only when RT_RESIDENCY is on). worker.ts only DELEGATES;
// the env/KV/network glue + residency Env fields live in src/residency-sink.ts. residency-rt.ts stays PURE.
export { RoomDO } from "./room";

// RT-R10 (#72) — the PORTABLE raw-SFU encode container Durable Object class (Path A; mirrors bridge-edge's
// MoqContainer). INERT: the `[[containers]] RECORDER` block in wrangler.toml stays COMMENTED (Path A attach is
// a Jake-named ◆); exported here so the class is in scope when the ◆ uncomments the binding.
export { RecorderContainer } from "./encoders/recorder-container";
// #314 slice g-prep — per-participant MoQ publish container DO class (moq-forward-target.ts reaches it via
// `getContainer(env.MOQ_PUBLISH, ...)`). INERT: the `[[containers]] MOQ_PUBLISH` block in wrangler.toml stays
// COMMENTED (arming is a Jake-named ◆); exported here so the class is in scope when the ◆ uncomments the binding.
export { MoqPublishContainer } from "./encoders/moq-publish-container";
export { StreamBridgeContainer } from "./stream-bridge-container"; // #91 B2 — inert (binding COMMENTED until ◆)
// F (#55) — per-protocol Plane-2 direct-ingest republisher container classes. INERT: each [[containers]] +
// [[durable_objects.bindings]] block stays COMMENTED in wrangler.toml until that leg's ◆ go-live. Exporting the
// classes costs nothing at rest — a class only becomes a live container when its binding + image are provisioned.
export {
	SrtBridgeContainer,
	RistBridgeContainer,
	RtmpsBridgeContainer,
	MoqBridgeContainer,
} from "./ingest-bridge-container";

// Task #81 — the per-room voice-agent session Durable Object. Exported from the main module so the
// AGENT_SESSION binding + migration resolve on deploy. INERT unless VOICE_AGENT_PROVIDER==="wave".
export { AgentSessionDO } from "./agent-session";

// #88 M2 — the per-meeting Zoom RTMS → WAVE media bridge Durable Object. Exported so the ZOOM_RTMS_BRIDGE
// binding + migration resolve on deploy. INERT unless WAVE_ZOOM_RTMS is armed AND a meeting→room map exists.
export { ZoomRtmsBridgeDO } from "./zoom-rtms-bridge-do";

export default {
	async fetch(request: Request, env: Env = {} as Env, ctx?: ExecutionContext): Promise<Response> {
		return dispatch(request, env, ctx);
	},

	async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
		return scheduledHandler(event, env, ctx);
	},
};
