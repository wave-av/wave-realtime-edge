import { describe, it, expect, vi, afterEach } from "vitest";
// The deck SDK is a runnable .mjs (no .d.mts) so the CLI/MCP run it directly under node.
// @ts-expect-error — TS7016: no declaration for the .mjs module
import { DeckClient } from "../deck/deck-sdk.mjs";

afterEach(() => vi.unstubAllGlobals());

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("DeckClient (the SDK rendering)", () => {
  it("list reads the command catalog + the mute state", async () => {
    const fn = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) =>
      json({ commands: [{ id: "mute", description: "…", origin: { source: "voice-control-deck", year: 2026 } }], muted: false }),
    );
    vi.stubGlobal("fetch", fn);
    const deck = new DeckClient({ org: "wave", room: "demo", session: "sess" });
    const res = await deck.list();
    expect(res.commands[0].id).toBe("mute");
    expect(res.muted).toBe(false);
    expect(fn.mock.calls[0]![0]).toContain("/v1/realtime/agents/wave/demo/sess/deck");
  });

  it("fire POSTs a command and returns the new state", async () => {
    const fn = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => json({ command: "mute", muted: true }));
    vi.stubGlobal("fetch", fn);
    const deck = new DeckClient({ org: "wave", room: "demo", session: "sess", gatewayKey: "k" });
    const res = await deck.fire("mute");
    expect(res).toMatchObject({ command: "mute", muted: true });
    const init = fn.mock.calls[0]![1] as RequestInit;
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer k");
  });

  it("a non-ok response throws with the body", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json({ error: "unknown command" }, 404)));
    const deck = new DeckClient({ org: "wave", room: "demo", session: "sess" });
    await expect(deck.fire("nope")).rejects.toThrow(/404/);
  });
});
