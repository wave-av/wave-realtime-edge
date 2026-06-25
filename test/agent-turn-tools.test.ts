// Task #81 (LK-rip Phase 6b) step 5 — tool-calling via the gateway (the bounded agentic loop). Proves:
//   • text-only turn still works (regression covered in agent-turn.test.ts; here we focus on tool turns);
//   • a turn with ONE tool call: complete→tool_use→callTool→tool_result→complete→text→TTS (round-trip);
//   • the hard max-iterations cap stops a runaway tool loop (the agent never loops forever);
//   • an UNLISTED tool is REFUSED (never executed) — agent-least-privilege;
//   • callTool throwing is fail-safe (logged, error tool_result, no crash);
//   • barge-in DURING tool execution aborts the turn (no commit, no TTS);
//   • conversation history stays valid (strict alternation, correct Anthropic tool shapes) across tool turns.
// Every dep (complete / callTool / synthesize / transcribe) is a FAKE — zero live network.
import { describe, it, expect, vi } from "vitest";
import {
  TurnTakingCore,
  ToolAllowlist,
  type AgentTurnDeps,
  type TurnTakingConfig,
  type SttResult,
  type LlmMessage,
  type ToolDefinition,
  type CompletionEvent,
} from "../src/agent-turn.js";
import type { AgentMediaDeps, IngestSocket } from "../src/agent-session.js";
import { encodeIngestFrame } from "../src/agent-ingest-adapter.js";

const SESSION = "sess_ABCdef12345678";
const cfg: TurnTakingConfig = {
  roomId: "room1",
  org: "org1",
  agentId: "a1",
  participantSessionId: SESSION,
  participantTrackName: "mic",
  systemPrompt: "You are a helpful WAVE voice agent.",
};

const lookupTool: ToolDefinition = {
  name: "lookup",
  description: "Look something up.",
  input_schema: { type: "object", properties: { q: { type: "string" } } },
};
const allowlist = new ToolAllowlist([lookupTool]);

/** Build deps with a scripted `complete` (an array of event-arrays, one per LLM call) + a fake callTool. */
function mkDeps(
  scripts: CompletionEvent[][],
  over: Partial<AgentTurnDeps & AgentMediaDeps> = {},
) {
  const sent: Uint8Array[] = [];
  const logs: { msg: string; fields: Record<string, unknown> }[] = [];
  let t = 1000;
  let callIdx = 0;
  const sock: IngestSocket = { send: (d) => sent.push(new Uint8Array(d as ArrayBuffer)), close: () => {} };

  const transcribe = vi.fn(async (_pcm: Uint8Array): Promise<SttResult> => ({ isFinal: true, transcript: "go" }));
  const complete = vi.fn(async function* (_messages: LlmMessage[], _tools: ToolDefinition[]) {
    const script = scripts[Math.min(callIdx, scripts.length - 1)];
    callIdx += 1;
    for (const evt of script) yield evt;
  });
  const callTool = vi.fn(async (name: string, _input: unknown) => `result of ${name}`);
  const synthesize = vi.fn(async function* (_text: string) {
    yield new Uint8Array([1, 2, 3, 4]);
  });

  const deps: AgentTurnDeps & AgentMediaDeps = {
    createEgress: vi.fn(),
    createIngest: vi.fn(),
    ingestSocket: () => sock,
    now: () => t++,
    log: (msg, fields) => logs.push({ msg, fields }),
    transcribe,
    complete,
    callTool,
    synthesize,
    ...over,
  };
  return { deps, sent, logs, transcribe, complete, callTool, synthesize };
}

/** A final egress frame (0x00 → STT final) that fires a turn. */
const fire = () => encodeIngestFrame(new Uint8Array([1, 0x00]), { sequenceNumber: 1, timestamp: 0 }, "packet");

const text = (s: string): CompletionEvent => ({ type: "text", text: s });
const tool = (id: string, name: string, input: unknown): CompletionEvent => ({ type: "tool_use", id, name, input });

