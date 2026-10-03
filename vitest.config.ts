import { fileURLToPath } from "node:url"

import { defineConfig } from "vitest/config"

export default defineConfig({
  resolve: {
    // `@/*` is a tsconfig path; vitest does not read tsconfig on its own.
    alias: {
      "@": fileURLToPath(new URL(".", import.meta.url)),
    },
  },
  test: {
    include: ["tests/**/*.test.ts"],
    // The model suite drives a real daemon and is opt-in: see tests/model.test.ts.
    exclude: ["tests/model.test.ts", "node_modules/**"],
  },
})
