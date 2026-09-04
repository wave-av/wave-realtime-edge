// Regression test for the surface-sweep fix (2026-09-02): GET /llms.txt, GET
// /.well-known/agent-card.json, and GET /skill.md previously fell through to the generic 501
// REALTIME_NOT_IMPLEMENTED catch-all because route-dispatch.ts never wired the chassis's standard
// discovery surfaces. Proves the fix AND proves the 501 catch-all is otherwise unchanged (an
// unrelated unmatched GET path still 501s) — the invariant dozens of INERT feature flags in
// route-dispatch.ts rely on.
import { describe, it, expect } from "vitest";
import { dispatch } from "../src/route-dispatch";

const env = {} as import("../src/dispatch-helpers").Env;

describe("agent-discovery well-knowns", () => {
	it("GET /llms.txt is 200 text/plain naming Realtime", async () => {
		const res = await dispatch(new Request("https://rt.wave.online/llms.txt"), env, undefined);
		expect(res.status).toBe(200);
		expect(res.headers.get("content-type")).toContain("text/plain");
		const body = await res.text();
		expect(body).toContain("Realtime");
	});

	it("GET /.well-known/agent-card.json is 200 application/json naming WAVE Realtime", async () => {
		const res = await dispatch(new Request("https://rt.wave.online/.well-known/agent-card.json"), env, undefined);
		expect(res.status).toBe(200);
		expect(res.headers.get("content-type")).toContain("application/json");
		const body = (await res.json()) as { name: string };
		expect(body.name).toBe("WAVE Realtime");
	});

	it("GET /skill.md is 200 text/markdown naming Realtime", async () => {
		const res = await dispatch(new Request("https://rt.wave.online/skill.md"), env, undefined);
		expect(res.status).toBe(200);
		expect(res.headers.get("content-type")).toContain("text/markdown");
		const body = await res.text();
		expect(body).toContain("Realtime");
	});

	it("an unrelated unmatched GET path still 501s (catch-all is otherwise unchanged)", async () => {
		const res = await dispatch(new Request("https://rt.wave.online/v1/realtime/whatever-not-a-real-route"), env, undefined);
		expect(res.status).toBe(501);
		const body = (await res.json()) as { error: string };
		expect(body.error).toBe("REALTIME_NOT_IMPLEMENTED");
	});
});
