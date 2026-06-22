// RT-P1.5 — SKIP bundle-guard (design §6). Anti-regression for the load-bearing SKIP invariant: the
// realtime recording write-path must contain NO import of `@wave-av/content-hash` (that is the FULL-tier
// claim path; realtime is tier=SKIP — the index is never touched). This test loads the recording/encoder/
// muxer source modules as raw text (Vite's import.meta.glob — no Node types needed; tsconfig has only
// @cloudflare/workers-types) and scans them + their transitive local imports for any such import. A future
// edit that silently FULL-tiers the SKIP writer fails HERE, mechanically, before it can reach prod.
import { describe, it, expect } from "vitest";

// Minimal local typing for Vite's `import.meta.glob` (vitest provides it at runtime; the repo's tsconfig
// includes only @cloudflare/workers-types, so we declare just the one signature we use — no extra dep).
declare global {
  interface ImportMeta {
    glob(
      pattern: string,
      options: { query: "?raw"; import: "default"; eager: true },
    ): Record<string, string>;
  }
}

const BANNED = "@wave-av/content-hash";

// Eagerly load every src/*.ts file as a raw string, keyed by its path. Covers the whole write-path graph.
const RAW = import.meta.glob("../../src/**/*.ts", { query: "?raw", import: "default", eager: true }) as Record<
  string,
  string
>;

/** The roots of the realtime recording write-path (matched by suffix against the glob keys). */
const ROOTS = [
  "src/recording-writer.ts",
  "src/encoders/encoder.ts",
  "src/encoders/factory.ts",
  "src/encoders/managed.ts",
  "src/encoders/container.ts",
  "src/encoders/container-adapter.ts",
  "src/encoders/wasm.ts",
  "src/muxer/webm.ts",
  "src/rtk-webhook.ts", // RT-P2.5: the webhook now PULLS recordings into the SKIP sink — guard it too
];

/** Extract `from "..."` / `import("...")` specifiers from a source file. */
function importsOf(source: string): string[] {
  const specs: string[] = [];
  const re = /\bfrom\s+["']([^"']+)["']|\bimport\s*\(\s*["']([^"']+)["']\s*\)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source)) !== null) specs.push((m[1] ?? m[2])!);
  return specs;
}

/** Look up a source file in RAW by a normalized `src/...ts` path (glob keys are relative, end with the path). */
function rawFor(srcPath: string): string | null {
  for (const key of Object.keys(RAW)) {
    if (key.endsWith("/" + srcPath) || key.endsWith(srcPath)) return RAW[key];
  }
  return null;
}

/** Resolve a local (`./`/`../`) specifier from a `src/...` file into a normalized `src/...ts` path. */
function resolveLocal(fromSrcPath: string, spec: string): string | null {
  if (!spec.startsWith(".")) return null; // bare/package specifier — not a local file to walk
  const fromDir = fromSrcPath.split("/").slice(0, -1);
  const parts = spec.split("/");
  const stack = [...fromDir];
  for (const part of parts) {
    if (part === "." || part === "") continue;
    if (part === "..") stack.pop();
    else stack.push(part);
  }
  let p = stack.join("/");
  if (p.endsWith(".js")) p = p.slice(0, -3) + ".ts";
  else if (!p.endsWith(".ts")) p = p + ".ts";
  return p;
}

/** Transitively collect every local file reachable from the recording write-path roots. */
function walk(): { files: string[]; offenders: Array<{ file: string; spec: string }> } {
  const seen = new Set<string>();
  const offenders: Array<{ file: string; spec: string }> = [];
  const stack = [...ROOTS];
  while (stack.length) {
    const srcPath = stack.pop()!;
    if (seen.has(srcPath)) continue;
    seen.add(srcPath);
    const src = rawFor(srcPath);
    expect(src, `write-path root not found in glob: ${srcPath}`).not.toBeNull();
    for (const spec of importsOf(src!)) {
      if (spec === BANNED || spec.startsWith(BANNED + "/")) offenders.push({ file: srcPath, spec });
      const local = resolveLocal(srcPath, spec);
      if (local && rawFor(local)) stack.push(local);
    }
  }
  return { files: [...seen], offenders };
}

describe("SKIP bundle-guard — no @wave-av/content-hash in the realtime recording write-path", () => {
  it("every write-path root + its transitive local imports are content-hash-free", () => {
    const { files, offenders } = walk();
    expect(files.length).toBeGreaterThanOrEqual(ROOTS.length); // graph actually walked
    expect(
      offenders,
      `SKIP invariant VIOLATED — content-hash imported in the recording path: ${JSON.stringify(offenders)}`,
    ).toEqual([]);
  });

  it("the guard would CATCH a content-hash import (positive control)", () => {
    // Prove the detector isn't vacuously green: a synthetic source with the banned import must be flagged.
    const synthetic = `import { claim } from "${BANNED}";\nexport const x = claim;`;
    const flagged = importsOf(synthetic).some((s) => s === BANNED || s.startsWith(BANNED + "/"));
    expect(flagged).toBe(true);
  });
});
