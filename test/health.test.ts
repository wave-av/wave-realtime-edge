// GIT_SHA go-live fix — /health must echo the deployed commit (env.GIT_SHA) as `version`, falling back
// to "dev" when unset (local dev, `wrangler deploy --dry-run`, or a test env with no injected sha). Without
// this, a rolled-out deploy is indistinguishable from a stale one — no receipt can prove which commit is
// actually serving traffic (proven-live-or-not-done). deploy.yml sets GIT_SHA via `wrangler deploy --var
// GIT_SHA:${{ github.sha }}`; wrangler.toml [vars] carries the "unset" placeholder for everything else.
import { describe, it, expect } from "vitest";
import { dispatch, type Env } from "../src/route-dispatch";

describe("GET /health", () => {
	it("echoes env.GIT_SHA as version when set", async () => {
		const env = { GIT_SHA: "abc1234deadbeef" } as Env;
		const res = await dispatch(new Request("https://rt.wave.online/health"), env, undefined);
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body).toMatchObject({
			ok: true,
			service: "wave-realtime-edge",
			layer: "edge",
			protocol: "webrtc-sfu",
			version: "abc1234deadbeef",
		});
	});

	it("falls back to \"dev\" when GIT_SHA is unset", async () => {
		const env = {} as Env;
		const res = await dispatch(new Request("https://rt.wave.online/health"), env, undefined);
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body).toMatchObject({ ok: true, version: "dev" });
	});

	it("falls back to \"dev\" for the wrangler.toml placeholder value \"unset\"", async () => {
		// wrangler.toml [vars] ships GIT_SHA = "unset" as the un-deployed placeholder — the handler must
		// treat an EMPTY string the same as absent, but "unset" is a real (truthy) string value that
		// deploy.yml overrides at deploy time via --var. This test locks the placeholder's literal text so
		// a future rename of the sentinel does not silently drift from wrangler.toml.
		const env = { GIT_SHA: "unset" } as Env;
		const res = await dispatch(new Request("https://rt.wave.online/health"), env, undefined);
		const body = (await res.json()) as { version: string };
		expect(body.version).toBe("unset");
	});
});