describe("TurnTakingCore — one tool call (full agentic round-trip)", () => {
  it("complete→tool_use→callTool→tool_result→complete→text→TTS", async () => {
    const { deps, sent, complete, callTool } = mkDeps([
      [tool("tu_1", "lookup", { q: "weather" })], // call 1: model requests a tool
      [text("It is sunny.")], // call 2: model speaks the answer
    ]);
    const core = new TurnTakingCore(deps, cfg, { tools: allowlist });
    await core.onFrame(fire());

    expect(callTool).toHaveBeenCalledWith("lookup", { q: "weather" });
    expect(complete).toHaveBeenCalledTimes(2);
    // Second LLM call's request must carry the assistant(tool_use) + user(tool_result) in correct Anthropic shapes.
    const req2 = (complete as ReturnType<typeof vi.fn>).mock.calls[1][0] as LlmMessage[];
    const roles = req2.map((m) => m.role);
    expect(roles).toEqual(["system", "user", "assistant", "user"]); // sys, user(go), assistant(tool_use), user(tool_result)
    const toolUseMsg = req2[2].content as Array<Record<string, unknown>>;
    expect(toolUseMsg[0]).toMatchObject({ type: "tool_use", id: "tu_1", name: "lookup" });
    const toolResultMsg = req2[3].content as Array<Record<string, unknown>>;
    expect(toolResultMsg[0]).toMatchObject({ type: "tool_result", tool_use_id: "tu_1", is_error: false });
    expect(toolResultMsg[0].content).toBe("result of lookup");
    // Final text was spoken (TTS published).
    expect(sent.length).toBe(1);
    // Committed history alternates and ends with the final assistant text.
    const hist = core.history();
    expect(hist.map((m) => m.role)).toEqual(["system", "user", "assistant", "user", "assistant"]);
    expect(hist[hist.length - 1].content).toBe("It is sunny.");
  });
});

describe("TurnTakingCore — agent-least-privilege", () => {
  it("refuses an UNLISTED tool — never executes it, returns an is_error tool_result, logs the refusal", async () => {
    const { deps, logs, callTool } = mkDeps([
      [tool("tu_x", "delete_account", { id: 1 })], // model requests a tool NOT on the allowlist
      [text("done")],
    ]);
    const core = new TurnTakingCore(deps, cfg, { tools: allowlist }); // only `lookup` is allowed
    await core.onFrame(fire());

    expect(callTool).not.toHaveBeenCalled(); // the unlisted tool was NEVER executed
    expect(logs.some((l) => l.msg === "agent-tool-refused" && l.fields.tool === "delete_account")).toBe(true);
    // The next LLM call still got a (refusal) tool_result so the loop is well-formed.
    const req2 = (deps.complete as ReturnType<typeof vi.fn>).mock.calls[1][0] as LlmMessage[];
    const tr = (req2[3].content as Array<Record<string, unknown>>)[0];
    expect(tr).toMatchObject({ type: "tool_result", tool_use_id: "tu_x", is_error: true });
  });
});

describe("TurnTakingCore — bounded loop (anti-runaway)", () => {
  it("stops at the max-iterations cap when the model keeps requesting tools forever", async () => {
    // EVERY LLM call requests a tool → without a cap this loops forever. cap=3 → at most 3 tool executions.
    const { deps, callTool, logs, sent } = mkDeps([[tool("t", "lookup", {})]]); // script repeats (last entry)
    const core = new TurnTakingCore(deps, cfg, { tools: allowlist, maxToolIterations: 3 });
    await core.onFrame(fire());
    expect(callTool).toHaveBeenCalledTimes(3); // exactly the cap — never unbounded
    expect(logs.some((l) => l.msg === "agent-turn-tool-cap")).toBe(true);
    expect(sent.length).toBe(0); // no final text → nothing spoken (clean abandon, no commit)
    expect(core.history().map((m) => m.role)).toEqual(["system"]); // no dangling user/tool committed
  });
});

