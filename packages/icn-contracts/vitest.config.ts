import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    name: "@magnitudedev/icn-contracts",
    include: ["src/**/*.test.ts"],
  },
})
