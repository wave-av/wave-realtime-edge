// SCOPED vitest config for the stream-bridge container ONLY (mirrors containers/rt-encoder/vitest.config.mjs).
// The repo-root vitest.config.ts globs src/**+test/**; this self-contained config runs the container's own
// .mjs tests (the pure relay orchestration — no werift, no live network, no Worker runtime).
// Run with:  npx vitest run --config containers/stream-bridge/vitest.config.mjs
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    root: new URL(".", import.meta.url).pathname,
    include: ["test/**/*.test.mjs"],
  },
});
