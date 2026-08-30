// rtk-egress-route — the LK-rip #77 recording-egress control plane (/rtk/egress/start|stop|info),
// extracted from route-rtk.ts (token-budget decompose, 2026-08-30; DECOMPOSE, never trim). The seam
// is by ROUTE FAMILY: the gateway-fronted WAVE-native egress surface is its own responsibility, with
// its own DORMANT-until-armed posture; the /rtk/* admin routes stay in route-rtk. Blocks moved
// verbatim, comments included; maybeHandleRtkEgress returns undefined where the inline block fell
// through.
import { liveEgressDeps, gatewayGate, EGRESS_ROUTE, EGRESS_INTENTS, SAFE_ORG, type Env } from "./dispatch-helpers";
import { pullRecordingConfigured } from "./encoders/managed";
import { RtkError } from "./realtimekit";

/** Every /rtk/egress/* intent. Returns the Response when matched, undefined otherwise. */
export async function maybeHandleRtkEgress(
	request: Request,
	env: Env,
): Promise<Response | undefined> {
	const url = new URL(request.url);

	// ── LK-rip #77 egress control plane — POST /rtk/egress/start|stop|info ──
	// The gateway-fronted WAVE-native recording-egress surface. WRAPS the proven PULL-mode recorder
	// (rtk-webhook pulls the finished file into our R2) — it does NOT build a raw-SFU tap (that stays
	// NOT_SPIKED/dormant). Behind the SAME internal-secret chokepoint as the other /rtk/* routes. DORMANT by
	// default: when pull mode is not configured (the live default — RT_RECORD!=="1" or creds/bindings absent)
	// every intent 501s (fail loud until the recorder is armed; never a faked file/silent ok).
	{
		const egMatch = request.method === "POST" ? url.pathname.match(EGRESS_ROUTE) : null;
		if (egMatch && EGRESS_INTENTS.has(egMatch[1])) {
			const deniedEg = gatewayGate(request, env.WAVE_INTERNAL_SECRET);
			if (deniedEg) return deniedEg;
			const intent = egMatch[1];
			if (!pullRecordingConfigured(env)) {
				return Response.json({ error: "REALTIME_NOT_IMPLEMENTED", path: url.pathname }, { status: 501 });
			}
			let body: Record<string, unknown> = {};
			try {
				body = (await request.json()) as Record<string, unknown>;
			} catch {
				body = {};
			}
			const deps = env.__egressDeps ?? liveEgressDeps();

			if (intent === "start") {
				const org = request.headers.get("x-wave-org") ?? "";
				if (!SAFE_ORG.test(org)) {
					return Response.json(
						{ error: "BAD_REQUEST", message: "missing or malformed org context (x-wave-org)" },
						{ status: 400 },
					);
				}
				const room = typeof body.room === "string" ? body.room : "";
				try {
					// egressId == the RTK meetingId == the recording sessionId, so the webhook pull lands ONE
					// canonical object at the LIVE recordingKey() scheme
					// `${org}/realtime-recordings/${meetingId}/recording.<ext>` (tier SKIP, lifecycle-applied).
					const { meetingId } = await deps.join(env, room);
					// Persist meetingId→org FIRST so the recording.statusUpdate webhook attributes the pull to this org.
					await env.RT_MEETING_ORG?.put(meetingId, org, { expirationTtl: 60 * 60 * 24 * 14 });
					const { recordingId } = await deps.startRecording(env, meetingId);
					console.log(JSON.stringify({ msg: "rt-egress-started", egressId: meetingId, recordingId, org, room }));
					return Response.json(
						{ egressId: meetingId, sessionId: meetingId, recordingId, room, status: "starting" },
						{ status: 200 },
					);
				} catch (e) {
					const err = e instanceof RtkError ? e : new RtkError("REALTIME_ERROR", "egress start failed", 500);
					return Response.json({ error: err.code, message: err.message }, { status: err.status });
				}
			}

			// stop / info: egressId is the RTK meetingId. The RTK recording auto-stops at meeting end and the
			// webhook pulls the finished file into R2, so STOP is a best-effort ack (we never tear down a live
			// meeting from here) and INFO reports the correlation; full status detail is webhook-driven.
			const egressId = typeof body.egressId === "string" ? body.egressId : "";
			if (!egressId) {
				return Response.json({ error: "BAD_REQUEST", message: "egressId is required" }, { status: 400 });
			}
			const org = (await env.RT_MEETING_ORG?.get(egressId)) ?? null;
			if (intent === "stop") {
				console.log(JSON.stringify({ msg: "rt-egress-stop", egressId, org }));
				return Response.json({ egressId, sessionId: egressId, status: "stopping" }, { status: 200 });
			}
			return Response.json(
				{ egressId, sessionId: egressId, org, status: org ? "active" : "unknown" },
				{ status: 200 },
			);
		}
	}

	return undefined;
}
