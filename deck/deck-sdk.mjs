// deck-sdk.mjs — the thin SDK rendering over the voice-control-deck API (the API is the authority).
// Zero-dep fetch wrapper over the edge's deck endpoints. Usage:
//   import { DeckClient } from './deck/deck-sdk.mjs';
//   const deck = new DeckClient({ origin: 'https://your-edge.example.com', org: 'wave', room: 'demo', session: 'sess', gatewayKey: '…' });
//   await deck.list();          // { commands:[{id,description,origin}], muted }
//   await deck.fire('mute');    // { command:'mute', muted:true }

export class DeckClient {
  constructor({ origin = process.env.DECK_ORIGIN ?? 'http://localhost:8787', org, room, session, gatewayKey, agentId }) {
    this.base = `${origin.replace(/\/+$/, '')}/v1/realtime/agents/${encodeURIComponent(org)}/${encodeURIComponent(room)}/${encodeURIComponent(session)}`;
    this.headers = {
      ...(org ? { 'x-wave-org': org } : {}),
      ...(gatewayKey ? { authorization: `Bearer ${gatewayKey}` } : {}),
    };
  }

  async list() {
    return this._fetch('/deck');
  }

  async fire(command) {
    return this._fetch(`/deck/${encodeURIComponent(command)}`, { method: 'POST' });
  }

  async _fetch(path, init = {}) {
    const res = await fetch(`${this.base}${path}`, { ...init, headers: { ...this.headers, ...(init.headers ?? {}) } });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`deck: ${res.status} ${JSON.stringify(body)}`);
    return body;
  }
}
