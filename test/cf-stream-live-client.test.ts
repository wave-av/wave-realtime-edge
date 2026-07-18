// #35-B / #78 — the concrete CfStreamLiveClient adapter. Proves it creates a CF Stream live_input with
// recording.mode:"automatic" (REQUIRED for the LL-HLS the bridge pulls — #211), parses uid + push endpoints,
// writes the uid→org binding the receiver resolves server-side, and surfaces EVERY failure (CF non-2xx, missing
// uid, KV bind failure, network) as a discriminated non-ok result — never a fake success. Fake fetch + fake KV.
import { describe, it, expect, vi } from "vitest";
import { makeCfStreamLiveClient, type StreamInputOrgKv } from "../src/cf-stream-live-client.js";
import type { CfStreamLiveIngestRequest } from "../src/ingress-cf-stream-live.js";
import { STREAM_INPUT_ORG_PREFIX } from "../src/stream-bridge.js";

const ACCT = "d674452f756fe46885a0d6ce7bc23f0a";
const TOKEN = "cf-stream-token-not-a-secret";
const REQ: CfStreamLiveIngestRequest = { room: "room-1", org: "org-acme", feed: { mode: "push", protocol: "rtmp" } };

const CF_OK = {
  result: {
    uid: "li-abc123",
    rtmps: { url: "rtmps://live.cloudflare.com:443/live/", streamKey: "sk-xyz" },
    srt: { url: "srt://live.cloudflare.com:778", streamId: "sid-xyz" },
  },
};

function fakeKv(): StreamInputOrgKv & { puts: Array<[string, string]> } {
  const puts: Array<[string, string]> = [];
  return { puts, put: vi.fn(async (k: string, v: string) => { puts.push([k, v]); }) };
}

/** A fake fetch returning a real Response with the given status/body. */
function fetchReturning(status: number, body: unknown) {
  return vi.fn(async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;
}

describe("makeCfStreamLiveClient — create + bind", () => {
  it("POSTs live_inputs with recording.mode:automatic + meta.name, Bearer-authed, to the right account", async () => {
    const fetchImpl = fetchReturning(200, CF_OK);
    const kv = fakeKv();
    const client = makeCfStreamLiveClient({ accountId: ACCT, apiToken: TOKEN, kv, fetchImpl });
    await client.createLiveInput(REQ);

    expect(fetchImpl).toHaveBeenCalledOnce();
    const [url, init] = (fetchImpl as unknown as { mock: { calls: [string, RequestInit][] } }).mock.calls[0];
    expect(url).toBe(`https://api.cloudflare.com/client/v4/accounts/${ACCT}/stream/live_inputs`);
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>).authorization).toBe(`Bearer ${TOKEN}`);
    const sent = JSON.parse(init.body as string);
    expect(sent.recording).toEqual({ mode: "automatic" });
    expect(sent.meta).toEqual({ name: "room-1" });
  });

  it("returns the uid + parsed rtmp/srt endpoints and writes the uid→org binding", async () => {
    const kv = fakeKv();
    const client = makeCfStreamLiveClient({ accountId: ACCT, apiToken: TOKEN, kv, fetchImpl: fetchReturning(200, CF_OK) });
    const result = await client.createLiveInput(REQ);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.input.uid).toBe("li-abc123");
      expect(result.input.endpoints).toEqual([
        { protocol: "rtmp", url: "rtmps://live.cloudflare.com:443/live/", streamKey: "sk-xyz" },
        { protocol: "srt", url: "srt://live.cloudflare.com:778", streamKey: "sid-xyz" },
      ]);
    }
    expect(kv.puts).toEqual([[`${STREAM_INPUT_ORG_PREFIX}li-abc123`, "org-acme"]]);
  });

  it("surfaces a CF non-2xx (401) as a non-ok result and writes NO binding", async () => {
    const kv = fakeKv();
    const client = makeCfStreamLiveClient({ accountId: ACCT, apiToken: TOKEN, kv, fetchImpl: fetchReturning(401, { errors: [] }) });
    const result = await client.createLiveInput(REQ);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(401);
    expect(kv.puts).toHaveLength(0);
  });

  it("is non-ok when the CF response is missing a uid — never binds a phantom input", async () => {
    const kv = fakeKv();
    const client = makeCfStreamLiveClient({ accountId: ACCT, apiToken: TOKEN, kv, fetchImpl: fetchReturning(200, { result: { rtmps: { url: "x" } } }) });
    const result = await client.createLiveInput(REQ);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/uid/);
    expect(kv.puts).toHaveLength(0);
  });

  it("surfaces a KV bind failure (orphan input) as non-ok, not a fake success", async () => {
    const kv: StreamInputOrgKv = { put: vi.fn(async () => { throw new Error("kv down"); }) };
    const client = makeCfStreamLiveClient({ accountId: ACCT, apiToken: TOKEN, kv, fetchImpl: fetchReturning(200, CF_OK) });
    const result = await client.createLiveInput(REQ);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/KV bind failed/);
  });

  it("surfaces a network failure as status 0", async () => {
    const kv = fakeKv();
    const fetchImpl = vi.fn(async () => { throw new Error("ECONNREFUSED"); }) as unknown as typeof fetch;
    const client = makeCfStreamLiveClient({ accountId: ACCT, apiToken: TOKEN, kv, fetchImpl });
    const result = await client.createLiveInput(REQ);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(0);
    expect(kv.puts).toHaveLength(0);
  });
});
