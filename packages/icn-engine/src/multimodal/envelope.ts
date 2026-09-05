import type { ImageInput, ImageInputLimits } from "@magnitudedev/icn-contracts"

export type MultimodalValidationError = { readonly message: string }

const ALLOWED_IMAGE_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/jpg",
  "image/webp",
  "image/gif",
  "image/bmp",
])

/** Validate ImageInputLimits internal consistency (CPU-side, no native decode). */
export const validateImageInputLimits = (
  limits: ImageInputLimits
): MultimodalValidationError | undefined => {
  if (limits.max_images < 1) {
    return { message: "max_images must be >= 1" }
  }
  if (limits.max_input_bytes_per_image < 1) {
    return { message: "max_input_bytes_per_image must be >= 1" }
  }
  if (limits.max_decoded_bytes_per_image < 1) {
    return { message: "max_decoded_bytes_per_image must be >= 1" }
  }
  if (limits.max_total_decoded_bytes < limits.max_decoded_bytes_per_image) {
    return {
      message:
        "max_total_decoded_bytes must be at least max_decoded_bytes_per_image",
    }
  }
  return undefined
}

export const validateImageEnvelope = (
  image: ImageInput,
  index: number,
  limits: ImageInputLimits
): MultimodalValidationError | undefined => {
  const mediaType = image.media_type().toLowerCase()
  if (!mediaType.startsWith("image/")) {
    return {
      message: `image ${index} has non-image media type ${image.media_type()}`,
    }
  }
  if (!ALLOWED_IMAGE_TYPES.has(mediaType) && mediaType !== "image/*") {
    // Accept vendor subtypes that still start with image/ but warn via message
    // only when clearly wrong; allow unknown image/* subtypes for forward compat.
    if (mediaType.includes("svg") || mediaType.includes("heic")) {
      return {
        message: `image ${index} has unsupported media type ${image.media_type()}`,
      }
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
  const magicError = validateImageMagic(image, index)
  if (magicError !== undefined) return magicError
  return undefined
}

/** Cheap magic-byte checks for common formats (no full decode). */
export const validateImageMagic = (
  image: ImageInput,
  index: number
): MultimodalValidationError | undefined => {
  const bytes = image.bytes
  if (bytes.length < 4) {
    return { message: `image ${index} is too short to identify an image format` }
  }
  const mediaType = image.media_type().toLowerCase()
  const isPng =
    bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47
  const isJpeg = bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff
  const isGif =
    bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38
  const isWebp =
    bytes.length >= 12 &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  const isBmp = bytes[0] === 0x42 && bytes[1] === 0x4d

  if (mediaType.includes("png") && !isPng) {
    return { message: `image ${index} claims image/png but lacks a PNG signature` }
  }
  if ((mediaType.includes("jpeg") || mediaType.includes("jpg")) && !isJpeg) {
    return { message: `image ${index} claims image/jpeg but lacks a JPEG signature` }
  }
  if (mediaType.includes("gif") && !isGif) {
    return { message: `image ${index} claims image/gif but lacks a GIF signature` }
  }
  if (mediaType.includes("webp") && !isWebp) {
    return { message: `image ${index} claims image/webp but lacks a WEBP signature` }
  }
  if (mediaType.includes("bmp") && !isBmp) {
    return { message: `image ${index} claims image/bmp but lacks a BMP signature` }
  }
  if (!isPng && !isJpeg && !isGif && !isWebp && !isBmp) {
    return {
      message: `image ${index} bytes do not match a supported image signature (png/jpeg/gif/webp/bmp)`,
    }
  }
  return undefined
}

/**
 * Validate a batch of images against envelope limits (count + per-image).
 * Does not decode pixels; decoded-byte limits require native MTMD.
 */
export const validateImageBatch = (
  images: readonly ImageInput[],
  limits: ImageInputLimits
): MultimodalValidationError | undefined => {
  const limitsError = validateImageInputLimits(limits)
  if (limitsError !== undefined) return limitsError
  if (images.length === 0) {
    return { message: "multimodal prompt preparation requires at least one image" }
  }
  if (images.length > limits.max_images) {
    return {
      message: `request contains ${images.length} images; the configured limit is ${limits.max_images}`,
    }
  }
  for (let index = 0; index < images.length; index++) {
    const error = validateImageEnvelope(images[index]!, index, limits)
    if (error !== undefined) return error
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
