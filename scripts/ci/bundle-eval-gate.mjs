#!/usr/bin/env node
// scripts/ci/bundle-eval-gate.mjs
//
// Ported from wave-av/wave-moq-edge PR #217 (merged to main) via the pilot rollout, the
// systemic prevention for moq-edge #215 — a 5-day prod outage where every `wrangler deploy --env
// production` failed at Cloudflare's upload step with `Uncaught ReferenceError: buildTokensCss is
// not defined`, while `tsc --noEmit` and a bundle-only `wrangler deploy --dry-run` both stayed
// green the whole time. Neither typechecks nor bundles EVALUATE the produced JS — Cloudflare's
// upload step does that server-side, which is why the break shipped silently. wave-realtime-edge
// (rt.wave.online) is a PAID CUSTOMER host with NO such gate today, deployed only via a Jake-named
// `workflow_dispatch` (never on push) — this is a CI-only gate: it never deploys anything.
//
// This gate boots the ACTUAL Worker bundle inside workerd via `wrangler dev` (local mode, zero
// Cloudflare credentials) — the same bundling path `wrangler deploy` uses — then a real workerd
// isolate loads the module graph exactly like Cloudflare's upload-time evaluation does. A
// top-level ReferenceError/SyntaxError fails the boot before "Ready on" ever prints, and this
// script fails loudly with the captured error. A clean boot + one successful HTTP round trip is
// the only thing that passes.
//
// ── wave-realtime-edge-specific adaptation (vs. the pilot template) ────────────────────────────
// wave-realtime-edge has NO `[env.production]` block: the top-level wrangler.toml config (name=
// wave-realtime-edge, rt.wave.online custom_domain) IS the deployed production config, so this
// gate boots the top-level config as-is — no `--env production` flag. (The repo does have a
// SEPARATE `[env.canary]` worker for a staging rehearsal; that is not gated here as it is not the
// customer-facing deploy target and named envs do not inherit top-level bindings anyway.)
//
// wave-realtime-edge declares NO `[ai]` / `[[vectorize]]` / hyperdrive / remote D1 bindings (the
// defect class the pilot hit). It DOES declare six Durable Object classes (RoomDO,
// RecorderContainer, StreamBridgeContainer, AgentSessionDO, ZoomRtmsBridgeDO,
// MoqPublishContainer) — plain SQLite-backed DOs (RoomDO, AgentSessionDO, ZoomRtmsBridgeDO) DO
// emulate fully locally in workerd and are left untouched. Three of the six are CONTAINER-backed
// DOs (`[[containers]]` + `[[durable_objects.bindings]]` pairs): RecorderContainer and
// MoqPublishContainer build their container image from a VENDORED, in-repo Dockerfile
// (containers/rt-encoder/, containers/moq-encode/) — verified locally: both build and boot fully
// offline via the local `docker` daemon, no Cloudflare account needed, so BOTH are kept.
// StreamBridgeContainer is different: its `image` is a PRE-PUSHED ref on Cloudflare's OWN managed
// registry (`registry.cloudflare.com/<acct>/wave-stream-bridge:v10-...`) — wrangler.toml's own
// comment explains why (the image bakes in a private GitHub Packages dep via a BuildKit build
// secret wrangler cannot pass, so it is built+pushed out-of-band and only REFERENCED here).
// Verified locally: booting the unmodified top-level config makes `wrangler dev` call Cloudflare's
// `/registries/{domain}/credentials` endpoint to pull that image and hard-fails `403 Forbidden`
// with zero Cloudflare credentials present — the exact "genuinely cannot bind locally" class
// `[ai]`/`[[vectorize]]` are in the pilot template. So this gate strips ONLY the
// StreamBridgeContainer `[[containers]]` block and its paired `[[durable_objects.bindings]]`
// entry (name="STREAM_BRIDGE") from the derived config before booting — every other Durable
// Object, container, KV namespace, and R2 bucket binding is untouched and still exercises the
// real module graph. See stripRemoteContainerImage() below for the exact mechanism.
//
// Why not a plain `node dist/index.js` eval? A Workers bundle is `export default { fetch... }`
// and references Workers-only runtime globals (crypto, caches, Request/Response shapes, `cf`
// properties, Durable Object stubs, KV/R2 bindings, etc.) at module scope. Evaluating that in
// plain Node throws on globals Node never defines — a FALSE POSITIVE unrelated to #215's actual
// defect class. Booting in workerd (via wrangler's local dev, which is Miniflare/workerd under
// the hood) is the only eval environment that matches production closely enough to avoid that
// false-positive class while still catching a genuine top-level ReferenceError.

