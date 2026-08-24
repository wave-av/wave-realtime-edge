// agent-deck.ts — the voice-control-deck command surface (E1 session controls + E2 deck API), extracted from
// the AgentSessionDO to keep agent-session.ts under the 800-line gate. Handles the mute/unmute/deck routes.
// The DO delegates here: the deck is the four-rendered command authority (API is the source; CLI/SDK/MCP call it).

/** The deck command catalog (E2 P0): the idempotent commands, each origin'd. */
export const DECK_COMMANDS = [
  { id: "mute", description: "drop the egress audio (turn off the mic)", origin: { source: "voice-control-deck", year: 2026 } },
  { id: "unmute", description: "resume listening (turn on the mic)", origin: { source: "voice-control-deck", year: 2026 } },
];

/**
 * Handle a deck/mute/unmute route. Returns a Response when the path matches, else null (the caller
 * continues routing). `muted` is the current state; `setMuted` flips it (the DO owns the field).
 */
export function handleDeckRequest(path: string, method: string, muted: boolean, setMuted: (v: boolean) => void): Response | null {
  if (path === "mute" && method === "POST") {
    // E1: mute = drop the egress audio (the "turn off the mic" intent). Idempotent.
    setMuted(true);
    return Response.json({ muted: true }, { status: 200 });
  }
  if (path === "unmute" && method === "POST") {
    // "turn on the mic": resume listening.
    setMuted(false);
    return Response.json({ muted: false }, { status: 200 });
  }
  if (path === "deck" && method === "GET") {
    // E2 P0: the deck API — list the command catalog + the state.
    return Response.json({ commands: DECK_COMMANDS, muted }, { status: 200 });
  }
  if (path.startsWith("deck/") && method === "POST") {
    // Fire a deck command idempotently. The four renderings (CLI/SDK/MCP) call this same surface.
    const command = path.slice("deck/".length);
    if (command === "mute") { setMuted(true); return Response.json({ command, muted: true }, { status: 200 }); }
    if (command === "unmute") { setMuted(false); return Response.json({ command, muted: false }, { status: 200 }); }
    return Response.json({ error: "unknown command", command }, { status: 404 });
  }
  return null;
}
