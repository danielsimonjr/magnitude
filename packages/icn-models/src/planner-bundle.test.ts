import { describe, expect, it } from "vitest"
import { encodePlannerBundle, PlannerBundle, plannerBundleSha256 } from "./planner-bundle"

describe("planner-bundle", () => {
  it("bundle_round_trips_verified_inputs", () => {
    const input = new TextEncoder().encode("compact planner input")
    const digest = plannerBundleSha256(input)
    const encoded = encodePlannerBundle(
      new TextEncoder().encode("manifest"),
      new Map([[digest, input]]),
    )
    const bundle = PlannerBundle.parse(encoded)
    expect(new TextDecoder().decode(bundle.manifest())).toBe("manifest")
    expect(bundle.digests()).toContain(digest)
    expect(bundle.input(digest)).toEqual(input)
  })

  it("old_bundle_format_is_not_accepted", () => {
    expect(() => PlannerBundle.parse(new TextEncoder().encode("MAGPLAN2\0\0\0\0"))).toThrow()
  })
})
