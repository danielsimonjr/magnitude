import { ParseResult, Schema } from "effect"
import { isNfcNormalized, optional, Path, transparentStringId, U32 } from "../schema/common.js"

export class ModelIdError {
  constructor(readonly message: string) {}
}

const modelIdError = (message: string): ModelIdError => new ModelIdError(message)

const validateNormalizedComponent = (value: string, label: string): ModelIdError | null => {
  if (value.length === 0) return modelIdError(`${label} must not be empty`)
  if (value === "." || value === "..") return modelIdError(`${label} must not be a traversal component`)
  if (value.includes("\\")) return modelIdError(`${label} must not contain a backslash`)
  if (/[\u0000-\u001F\u007F]/.test(value)) return modelIdError(`${label} must not contain control characters`)
  if (!isNfcNormalized(value)) return modelIdError(`${label} must be NFC-normalized UTF-8`)
  return null
}

export const ModelFileId = transparentStringId("ModelFileId")
export type ModelFileId = typeof ModelFileId.Type
export const modelFileId = (value: string): ModelFileId => value as ModelFileId

export const ModelPackageId = transparentStringId("ModelPackageId")
export type ModelPackageId = typeof ModelPackageId.Type
export const modelPackageId = (value: string): ModelPackageId => value as ModelPackageId

export const ModelDownloadId = transparentStringId("ModelDownloadId")
export type ModelDownloadId = typeof ModelDownloadId.Type
export const modelDownloadId = (value: string): ModelDownloadId => value as ModelDownloadId

export const ModelAssessmentId = transparentStringId("ModelAssessmentId")
export type ModelAssessmentId = typeof ModelAssessmentId.Type
export const modelAssessmentId = (value: string): ModelAssessmentId => value as ModelAssessmentId

export const AssessmentEnvironmentId = transparentStringId("AssessmentEnvironmentId")
export type AssessmentEnvironmentId = typeof AssessmentEnvironmentId.Type

export const ModelInstanceId = transparentStringId("ModelInstanceId")
export type ModelInstanceId = typeof ModelInstanceId.Type

export const CatalogInstallationOperationId = transparentStringId("CatalogInstallationOperationId")
export type CatalogInstallationOperationId = typeof CatalogInstallationOperationId.Type

export const CatalogBaseId = Schema.String.pipe(
  Schema.filter((value) => {
    const error = validateNormalizedComponent(value, "catalog base")
    if (error !== null) return error.message
    if (value === "hf" || value.includes(":") || value.includes("/")) {
      return "catalog base must be one non-hf identity component"
    }
    return true
  }),
  Schema.brand("CatalogBaseId")
)
export type CatalogBaseId = typeof CatalogBaseId.Type

export const catalogBaseId = (value: string): CatalogBaseId | ModelIdError => {
  const result = Schema.decodeUnknownEither(CatalogBaseId)(value)
  return result._tag === "Left" ? modelIdError(String(result.left)) : result.right
}

export const CatalogVariantId = Schema.String.pipe(
  Schema.filter((value) => {
    const parts = value.split(":")
    if (parts.length !== 2) return "catalog variant must have format and quality components"
    const [format, quality] = parts
    for (const [component, label] of [[format, "catalog variant format"], [quality, "catalog variant quality"]] as const) {
      const error = validateNormalizedComponent(component, label)
      if (error !== null) return error.message
      if (component.includes("/")) return "catalog variant components must not contain slashes"
    }
    return true
  }),
  Schema.brand("CatalogVariantId")
)
export type CatalogVariantId = typeof CatalogVariantId.Type

export const catalogVariantId = (value: string): CatalogVariantId | ModelIdError => {
  const result = Schema.decodeUnknownEither(CatalogVariantId)(value)
  return result._tag === "Left" ? modelIdError(String(result.left)) : result.right
}

export const HuggingFaceRepositoryId = Schema.String.pipe(
  Schema.filter((value) => {
    const parts = value.split("/")
    if (parts.length !== 2) return "repository must have exactly owner and repository components"
    for (const [component, label] of [[parts[0], "owner"], [parts[1], "repository"]] as const) {
      const error = validateNormalizedComponent(component, label)
      if (error !== null) return error.message
    }
    return true
  }),
  Schema.brand("HuggingFaceRepositoryId")
)
export type HuggingFaceRepositoryId = typeof HuggingFaceRepositoryId.Type

export const huggingFaceRepositoryId = (value: string): HuggingFaceRepositoryId | ModelIdError => {
  const result = Schema.decodeUnknownEither(HuggingFaceRepositoryId)(value)
  return result._tag === "Left" ? modelIdError(String(result.left)) : result.right
}

