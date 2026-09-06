// Vitest config for the OpenClaw TypeScript suite.
//
// Scope (Sep-2026): image-outputs helpers, cell-level handler parity with the
// Hermes pytest suite, and the notebook/server lifecycle handlers. Vitest is
// configured to stay compatible with the plugin's strict tsc build:
//
//   - esnext + bundler resolution mirrors tsconfig.json so a green run here
//     means a green `tsc --noEmit` for the same sources;
//   - tests live under `src/**/*.test.ts` next to the modules they exercise;
//     this keeps imports short and lets vitest's `vi.mock` find them without
//     a build step;
//   - jsdom is not needed — there's no DOM surface here.

import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

const here = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    // The hermes side runs in 0.13s; we don't expect the TS suite to be much
    // slower since it stubs out `fetch` / WebSocket entirely.
    testTimeout: 5000,
  },
  // At production runtime the OpenClaw host package provides a real
  // `openclaw/plugin-sdk/plugin-entry` implementation. There is no
  // `openclaw` package installed in this plugin's node_modules — only an
  // ambient `.d.ts` declaration that carries the type surface for tsc.
  // Without this alias, vitest's runtime resolution of
  // `index.ts`'s `import { definePluginEntry } from "openclaw/plugin-sdk/
  // plugin-entry"` fails the test run before any test executes.
  //
  // The stub at `src/test-stub-openclaw-sdk.ts` mirrors the minimum surface
  // our handlers touch (just `definePluginEntry`) so handler tests can
  // drive `pluginEntry.register(api)` without standing up the host.
  resolve: {
    alias: {
      "openclaw/plugin-sdk/plugin-entry": `${here}/src/test-stub-openclaw-sdk.ts`,
    },
  },
});
