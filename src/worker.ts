// wave-realtime-edge — edge WebRTC SFU. Scaffold stage; protocol routes return 501
// until substrate decision (custom SFU on DOs vs. LiveKit consume) lands.
export default {
	async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);
		if (url.pathname === "/health") {
			return Response.json({
				ok: true,
				service: "wave-realtime-edge",
				layer: "edge",
				protocol: "webrtc-sfu",
				version: "dev",
			});
		}
		return Response.json(
			{ error: "REALTIME_NOT_IMPLEMENTED", path: url.pathname },
			{ status: 501 },
		);
	},
};
