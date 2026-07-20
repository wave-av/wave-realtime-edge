// B3 (#98) — WHIP KV record/resource cluster, split out of whip.ts (non-behavioral refactor).
//
// FROZEN CONTRACT: ~/.claude/plans/wave-any-to-any-matrix/whip-v1-frozen-contract.md (v1.1), §3/§4/§6-B3/§9.

/** WHIP resource ids are opaque url-safe tokens we mint; guard before path interpolation / KV keys. */
export const RESOURCE_ID = /^[0-9a-zA-Z_-]{8,128}$/;
/** KV key prefix for the resourceId → session record (reuses the RT_MEETING_ORG namespace). */
export const WHIP_KV_PREFIX = "whip:";
/** Resource records outlive a publish session comfortably; TTL bounds the teardown window. */
export const WHIP_KV_TTL_SECONDS = 60 * 60 * 24; // 24h

/** The minimal KV surface this module needs (read/write/delete/list the resource record). Matches CF KV. */
export interface WhipKv {
	get(key: string): Promise<string | null>;
	put(key: string, value: string, opts?: { expirationTtl?: number }): Promise<void>;
	delete(key: string): Promise<void>;
	// #35: paginated enumeration for the orphan sweeper (same shape the other cron reconciles use).
	list(opts: {
		prefix?: string;
		cursor?: string;
	}): Promise<{ keys: { name: string }[]; list_complete: boolean; cursor?: string }>;
}

/** A persisted WHIP resource record (resourceId → SFU session), used by PATCH/DELETE/sweep. */
export interface WhipResource {
	sessionId: string;
	org: string;
	startedAt: number; // epoch ms — start of the publish session, for the teardown meter
	// #145 (#91-C): the RoomDO room this publish routed through (WHIP_ROOM_RECORDING path). Persisted so DELETE
	// can address the SAME DO (`{org}:{room}`) to finalize the recorder. Absent ⇒ direct path (no recorder tap).
	room?: string;
	// #91 B2: the resolved billing meter, captured (gateway-sealed, allowset-validated) at publish so the
	// teardown bills the right SKU regardless of how it fires (client DELETE or cron). Absent ⇒ default WHIP.
	meter?: string;
	// #35: last epoch-ms at which the sweeper OBSERVED this session alive at the SFU. The orphan sweep bills
	// `startedAt → lastSeenAt` (never → sweep-time), so a session whose publisher died without a DELETE is
	// billed only for time it was demonstrably live. Absent ⇒ never probed; falls back to startedAt.
	lastSeenAt?: number;
	// #240/#257: epoch-ms at which the sweeper first saw a DEATH signal for this session — a 410 Gone
	// (disconnected), a 404/all-inactive ("gone"), or an aged once-alive "idle". No single probe is proven
	// terminal (a 410 can be a transient ICE drop, tracks can flap inactive→active, a 404 can be a mis-routed
	// probe), so the sweeper stamps this on the first death of any kind and only bills+drops once it PERSISTS
	// past WHIP_GONE_CONFIRM_MS. Cleared ONLY by an "alive" answer (200 + active tracks); an idle 200 no longer
	// clears it (#240 Phase-2), so a recovered blip is rescued while an ambiguous flap can never reset the clock.
	disconnectedSince?: number;
}

/** Parse a `whip:`-prefixed KV record back into a typed WhipResource, or null on absent/corrupt. Shared by
 *  handlePatch/handleDelete here and by the orphan sweeper (src/whip-sweep.ts). */
export async function loadResource(kv: WhipKv | undefined, resourceId: string): Promise<WhipResource | null> {
	if (!kv) return null;
	const raw = await kv.get(`${WHIP_KV_PREFIX}${resourceId}`);
	if (!raw) return null;
	try {
		const r = JSON.parse(raw) as Partial<WhipResource>;
		if (typeof r.sessionId === "string" && typeof r.org === "string" && typeof r.startedAt === "number") {
			return {
				sessionId: r.sessionId,
				org: r.org,
				startedAt: r.startedAt,
				meter: typeof r.meter === "string" ? r.meter : undefined,
				// #145: carry the room forward so DELETE can address the recorder-holding DO to finalize.
				room: typeof r.room === "string" ? r.room : undefined,
				// #35: carry the sweeper's last observed-alive stamp so an orphan teardown bills to it.
				lastSeenAt: typeof r.lastSeenAt === "number" ? r.lastSeenAt : undefined,
				// #240: carry the sweeper's first-410 stamp forward. Without this the confirm-window stamp is
				// write-only — every sweep re-loads the record with disconnectedSince stripped, re-stamps a fresh
				// clock, and the window NEVER closes, so a crashed orphan is never billed (proven live 2026-07-20).
				disconnectedSince: typeof r.disconnectedSince === "number" ? r.disconnectedSince : undefined,
			};
		}
	} catch {
		/* corrupt record → treat as absent */
	}
	return null;
}
