// SCOPED vitest config for the rt-encoder container ONLY. The repo-root vitest.config.ts globs
// src/**+test/** and we MUST NOT touch those (concurrent agent owns src/encoders). This self-contained
// config runs the container's own .mjs tests (pure parsers/selectors — no ffmpeg, no Worker runtime).
// Run with:  npx vitest run --config containers/rt-encoder/vitest.config.mjs
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    root: new URL(".", import.meta.url).pathname,
    include: ["test/**/*.test.mjs"],
    // Tier-2 cross-codec tests shell out to real ffmpeg/ffprobe (multiple transcodes per test); the 5s
    // default is too tight on a loaded box. Tier-1 (pure argv) tests are unaffected — they finish in ms.
    testTimeout: 60_000,
  },
});
