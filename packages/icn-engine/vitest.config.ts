import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    name: "@magnitudedev/icn-engine",
    include: ["src/**/*.test.ts"],
  },
})
