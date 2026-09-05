// GET /health must echo the DEPLOYED commit, so a live receipt can prove which build is actually
// serving traffic rather than that `wrangler deploy` returned success (proven-live-or-not-done).
//
// The handler shipped in #470 with no test at all. This file is salvaged from #472 — which was
// superseded on the implementation and closed — and extended to cover `sha`, the field #470 added
// and left uncovered. `sha` is the key CI's post-deploy verify step actually parses, so it is the
// one whose regression would be silent: the deploy would still report success, the receipt would
// still be produced, and it would simply stop proving anything.
//
// GIT_SHA is stamped at deploy time (`wrangler deploy --var GIT_SHA:<sha>` in deploy.yml) and is
// never committed; wrangler.toml [vars] carries an "unset" placeholder for every other context.
import { describe, it, expect } from "vitest";
import { dispatch, type Env } from "../src/route-dispatch";

const health = (env: Env) => dispatch(new Request("https://rt.wave.online/health"), env, undefined);

describe("GET /health", () => {
	it("echoes env.GIT_SHA as BOTH version and sha when set", async () => {
		const res = await health({ GIT_SHA: "abc1234deadbeef" } as Env);
		expect(res.status).toBe(200);
		expect(await res.json()).toMatchObject({
			ok: true,
			service: "wave-realtime-edge",
			layer: "edge",
			protocol: "webrtc-sfu",
			version: "abc1234deadbeef",
			// Asserted separately from `version` on purpose: the two are produced by different
			// expressions and CI parses `sha`. A test that only checked `version` would stay green
			// through a change that dropped `sha` entirely.
			sha: "abc1234deadbeef",
		});
	});

	it("falls back to \"dev\" for version and NULL for sha when GIT_SHA is unset", async () => {
		const res = await health({} as Env);
		expect(res.status).toBe(200);
		const body = (await res.json()) as { version: string; sha: string | null };
		expect(body.version).toBe("dev");
		// null, not "dev" and not absent: a consumer must be able to tell "this build did not stamp
		// a sha" from "this build stamped the literal string dev". Collapsing the two is how an
		// unstamped worker starts reading as a successfully verified one.
		expect(body.sha).toBeNull();
	});

	it("treats the wrangler.toml \"unset\" placeholder as a real value, not as absent", async () => {
		// wrangler.toml [vars] ships GIT_SHA = "unset" as the un-deployed placeholder. It is a
		// truthy string, so the handler passes it through rather than falling back — locking the
		// literal here means a rename of that sentinel cannot silently drift from wrangler.toml.
		const body = (await (await health({ GIT_SHA: "unset" } as Env)).json()) as {
			version: string;
			sha: string | null;
		};
		expect(body.version).toBe("unset");
		expect(body.sha).toBe("unset");
	});
});
