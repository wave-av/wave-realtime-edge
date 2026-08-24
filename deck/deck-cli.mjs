#!/usr/bin/env node
// deck-cli — the thin CLI rendering over the voice-control-deck API (the API is the authority).
//   DECK_GATEWAY_KEY=… node deck/deck-cli.mjs list --org wave --room demo --session sess
//   DECK_GATEWAY_KEY=… node deck/deck-cli.mjs fire mute --org wave --room demo --session sess

import { DeckClient } from './deck-sdk.mjs';

const argv = process.argv.slice(2);
const args = {};
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (!a.startsWith('--')) continue;
  const eq = a.indexOf('=');
  if (eq >= 0) { args[a.slice(2, eq)] = a.slice(eq + 1); continue; }
  const next = argv[i + 1];
  args[a.slice(2)] = next && !next.startsWith('--') ? (i++, next) : true;
}
const [cmd, command] = [argv[0], argv[1]];
const client = new DeckClient({
  origin: args.origin ?? process.env.DECK_ORIGIN ?? 'http://localhost:8787',
  org: args.org ?? process.env.DECK_ORG,
  room: args.room ?? process.env.DECK_ROOM,
  session: args.session ?? process.env.DECK_SESSION,
  gatewayKey: args['gateway-key'] ?? process.env.DECK_GATEWAY_KEY,
});

if (cmd === 'list') {
  console.log(JSON.stringify(await client.list(), null, 2));
} else if (cmd === 'fire') {
  if (!command) { console.error('usage: deck-cli fire <mute|unmute> --org … --room … --session …'); process.exit(1); }
  console.log(JSON.stringify(await client.fire(command), null, 2));
} else {
  console.error('usage: deck-cli <list|fire <cmd>> --org … --room … --session …');
  process.exit(1);
}