import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SOURCE_CONFIG = join(ROOT, "wrangler.toml");
// Derived, gitignored (see .gitignore) — never committed, regenerated every run from the
// deployed wrangler.toml so it cannot drift. Must live at repo root: wrangler resolves `main`
// and every other relative path against the config file's own directory.
const DERIVED_CONFIG = join(ROOT, "wrangler.bundle-eval.generated.toml");

// Container build (RecorderContainer + MoqPublishContainer both build a real ffmpeg-bearing
// image from a vendored Dockerfile) can take several minutes cold on a CI runner with an empty
// Docker layer cache — budget generously so a slow-but-genuine local build doesn't false-fail.
const PORT = process.env.BUNDLE_EVAL_GATE_PORT ?? "18787";
const READY_TIMEOUT_MS = 8 * 60_000;
const FAILURE_PATTERNS = [
  /ReferenceError/,
  /is not defined/,
  /SyntaxError/,
  /Uncaught \(in promise\)/,
  /threw an exception/i,
  /Error: Could not resolve/,
];

// Only these two array-of-tables kinds can carry the StreamBridgeContainer remote-registry
// binding; every other table kind ([[migrations]], [[r2_buckets]], [[kv_namespaces]], ...) is
// left completely alone regardless of what text happens to appear near it.
const REMOVE_TABLE_HEADERS = new Set(["[[containers]]", "[[durable_objects.bindings]]"]);
// The one class this gate cannot boot locally: its `image` is a pre-pushed ref on Cloudflare's
// OWN managed registry (registry.cloudflare.com/...), which requires a live Cloudflare account
// to pull (`wrangler dev` calls the CF `/registries/{domain}/credentials` API and hard-fails
// `403 Forbidden` with zero credentials — verified locally, see this file's header). Every other
// container binding in this repo (RecorderContainer, MoqPublishContainer) builds from a vendored
// in-repo Dockerfile and boots fully offline, so only this one literal class name is matched.
const REMOTE_ONLY_CLASS = 'class_name = "StreamBridgeContainer"';

function log(...args) {
  console.log("[bundle-eval-gate]", ...args);
}

/**
 * Remove the `[[containers]]` block and the `[[durable_objects.bindings]]` block that together
 * back the one remote-registry-only container class (StreamBridgeContainer — see REMOTE_ONLY_CLASS
 * above), stopping each removed block at the next line beginning with `[`. Every other
 * `[[containers]]` / `[[durable_objects.bindings]]` block (RoomDO, RecorderContainer,
 * AgentSessionDO, ZoomRtmsBridgeDO, MoqPublishContainer) is copied through untouched, since none
 * of them contain the REMOTE_ONLY_CLASS marker.
 */
function stripRemoteContainerImage(toml) {
  const lines = toml.split("\n");
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (REMOVE_TABLE_HEADERS.has(line.trim())) {
      let j = i + 1;
      while (j < lines.length && !/^\s*\[/.test(lines[j])) {
        j++;
      }
      const block = lines.slice(i, j).join("\n");
      if (block.includes(REMOTE_ONLY_CLASS)) {
        i = j;
        continue;
      }
      out.push(...lines.slice(i, j));
      i = j;
      continue;
    }
    out.push(line);
    i++;
  }
  return out.join("\n");
}

function writeDerivedConfig() {
  writeFileSync(
    DERIVED_CONFIG,
    "# GENERATED by scripts/ci/bundle-eval-gate.mjs — DO NOT EDIT, DO NOT COMMIT.\n" +
      "# Identical to the deployed wrangler.toml except the StreamBridgeContainer `[[containers]]` +\n" +
      "# its paired `[[durable_objects.bindings]]` entry, stripped so `wrangler dev` boots fully\n" +
      "# local with zero Cloudflare credentials (its image is a pre-pushed ref on Cloudflare's own\n" +
      "# managed registry — see this script's header comment for the verified 403 without the\n" +
      "# strip). Every other Durable Object — RoomDO, RecorderContainer, AgentSessionDO,\n" +
      "# ZoomRtmsBridgeDO, MoqPublishContainer — plus every KV namespace and R2 bucket, is untouched\n" +
      "# and still emulated locally by Miniflare/workerd.\n" +
      stripRemoteContainerImage(readFileSync(SOURCE_CONFIG, "utf8")),
  );
  log(`derived ${DERIVED_CONFIG} from wrangler.toml (StreamBridgeContainer remote-registry binding stripped for local boot)`);
}

