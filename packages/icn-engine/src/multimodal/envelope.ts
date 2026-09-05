import type { ImageInput, ImageInputLimits } from "@magnitudedev/icn-contracts"

export type MultimodalValidationError = { readonly message: string }

export const validateImageEnvelope = (
  image: ImageInput,
  index: number,
  limits: ImageInputLimits
): MultimodalValidationError | undefined => {
  if (!image.media_type().startsWith("image/")) {
    return {
      message: `image ${index} has non-image media type ${image.media_type()}`,
    }
  }
  if (image.byteLength() === 0) {
    return { message: `image ${index} has no bytes` }
  }
  if (image.byteLength() > limits.max_input_bytes_per_image) {
    return {
      message: `image ${index} contains ${image.byteLength()} compressed bytes; the per-image limit is ${limits.max_input_bytes_per_image}`,
    }
  }
  return undefined
}

export const randomMediaMarker = (): string => {
  const random = crypto.getRandomValues(new Uint8Array(16))
  const hex = Array.from(random, (byte) => byte.toString(16).padStart(2, "0")).join("")
  return `<__magnitude_media_${hex}__>`
}

export const mediaMarkerLength = "<__magnitude_media___>".length + 32

/**
 * Hardware-gated: load and evaluate multimodal projector chunks via MTMD FFI.
 */
export class MultimodalProjectorRuntime {
  static async load(): Promise<MultimodalProjectorRuntime> {
    throw new Error(
      "MultimodalProjectorRuntime.load requires native MTMD integration — not yet wired"
    )
  }

  async preparePrompt(): Promise<never> {
    throw new Error(
      "MultimodalProjectorRuntime.preparePrompt requires native MTMD integration — not yet wired"
    )
  }

  async evaluateMedia(): Promise<never> {
    throw new Error(
      "MultimodalProjectorRuntime.evaluateMedia requires native MTMD integration — not yet wired"
    )
  }
}