describe("TurnTakingCore — fail-safety during tool calls", () => {
  it("callTool throwing is fail-safe (logged, error tool_result, turn continues then ends, no crash)", async () => {
    const { deps, logs } = mkDeps(
      [[tool("tu_e", "lookup", { q: "x" })], [text("recovered")]],
      { callTool: vi.fn(async () => { throw new Error("tool boom"); }) },
    );
    const core = new TurnTakingCore(deps, cfg, { tools: allowlist });
    await expect(core.onFrame(fire())).resolves.toBeUndefined(); // never throws up the media path
    expect(logs.some((l) => l.msg === "agent-tool-error" && l.fields.tool === "lookup")).toBe(true);
    const req2 = (deps.complete as ReturnType<typeof vi.fn>).mock.calls[1][0] as LlmMessage[];
    const tr = (req2[3].content as Array<Record<string, unknown>>)[0];
    expect(tr).toMatchObject({ tool_use_id: "tu_e", is_error: true }); // executor failure → error result, loop ok
  });

  it("does NOT log the raw tool input verbatim (audit redaction — name + size only)", async () => {
    const { deps, logs } = mkDeps([[tool("tu_s", "lookup", { secret: "p@ssw0rd-DO-NOT-LOG" })], [text("ok")]]);
    const core = new TurnTakingCore(deps, cfg, { tools: allowlist });
    await core.onFrame(fire());
    const serialized = JSON.stringify(logs);
    expect(serialized).not.toContain("p@ssw0rd-DO-NOT-LOG"); // the VALUE is never logged
    const callLog = logs.find((l) => l.msg === "agent-tool-call");
    expect(callLog!.fields).toMatchObject({ tool: "lookup" });
    expect(typeof callLog!.fields.inputBytes).toBe("number"); // a size summary IS logged
  });
});

describe("TurnTakingCore — barge-in during a tool call", () => {
  const tick = () => new Promise<void>((r) => setTimeout(r, 0));
  const loud = () =>
    encodeIngestFrame(new Uint8Array([0x10, 0x27, 0x10, 0x27, 0x10, 0x27]), { sequenceNumber: 9, timestamp: 0 }, "packet");

  it("user speech while a tool is executing aborts the turn — no further LLM call, no TTS, clean history", async () => {
    let releaseTool!: () => void;
    const toolGate = new Promise<void>((r) => (releaseTool = r));
    const { deps, sent, logs, complete } = mkDeps(
      [[tool("tu_b", "lookup", {})], [text("too late")]],
      { callTool: vi.fn(async () => { await toolGate; return "slow"; }) },
    );
    const core = new TurnTakingCore(deps, cfg, { tools: allowlist, vad: { onsetFrames: 1, rmsThreshold: 500 } });

    const turnP = core.onFrame(fire()); // parks awaiting the slow tool
    await tick();
    await core.onFrame(loud()); // barge-in DURING tool execution
    releaseTool();
    await turnP;

    expect(logs.some((l) => l.msg === "agent-turn-interrupt")).toBe(true);
    expect(complete).toHaveBeenCalledTimes(1); // the post-tool LLM re-call never happened (aborted)
    expect(sent.length).toBe(0); // nothing spoken
    expect(core.history().map((m) => m.role)).toEqual(["system"]); // no dangling user/tool committed on abort
  });
});

describe("TurnTakingCore — text-only regression with the new union", () => {
  it("a plain text turn (no tools) still speaks and commits one user/assistant pair", async () => {
    const { deps, sent, callTool } = mkDeps([[text("hello there")]]);
    const core = new TurnTakingCore(deps, cfg, { tools: allowlist });
    await core.onFrame(fire());
    expect(callTool).not.toHaveBeenCalled();
    expect(sent.length).toBe(1);
    expect(core.history().map((m) => m.role)).toEqual(["system", "user", "assistant"]);
  });
});
