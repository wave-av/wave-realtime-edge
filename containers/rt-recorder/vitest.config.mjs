// SCOPED vitest config for the rt-recorder container ONLY (mirrors containers/rt-encoder). The repo-root
// vitest.config.ts globs src/**+test/** and imports the Worker runtime; this container is Node-only (werift)
// so it MUST run under its own config. The unit tests here are pure (codec routing, SFU REST with a fake
// fetch, file→sink streaming) — they do NOT import werift, so they run fast with no native deps.
// Run with:  npx vitest run --config containers/rt-recorder/vitest.config.mjs
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    root: new URL(".", import.meta.url).pathname,
    include: ["test/**/*.test.mjs"],
    testTimeout: 20_000,
  },
});
