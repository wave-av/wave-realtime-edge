#!/usr/bin/env node
// deck-mcp — the MCP rendering of the voice-control-deck (minimal stdio MCP). Exposes deck_list + deck_fire.
// Thin over the deck API (the API is the authority). Env: DECK_ORIGIN, DECK_ORG, DECK_ROOM, DECK_SESSION, DECK_GATEWAY_KEY.

import { DeckClient } from './deck-sdk.mjs';

function client() {
  return new DeckClient({
    origin: process.env.DECK_ORIGIN,
    org: process.env.DECK_ORG,
    room: process.env.DECK_ROOM,
    session: process.env.DECK_SESSION,
    gatewayKey: process.env.DECK_GATEWAY_KEY,
  });
}

const TOOLS = [
  {
    name: 'deck_list',
    description: 'List the voice-control-deck command catalog + the session mute state.',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'deck_fire',
    description: 'Fire a deck command (mute | unmute) against the session.',
    inputSchema: { type: 'object', properties: { command: { type: 'string', enum: ['mute', 'unmute'] } }, required: ['command'] },
  },
];

function send(obj) { process.stdout.write(JSON.stringify(obj) + '\n'); }

async function handle(name, args = {}) {
  if (name === 'deck_list') return await client().list();
  if (name === 'deck_fire') return await client().fire(args.command);
  throw new Error(`unknown tool ${name}`);
}

let buf = '';
process.stdin.on('data', (chunk) => {
  buf += chunk.toString();
  let nl;
  while ((nl = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, nl);
    buf = buf.slice(nl + 1);
    if (!line.trim()) continue;
    const msg = JSON.parse(line);
    if (msg.method === 'initialize') {
      send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'deck-mcp', version: '1.0.0' } } });
    } else if (msg.method === 'tools/list') {
      send({ jsonrpc: '2.0', id: msg.id, result: { tools: TOOLS } });
    } else if (msg.method === 'tools/call') {
      handle(msg.params.name, msg.params.arguments ?? {})
        .then((result) => send({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: JSON.stringify(result) }] } }))
        .catch((e) => send({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: 'error: ' + (e?.message ?? e) }], isError: true } }));
    } else if (msg.id !== undefined) {
      send({ jsonrpc: '2.0', id: msg.id, result: {} });
    }
  }
});