export const HuggingFaceArtifactSelector = Schema.String.pipe(
  Schema.filter((value) => {
    if (value.startsWith("/")) return "artifact selector must be repository-relative"
    if (value.includes("\\")) return "artifact selector must not contain a backslash"
    if (!value.toLowerCase().endsWith(".gguf")) return "artifact selector must identify a GGUF file"
    if (value.split("/").some((component) => component.length === 0)) {
      return "artifact selector must not contain empty components"
    }
    for (const component of value.split("/")) {
      const error = validateNormalizedComponent(component, "artifact selector component")
      if (error !== null) return error.message
    }
    return true
  }),
  Schema.brand("HuggingFaceArtifactSelector")
)
export type HuggingFaceArtifactSelector = typeof HuggingFaceArtifactSelector.Type

export const huggingFaceArtifactSelector = (value: string): HuggingFaceArtifactSelector | ModelIdError => {
  const result = Schema.decodeUnknownEither(HuggingFaceArtifactSelector)(value)
  return result._tag === "Left" ? modelIdError(String(result.left)) : result.right
}

export type ParsedModelId =
  | { readonly type: "catalog"; readonly baseId: CatalogBaseId; readonly variantId: CatalogVariantId }
  | {
      readonly type: "hugging_face"
      readonly repositoryId: HuggingFaceRepositoryId
      readonly artifactSelector: HuggingFaceArtifactSelector
    }

export const parseModelId = (value: string): ParsedModelId | ModelIdError => {
  if (value.startsWith("hf:")) {
    const remainder = value.slice("hf:".length)
    const slashIndex = remainder.indexOf("/")
    if (slashIndex === -1) return modelIdError("invalid model ID")
    const owner = remainder.slice(0, slashIndex)
    const rest = remainder.slice(slashIndex + 1)
    const secondSlash = rest.indexOf("/")
    if (secondSlash === -1) return modelIdError("invalid model ID")
    const repository = rest.slice(0, secondSlash)
    const selector = rest.slice(secondSlash + 1)
    const repositoryId = huggingFaceRepositoryId(`${owner}/${repository}`)
    if (repositoryId instanceof ModelIdError) return repositoryId
    const artifactSelector = huggingFaceArtifactSelector(selector)
    if (artifactSelector instanceof ModelIdError) return artifactSelector
    return { type: "hugging_face", repositoryId, artifactSelector }
  }

  const colonIndex = value.indexOf(":")
  if (colonIndex === -1) return modelIdError("invalid model ID")
  const base = catalogBaseId(value.slice(0, colonIndex))
  if (base instanceof ModelIdError) return base
  const variant = catalogVariantId(value.slice(colonIndex + 1))
  if (variant instanceof ModelIdError) return variant
  return { type: "catalog", baseId: base, variantId: variant }
}

export class ModelId {
  constructor(readonly value: string) {}

  static catalog(baseId: CatalogBaseId, variantId: CatalogVariantId): ModelId {
    return new ModelId(`${baseId}:${variantId}`)
  }

  static huggingFace(repositoryId: HuggingFaceRepositoryId, artifactSelector: HuggingFaceArtifactSelector): ModelId {
    return new ModelId(`hf:${repositoryId}/${artifactSelector}`)
  }

  static fromString(value: string): ModelId | ModelIdError {
    const parsed = parseModelId(value)
    if (parsed instanceof ModelIdError) return parsed
    return new ModelId(value)
  }

  asStr(): string {
    return this.value
  }

  parsed(): ParsedModelId {
    const parsed = parseModelId(this.value)
    if (parsed instanceof ModelIdError) {
      throw new Error("ModelId construction validates its private representation")
    }
    return parsed
  }

  toString(): string {
    return this.value
  }
}

export const ModelIdSchema = Schema.transformOrFail(Schema.String, Schema.typeSchema(Schema.Any), {
  strict: true,
  decode: (value, _, ast) => {
    const parsed = ModelId.fromString(value)
    if (parsed instanceof ModelIdError) {
      return ParseResult.fail(new ParseResult.Type(ast, value, parsed.message))
    }
    return ParseResult.succeed(parsed)
  },
  encode: (value) => ParseResult.succeed(value.value),
})

export const isValidIsoDate = (value: string): boolean => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const year = Number(value.slice(0, 4))
  const month = Number(value.slice(5, 7))
  const day = Number(value.slice(8, 10))
  if (year === 0) return false
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0)
  const daysInMonth =
    month === 1 || month === 3 || month === 5 || month === 7 || month === 8 || month === 10 || month === 12
      ? 31
      : month === 4 || month === 6 || month === 9 || month === 11
        ? 30
        : month === 2
          ? leapYear
            ? 29
            : 28
          : 0
  return month >= 1 && month <= 12 && day > 0 && day <= daysInMonth
}

export const ModelReleaseDate = Schema.String.pipe(
  Schema.filter((value) => isValidIsoDate(value) || `invalid model release date ${JSON.stringify(value)}; expected YYYY-MM-DD`),
  Schema.brand("ModelReleaseDate")
)
export type ModelReleaseDate = typeof ModelReleaseDate.Type

export const modelReleaseDate = (value: string): ModelReleaseDate | string => {
  const result = Schema.decodeUnknownEither(ModelReleaseDate)(value)
  return result._tag === "Left" ? String(result.left) : result.right
}