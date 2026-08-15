#!/usr/bin/env node
/**
 * ONE-COMMAND EGRESS KILL SWITCH (#278, W0 — cost-governance safety backstop).
 *
 * Flips the SAME KV flag `src/egress-killswitch.ts` reads (`isKillSwitchActive` / `activateKillSwitch`,
 * key `"egress:killswitch"`) via `wrangler kv key put/delete` against the `RT_MEETING_ORG` namespace binding
 * (wrangler.toml `[[kv_namespaces]] binding = "RT_MEETING_ORG"` — the one KV namespace this worker already
 * binds; reused, not a new namespace). This script ONLY flips the global flag, so every subsequent arm
 * (`evaluateArm`) rejects — it does NOT reach into already-running Durable Objects to force-close their
 * handles (Workers has no cross-isolate "call this method on every live DO" primitive). Tearing down streams
 * that are ALREADY armed happens the next time each RoomDO's own periodic sweep runs `sweepExpired` /
 * checks the flag (the max-duration alarm path), or immediately for a room that calls `activateKillSwitch`
 * itself with its own `disarm` callback (see egress-killswitch.ts docstring on `activateKillSwitch`).
 *
 * Usage:
 *   node scripts/kill-egress.mjs on  "<reason>"     # arm the kill switch — blocks all NEW egress
 *   node scripts/kill-egress.mjs off                # clear it — new arms resume (nothing auto re-arms)
 *   node scripts/kill-egress.mjs status              # read the current flag value
 *
 * Requires: `wrangler` authenticated against the correct Cloudflare account (same one wave-realtime-edge
 * deploys to), and reads `--env` from $WRANGLER_ENV if set (mirrors `deploy`/`deploy:dry` conventions).
 */
import { execFileSync } from "node:child_process";

const KEY = "egress:killswitch";
const NAMESPACE_BINDING = "RT_MEETING_ORG";

function wranglerArgs(extra) {
  const envFlag = process.env.WRANGLER_ENV ? ["--env", process.env.WRANGLER_ENV] : [];
  return ["kv", "key", ...extra, "--binding", NAMESPACE_BINDING, ...envFlag, "--remote"];
}

function run(args) {
  console.log(`$ wrangler ${args.join(" ")}`);
  execFileSync("wrangler", args, { stdio: "inherit" });
}

const [cmd, reason] = process.argv.slice(2);

switch (cmd) {
  case "on": {
    if (!reason) {
      console.error('Refusing to arm the kill switch without a reason: node scripts/kill-egress.mjs on "<reason>"');
      process.exit(1);
    }
    run(wranglerArgs(["put", KEY, "1"]));
    console.log(`Egress kill switch ARMED. reason="${reason}" — new egress arms will be rejected.`);
    console.log("Note: already-armed streams stop at their next duration sweep / self-check, not instantly.");
    break;
  }
  case "off": {
    run(wranglerArgs(["delete", KEY]));
    console.log("Egress kill switch CLEARED. New arms resume — nothing was auto-re-armed.");
    break;
  }
  case "status": {
    run(wranglerArgs(["get", KEY]));
    break;
  }
  default: {
    console.error('Usage: node scripts/kill-egress.mjs on "<reason>" | off | status');
    process.exit(1);
  }
}
