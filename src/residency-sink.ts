/// <reference types="@cloudflare/workers-types" />
/**
 * E3.P2/P4 (#127) — DATA-RESIDENCY sink wiring for the realtime/SFU recorder. ALL inert unless RT_RESIDENCY.
 *
 * This module owns the env/KV/network glue between the PURE residency resolver (./residency-rt) and the
 * recording webhook pull sink (./rtk-webhook). worker.ts only DELEGATES to it: it builds the residency deps,
 * checks the flag, and captures the session zone at join — each in one line. Keeping this here keeps worker.ts
 * under the file-size gate AND keeps residency-rt.ts PURE (no env/KV/network).
 *
 * INERT BY DEFAULT: with RT_RESIDENCY off, residencyEnabled()=false → buildPullSink attaches no residency dep
 * and captureSessionZone is a no-op → the recorder is byte-identical to today (default bucket, no region key,
 * no register POST). Arming RT_RESIDENCY in any live env is a ◆ Jake-named crossing.
 */
import {
	bindingForZone,
	bucketForBinding,
	zoneFromContinent,
	type RtResidencyBinding,
	type RtResidencyZone,
} from "./residency-rt";
import { registerRecording, type RegisterConfig } from "./recordings-register";
import type { ResidencyPullDeps } from "./rtk-webhook";

/**
 * The residency-specific Env fields. Bound in wrangler.toml but only USED when RT_RESIDENCY is on (else the
 * default RT_RECORDINGS path is used). worker.ts's Env `extends ResidencySinkEnv` so these flow through with
 * no re-mapping. EncoderEnv does NOT declare GATEWAY_BASE_URL/WAVE_SERVICE_TOKEN, so they live here.
 */
export interface ResidencySinkEnv {
	// ── E3.P2/P4 (#127) DATA-RESIDENCY — ALL inert unless RT_RESIDENCY is set ([vars], default OFF) ──
	// Falsy/absent → the recorder is byte-identical to today: every recording lands in RT_RECORDINGS at the
	// non-region key, with NO gateway register() call. Truthy ("1") → an NA/EU session's bytes land in the
	// jurisdiction bucket (RT_RECORDINGS_ENAM/EU) at a region-segmented key and are registered with the gateway
	// (residency enforcement). Arming RT_RESIDENCY in any live env is a ◆ Jake-named crossing.
	RT_RESIDENCY?: string | boolean;
	// Jurisdiction R2 buckets — bound in wrangler.toml but only USED when RT_RESIDENCY is on (else the default
	// RT_RECORDINGS path is used). RT_RECORDINGS_ENAM→wave-recordings-enam, RT_RECORDINGS_EU→wave-recordings-eu.
	RT_RECORDINGS_ENAM?: R2Bucket;
	RT_RECORDINGS_EU?: R2Bucket;
	// Gateway origin for the residency register() POST (residency path only). Defaults to GATEWAY_BASE_URL.
	WAVE_GATEWAY_ORIGIN?: string;
	GATEWAY_BASE_URL?: string; // public gateway origin (also read inside RoomDO); reused as the register fallback.
	// Service bearer the register() POST presents to the gateway (SAME secret room.ts's metering tap uses).
	// Read inside RoomDO too; named here so buildPullSink can present it on the residency register call.
	WAVE_SERVICE_TOKEN?: string;
}

/** True iff the residency path is armed (RT_RESIDENCY truthy). Falsy/absent/"0"/"" → OFF (today's behavior). */
export function residencyEnabled(env: ResidencySinkEnv): boolean {
	const v = env.RT_RESIDENCY;
	return v === true || (typeof v === "string" && v !== "" && v !== "0" && v.toLowerCase() !== "false");
}

/** KV key for a session's captured residency zone (parallel to the meetingId→org map). */
export function zoneKvKey(meetingId: string): string {
	return `zone:${meetingId}`;
}

/**
 * Capture the session's residency zone at join time (RT_RESIDENCY ON). Derives the zone from
 * request.cf.continent (NA→us-east, EU→eu-west; other continents → no capture → the pull uses the default
 * path) and persists it parallel to the org map so the later webhook pull lands the bytes in-jurisdiction.
 * INERT when RT_RESIDENCY is off: residencyEnabled()=false → no zone KV write, byte-identical join.
 */
export async function captureSessionZone(
	env: ResidencySinkEnv & { RT_MEETING_ORG?: KVNamespace },
	request: Request,
	meetingId: string,
): Promise<void> {
	if (!residencyEnabled(env)) return;
	const continent = (request as Request & { cf?: { continent?: string } }).cf?.continent;
	const zone = zoneFromContinent(continent);
	if (zone) await env.RT_MEETING_ORG?.put(zoneKvKey(meetingId), zone, { expirationTtl: 60 * 60 * 24 * 14 });
}

/**
 * Build the residency deps the pull uses (RT_RESIDENCY ON). lookupZone reads the zone captured at join;
 * bucketFor resolves the jurisdiction R2 bucket + its name from env; register POSTs the finalized object to
 * the gateway register endpoint (fail-loud, never throws). All three are consistency-paired with the resolver
 * that writes the bytes, so a built register call never 403s residency_bucket_mismatch.
 */
export function buildResidencyDeps(env: ResidencySinkEnv, kv: KVNamespace): ResidencyPullDeps {
	// The wrangler binding name → its configured bucket NAME (what register() asserts as `bucket`). Mirrors the
	// gateway RESIDENCY_BUCKETS map (enam=wave-recordings-enam,eu=wave-recordings-eu); the WaveZone we SEND folds
	// to that jurisdiction gateway-side. These literals are the bucket_name values bound in wrangler.toml.
	const BUCKET_NAME: Record<RtResidencyBinding, string> = {
		RT_RECORDINGS_ENAM: "wave-recordings-enam",
		RT_RECORDINGS_EU: "wave-recordings-eu",
	};
	const registerCfg: RegisterConfig = {
		gatewayOrigin: env.WAVE_GATEWAY_ORIGIN || env.GATEWAY_BASE_URL,
		serviceToken: env.WAVE_SERVICE_TOKEN,
	};
	const log = (msg: string, fields: Record<string, unknown>) => console.log(JSON.stringify({ msg, ...fields }));
	return {
		async lookupZone(meetingId) {
			const z = await kv.get(zoneKvKey(meetingId));
			return z === "us-east" || z === "eu-west" ? (z as RtResidencyZone) : null;
		},
		bucketFor(zone) {
			const binding = bindingForZone(zone);
			const r2 = bucketForBinding(env, binding);
			if (!r2) return null; // binding unbound → caller falls to the default path (loud)
			return { bucket: r2, bucketName: BUCKET_NAME[binding], binding };
		},
		async register({ org, r2Key, bucketName, zone }) {
			await registerRecording({ org, r2Key, bucket: bucketName, zone }, registerCfg, log);
		},
	};
}
