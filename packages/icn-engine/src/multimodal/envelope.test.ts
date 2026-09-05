import { describe, expect, it } from "vitest"
import { ImageInput } from "@magnitudedev/icn-contracts"
import {
  mediaMarkerLength,
  randomMediaMarker,
  validateImageBatch,
  validateImageEnvelope,
  validateImageInputLimits,
} from "./envelope.js"

const limits = () => ({
  max_images: 1,
  max_input_bytes_per_image: 8,
  max_decoded_bytes_per_image: 3,
  max_total_decoded_bytes: 3,
})

const png = (extra: number[] = []): number[] => [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...extra]

describe("validate image envelope", () => {
  it("rejects non-images, empty images, and large inputs", () => {
    expect(validateImageEnvelope(ImageInput.new("text/plain", [1]), 0, limits())).toBeDefined()
    expect(validateImageEnvelope(ImageInput.new("image/png", []), 0, limits())).toBeDefined()
    expect(
      validateImageEnvelope(ImageInput.new("image/png", png([1, 2, 3, 4, 5, 6, 7, 8, 9])), 0, limits())
    ).toBeDefined()
    expect(validateImageEnvelope(ImageInput.new("image/png", png()), 0, limits())).toBeUndefined()
  })

  it("rejects mismatched magic bytes", () => {
    expect(
      validateImageEnvelope(ImageInput.new("image/png", [0xff, 0xd8, 0xff, 0xe0]), 0, limits())
    ).toMatchObject({ message: expect.stringContaining("PNG signature") })
  })
})

describe("validate image batch", () => {
  it("enforces max_images and requires at least one image", () => {
    expect(validateImageBatch([], limits())).toBeDefined()
    expect(
      validateImageBatch(
        [ImageInput.new("image/png", png()), ImageInput.new("image/png", png())],
        limits()
      )
    ).toMatchObject({ message: expect.stringContaining("limit is 1") })
    expect(validateImageBatch([ImageInput.new("image/png", png())], limits())).toBeUndefined()
  })

  it("rejects inconsistent decoded limits", () => {
    expect(
      validateImageInputLimits({
        max_images: 1,
        max_input_bytes_per_image: 2,
        max_decoded_bytes_per_image: 10,
        max_total_decoded_bytes: 3,
      })
    ).toMatchObject({ message: expect.stringContaining("max_total_decoded_bytes") })
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
