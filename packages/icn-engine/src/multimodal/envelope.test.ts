import { describe, expect, it } from "vitest"
import { ImageInput } from "@magnitudedev/icn-contracts"
import { mediaMarkerLength, randomMediaMarker, validateImageEnvelope } from "./envelope.js"

const limits = () => ({
  max_images: 1,
  max_input_bytes_per_image: 2,
  max_decoded_bytes_per_image: 3,
  max_total_decoded_bytes: 3,
})

describe("validate image envelope", () => {
  it("rejects non-images, empty images, and large inputs", () => {
    expect(validateImageEnvelope(ImageInput.new("text/plain", [1]), 0, limits())).toBeDefined()
    expect(validateImageEnvelope(ImageInput.new("image/png", []), 0, limits())).toBeDefined()
    expect(validateImageEnvelope(ImageInput.new("image/png", [1, 2, 3]), 0, limits())).toBeDefined()
    expect(validateImageEnvelope(ImageInput.new("image/png", [1, 2]), 0, limits())).toBeUndefined()
  })
})

describe("random media marker", () => {
  it("is process local and unambiguous", () => {
    const marker = randomMediaMarker()
    expect(marker.startsWith("<__magnitude_media_")).toBe(true)
    expect(marker.endsWith("__>")).toBe(true)
    expect(marker.length).toBe(mediaMarkerLength)
  })
})
