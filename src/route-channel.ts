// route-channel.ts — item #5: the channel pub/sub route family, extracted from route-dispatch.ts (same
// leaf-module seam route-rtk.ts/route-v1-media.ts already use, by ROUTE FAMILY, to keep the entry
// dispatcher under the file-size gate).
//
// Serves the four public paths spec/realtime.yaml documents for this plane:
//   GET  /v1/connect?channel=<id>&as=<member>       — WebSocket upgrade (101); 426 if not a WS request.
//   POST /v1/channels/{channel}/publish             — fan one event out to every subscriber.
//   GET  /v1/channels/{channel}/presence             — the current member list.
//   GET  /v1/channels/{channel}/history              — recent events (≤ HISTORY_CAP).
//
// TENANT ISOLATION (non-negotiable, matches the ROOM plane exactly): the gateway stamps the authenticated
// org on the request (`x-wave-org`) and overwrites any client-supplied value before forwarding — so the
// ChannelDO id is derived `${org}:${channel}`, the SAME `${org}:${room}` derivation route-dispatch.ts
// already uses for RoomDO/AgentSessionDO. A caller can only ever address a channel inside its own org
// namespace. Every route here is gatewayGate-protected (x-wave-internal) — a public caller must never
// reach this worker directly; the public surface is served through api.wave.online.
import {
	CHANNEL_ID_PATTERN,
	CHANNEL_CONNECT_PATH,
	CHANNEL_PUBLISH_ROUTE,
	CHANNEL_PRESENCE_ROUTE,
	CHANNEL_HISTORY_ROUTE,
} from "./channel";
import { emitChannelPublishUsage } from "./channel-metering";
import { gatewayGate, SAFE_ORG, type Env } from "./dispatch-helpers";

/** Which of the four channel routes (if any) this request matches. */
function matchChannelRoute(
	request: Request,
	url: URL,
): { kind: "connect" } | { kind: "publish" | "presence" | "history"; channel: string } | null {
	if (request.method === "GET" && url.pathname === CHANNEL_CONNECT_PATH) return { kind: "connect" };
	if (request.method === "POST") {
		const m = url.pathname.match(CHANNEL_PUBLISH_ROUTE);
		if (m) return { kind: "publish", channel: decodeURIComponent(m[1]) };
	}
	if (request.method === "GET") {
		const p = url.pathname.match(CHANNEL_PRESENCE_ROUTE);
		if (p) return { kind: "presence", channel: decodeURIComponent(p[1]) };
		const h = url.pathname.match(CHANNEL_HISTORY_ROUTE);
		if (h) return { kind: "history", channel: decodeURIComponent(h[1]) };
	}
	return null;
}

export async function maybeHandleChannelRoutes(
	request: Request,
	env: Env,
	ctx: ExecutionContext | undefined,
): Promise<Response | undefined> {
	if (!env.CHANNEL) return undefined; // binding absent → INERT, falls through to the 501 catch-all
	const url = new URL(request.url);
	const match = matchChannelRoute(request, url);
	if (!match) return undefined;

	const denied = gatewayGate(request, env.WAVE_INTERNAL_SECRET);
	if (denied) return denied;

	const org = request.headers.get("x-wave-org") ?? "";
	if (!SAFE_ORG.test(org)) {
		return Response.json({ error: "BAD_REQUEST", message: "missing or malformed org context (x-wave-org)" }, { status: 400 });
	}

	const channel = match.kind === "connect" ? (url.searchParams.get("channel") ?? "") : match.channel;
	if (!CHANNEL_ID_PATTERN.test(channel)) {
		return Response.json(
			{ error: "BAD_REQUEST", message: "channel id must match ^[a-z0-9][a-z0-9:_-]{0,127}$" },
			{ status: 400 },
		);
	}

	// Tenant isolation: derive the DO id from `${org}:${channel}` — org is the gateway-stamped value above,
	// NEVER a client-supplied header, so a caller cannot cross into another org's channel namespace.
	const id = env.CHANNEL.idFromName(`${org}:${channel}`);
	const stub = env.CHANNEL.get(id);

	if (match.kind === "connect") {
		if ((request.headers.get("Upgrade") ?? "").toLowerCase() !== "websocket") {
			return Response.json({ error: "UPGRADE_REQUIRED", message: "GET /v1/connect requires a WebSocket upgrade" }, { status: 426 });
		}
		const as = url.searchParams.get("as") ?? "";
		const fwd = new URL("https://channel/connect");
		fwd.searchParams.set("channel", channel);
		if (as) fwd.searchParams.set("as", as);
		return stub.fetch(new Request(fwd.toString(), request));
	}

	if (match.kind === "publish") {
		const bodyText = await request.text();
		const fwd = new URL("https://channel/publish");
		fwd.searchParams.set("channel", channel);
		const res = await stub.fetch(
			new Request(fwd.toString(), { method: "POST", headers: { "content-type": "application/json" }, body: bodyText }),
		);
		// METERING — one channel-publish event, fire-and-forget (channel-metering.ts; INERT until an operator
		// provisions GATEWAY_BASE_URL + WAVE_SERVICE_TOKEN). Never blocks or affects the publish response.
		if (ctx && res.ok) {
			try {
				const published = (await res.clone().json()) as { id?: string };
				if (published.id) {
					ctx.waitUntil(emitChannelPublishUsage(env, org, channel, published.id).catch(() => {}));
				}
			} catch {
				/* metering must never affect the publish response */
			}
		}
		return res;
	}

	// presence / history — thin JSON forward, both take an optional `limit` for history.
	const fwd = new URL(`https://channel/${match.kind}`);
	fwd.searchParams.set("channel", channel);
	if (match.kind === "history") {
		const limit = url.searchParams.get("limit");
		if (limit) fwd.searchParams.set("limit", limit);
	}
	return stub.fetch(new Request(fwd.toString()));
}
