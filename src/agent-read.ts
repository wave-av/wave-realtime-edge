// agent-read.ts — the read/telemetry GET surface (info / spectrum / history) extracted from the AgentSessionDO
// to keep agent-session.ts under the 800-line gate. Pure reads over the session state; the DO passes accessors.

export interface ReadState {
  bound: { org?: string; roomId?: string; participantSessionId?: string } | null;
  timings: () => readonly unknown[];
  muted: boolean;
  latestSpectrum: { bins: number[]; at: number } | null;
  history: () => readonly { role: string; content: unknown }[];
  persistTranscript: () => Promise<boolean>;
}

/** Handle an info/spectrum/history GET route. Returns a Response, or null when it is not one of these. */
export function handleReadRequest(path: string, method: string, s: ReadState): Response | null {
  if (path === "info" && method === "GET") {
    return Response.json({ bound: s.bound, timings: s.timings(), muted: s.muted }, { status: 200 });
  }
  if (path === "spectrum" && method === "GET") {
    // The latest FFT spectrum (the audio-signal-plane tap output) — CORS-open so the audio.wave.online
    // dashboard can poll it. Returns null when no frame has been tapped yet (no live session).
    return Response.json(s.latestSpectrum ?? { bins: null, at: 0 }, {
      status: 200,
      headers: { "access-control-allow-origin": "*" },
    });
  }
  if (path === "history" && method === "GET") {
    // The conversation transcript (system + alternating user/assistant). A core product surface: every
    // voice-agent session must OFFER its transcript, not just speak it. `history()` is empty until armed.
    void s.persistTranscript(); // record on read (best-effort; the read never blocks on the write)
    return Response.json(
      {
        org: s.bound?.org ?? "",
        roomId: s.bound?.roomId ?? "",
        sessionId: s.bound?.participantSessionId ?? "",
        recordedAt: Date.now(),
        messages: s.history(),
      },
      { status: 200 },
    );
  }
  return null;
}
