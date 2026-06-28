// RT-R10 (#72) Gap 2 — the fs-backed LocalFileWriter finalizes a REAL local file (the P3 done-check:
// "recorder writes to a local dir for the on-prem app to consume"). Real fs, node env. Proves: append→close
// writes the EXACT bytes to an R2-mirrored path with a sniffed extension; non-webm first bytes → .raw;
// no-write → null + NO file (no 0-byte object); discard removes the partial file.
import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalFileWriter, localWriterFor } from "../server/local-file-writer.mjs";

const session = { org: "org_x", sessionId: "sess_ABC12345" };
const webm = (n) => Uint8Array.from([0x1a, 0x45, 0xdf, 0xa3, ...Array(n).fill(0x10)]);
const fresh = () => mkdtempSync(join(tmpdir(), "rt-local-"));

describe("LocalFileWriter — real fs sink (#72 P3 local-write proof)", () => {
  it("append → close writes the EXACT bytes to an R2-mirrored .webm path", async () => {
    const dir = fresh();
    try {
      const w = localWriterFor(dir, session);
      const a = webm(4);
      const b = Uint8Array.from([1, 2, 3]);
      await w.append(a);
      await w.append(b);
      const res = await w.close();
      expect(res).not.toBeNull();
      expect(res.bytes).toBe(a.length + b.length);
      expect(res.path).toBe(join(dir, "org_x", "realtime-recordings", "sess_ABC12345", "recording.webm"));
      const onDisk = new Uint8Array(readFileSync(res.path));
      expect(Array.from(onDisk)).toEqual([...a, ...b]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("non-webm first bytes → .raw extension", async () => {
    const dir = fresh();
    try {
      const w = new LocalFileWriter(dir, session);
      await w.append(Uint8Array.from([9, 9, 9, 9]));
      const res = await w.close();
      expect(res.path.endsWith("recording.raw")).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("no bytes → close returns null and writes NO file (no 0-byte object)", async () => {
    const dir = fresh();
    try {
      const w = new LocalFileWriter(dir, session);
      expect(await w.close()).toBeNull();
      expect(existsSync(join(dir, "org_x"))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("close is idempotent (same result, no double-end)", async () => {
    const dir = fresh();
    try {
      const w = new LocalFileWriter(dir, session);
      await w.append(webm(8));
      const a = await w.close();
      const b = await w.close();
      expect(b).toEqual(a);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("discard removes the partial file (fail-soft)", async () => {
    const dir = fresh();
    try {
      const w = new LocalFileWriter(dir, session);
      await w.append(webm(8));
      const p = w.path;
      await w.discard();
      expect(existsSync(p)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
