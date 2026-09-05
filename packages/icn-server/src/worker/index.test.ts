import { describe, expect, it } from "vitest"
import { workerCommand } from "./index.js"

describe("worker supervision", () => {
  it("builds installed and development worker commands", () => {
    expect(workerCommand("/bin/icn", "inference")).toEqual([
      "inference-worker",
      "--development-runtime",
    ])
    expect(workerCommand("/bin/icn", "planning", "/tmp/installation.json")).toEqual([
      "planning-worker",
      "--installation",
      "/tmp/installation.json",
    ])
  })
})