async function main() {
  writeDerivedConfig();

  log(`booting Worker bundle in workerd via 'wrangler dev' on port ${PORT} ...`);

  const child = spawn(
    "npx",
    [
      "wrangler",
      "dev",
      "--config",
      DERIVED_CONFIG,
      "--port",
      PORT,
      "--local-protocol",
      "http",
      "--ip",
      "127.0.0.1",
    ],
    {
      cwd: ROOT,
      env: {
        ...process.env,
        CI: "true",
        WRANGLER_UPDATE_CHECK: "false",
        WRANGLER_SEND_METRICS: "false",
        // Deliberately NO CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID — this gate proves the
        // bundle evaluates with zero Cloudflare credentials. rt.wave.online is a paid customer
        // host; no deploy-capable secret belongs in a job that runs on every PR push.
        CLOUDFLARE_API_TOKEN: "",
        CLOUDFLARE_ACCOUNT_ID: "",
        CF_API_TOKEN: "",
        CF_ACCOUNT_ID: "",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  let output = "";
  let ready = false;
  let failureLine = null;
  let exited = false;
  let exitCode = null;

  const onData = (buf) => {
    const text = buf.toString();
    output += text;
    process.stdout.write(text);
    if (!ready && /Ready on http/.test(text)) {
      ready = true;
    }
    if (!failureLine) {
      for (const pattern of FAILURE_PATTERNS) {
        const match = text.match(pattern);
        if (match) {
          failureLine = text.trim().split("\n").find((l) => pattern.test(l)) ?? match[0];
          break;
        }
      }
    }
  };

  child.stdout.on("data", onData);
  child.stderr.on("data", onData);
  child.on("exit", (code) => {
    exited = true;
    exitCode = code;
  });

  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (!ready && !failureLine && !exited && Date.now() < deadline) {
    await delay(250);
  }

  // Give a fast-failing process a brief grace window to flush its final error output.
  if (!ready && !failureLine) {
    await delay(500);
  }

  const shutdown = () => {
    if (!child.killed) {
      child.kill("SIGTERM");
    }
  };

  const cleanup = () => {
    try {
      unlinkSync(DERIVED_CONFIG);
    } catch {
      // best-effort — a CI runner is thrown away after the job anyway
    }
  };

  if (failureLine || exited) {
    shutdown();
    cleanup();
    log("FAILED — the Worker bundle did not evaluate cleanly in workerd.");
    if (failureLine) log(`Detected failure signature: ${failureLine}`);
    if (exited) log(`wrangler dev exited early with code ${exitCode}`);
    log("--- captured output ---");
    console.log(output);
    process.exitCode = 1;
    return;
  }

  if (!ready) {
    shutdown();
    cleanup();
    log(`FAILED — 'wrangler dev' never printed "Ready on" within ${READY_TIMEOUT_MS}ms.`);
    console.log(output);
    process.exitCode = 1;
    return;
  }

  // The module evaluated and the dev server bound its port. Confirm it actually serves a
  // request too — this is exactly the "throws only when Cloudflare EVALUATES the bundle at
  // upload" class (moq-edge #215): the process is up, but hitting it can still surface a
  // request-time throw for some defect shapes, so a green gate proves round-trip, not just
  // process-alive.
  let httpOk = false;
  try {
    const res = await fetch(`http://127.0.0.1:${PORT}/`, {
      signal: AbortSignal.timeout(10_000),
    });
    // Any HTTP status (including 404/401) proves the worker evaluated AND handled a request
    // without throwing — we don't assert a route contract here, only "it's alive".
    httpOk = typeof res.status === "number";
  } catch (err) {
    log(`HTTP round-trip to booted worker failed: ${err}`);
  }

  shutdown();
  cleanup();

  if (!httpOk) {
    log("FAILED — worker process bound its port but did not answer an HTTP request.");
    process.exitCode = 1;
    return;
  }

  log("PASSED — Worker bundle evaluated cleanly in workerd and served a request.");
  process.exitCode = 0;
}

main()
  .catch((err) => {
    console.error("[bundle-eval-gate] unexpected error:", err);
    process.exitCode = 1;
  })
  .finally(() => {
    // FORCE exit — do not rely on the event loop draining naturally. `wrangler dev` (this repo
    // boots RecorderContainer + MoqPublishContainer, two real Docker-container-backed Durable
    // Objects) can leave grandchild handles/pipes open after `child.kill("SIGTERM")` above returns
    // — SIGTERM asks `npx wrangler dev` to stop, but does not guarantee every descendant process
    // (docker exec streams, the workerd subprocess itself) has actually torn down its fds by the
    // time this script reaches here. Observed live in CI (wave-realtime-edge PR #473, run
    // 33786449325): the gate printed "PASSED" at 17:46:51 but the job then hung with zero further
    // output until the workflow's own timeout force-cancelled it 14 minutes later at 18:00:53 —
    // the script never called process.exit(), so Node kept the process alive waiting on whatever
    // handle was still open. `process.exit(process.exitCode ?? 0)` makes the gate's own verdict
    // (PASSED/FAILED, already logged and captured above) the only thing that determines the job's
    // outcome, independent of any child process cleanup race.
    process.exit(process.exitCode ?? 0);
  });
