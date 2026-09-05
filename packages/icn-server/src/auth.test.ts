import { describe, expect, it } from "vitest"
import { authorizeBearer } from "./auth.js"

describe("bearer auth", () => {
  it("allows health-equivalent open routes when no token is configured", () => {
    expect(authorizeBearer(undefined, null)).toBe(true)
    expect(authorizeBearer(undefined, "Bearer anything")).toBe(true)
  })

  it("requires an exact bearer match with constant-time length behavior", () => {
    expect(authorizeBearer("secret", "Bearer secret")).toBe(true)
    expect(authorizeBearer("secret", "Bearer secrets")).toBe(false)
    expect(authorizeBearer("secret", "bearer secret")).toBe(false)
    expect(authorizeBearer("secret", null)).toBe(false)
  })
})
