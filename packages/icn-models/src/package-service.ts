import { createReadStream } from "node:fs"
import { basename, dirname, join } from "node:path"
import { createHash } from "node:crypto"
import { sha256 } from "@noble/hashes/sha2.js"
import { bytesToHex } from "@noble/hashes/utils.js"
import {
  ComponentRole,
  ContentIdentity,
  InventoryError,
  type ComponentRelationship,
  type ContentId,
  type InventoryModel,
  type InventoryProperties,
  type ModelAvailability,
  type ModelComponent,
  type ModelFile,
  type ModelFileId,
  type ModelFileRelationship,
  type ModelFileRole,
  type ModelPackage,
  type ModelPackageId,
  type ModelPackageProperties,
  type ModelPackageSource,
  type PackageValidation,
  type ResolvedModel,
  modelLocationComponents,
  type SpeculativeMethod,
  ModelFileId as ModelFileIdBrand,
  ModelPackageId as ModelPackageIdBrand,
} from "./_contracts-shim"
import { inspect, type GgufInspection } from "./gguf"

export class ServableModelBundleKey {
  readonly value: string
  constructor(value: string) {
    this.value = value
  }
}

export const canonicalPackageId = (
  files: readonly ModelFile[],
  relationships: readonly ModelFileRelationship[],
): ModelPackageId => {
  const digest = sha256.create()
  digest.update(new TextEncoder().encode("magnitude-model-package-v1\0"))
  for (const file of files) {
    digest.update(new TextEncoder().encode(file.id))
    digest.update(new Uint8Array([0]))
    digest.update(new TextEncoder().encode(file.role))
    digest.update(new Uint8Array([0]))
  }
  for (const relationship of relationships) {
    digest.update(new TextEncoder().encode(JSON.stringify(relationship)))
    digest.update(new Uint8Array([0]))
  }
  return ModelPackageIdBrand(`package_${bytesToHex(digest.digest())}`)
}

export const servingConfigurationFingerprint = (
  bundleKey: ServableModelBundleKey,
  profile: { context_length: number },
): string => {
  const digest = sha256.create()
  digest.update(new TextEncoder().encode(bundleKey.value))
  const context = new Uint8Array(4)
  new DataView(context.buffer).setUint32(0, profile.context_length, true)
  digest.update(context)
  return bytesToHex(digest.digest())
}

export const servableModelBundleKey = (packageIds: readonly ModelPackageId[]): ServableModelBundleKey => {
  const digest = sha256.create()
  digest.update(new TextEncoder().encode("magnitude-servable-model-bundle-v1\0"))
  for (const packageId of packageIds) {
    digest.update(new TextEncoder().encode(packageId))
    digest.update(new Uint8Array([0]))
  }
  return new ServableModelBundleKey(`bundle_${bytesToHex(digest.digest())}`)
}

export const speculativeServableModelBundleKey = (
  target: ModelPackageId,
  draft: ModelPackageId | undefined,
  method: SpeculativeMethod,
): ServableModelBundleKey => {
  const digest = sha256.create()
  digest.update(new TextEncoder().encode("magnitude-servable-model-bundle-v2\0speculative\0"))
  digest.update(new TextEncoder().encode(target))
  digest.update(new Uint8Array([0]))
  digest.update(new TextEncoder().encode(JSON.stringify(method)))
  digest.update(new Uint8Array([0]))
  if (draft === undefined) {
    digest.update(new TextEncoder().encode("embedded\0"))
  } else {
    digest.update(new TextEncoder().encode("separate\0"))
    digest.update(new TextEncoder().encode(draft))
    digest.update(new Uint8Array([0]))
  }
  return new ServableModelBundleKey(`bundle_${bytesToHex(digest.digest())}`)
}

export const servableModelBundleKeyForBundle = (
  bundle:
    | { readonly _tag: "Standalone"; package: ModelPackage }
    | {
        readonly _tag: "SpeculativeDecoding"
        target: ModelPackage
        draft_source: { readonly _tag: "Embedded" } | { readonly _tag: "Separate"; draft: ModelPackage }
        method: SpeculativeMethod
      },
): ServableModelBundleKey => {
  if (bundle._tag === "Standalone") {
    return servableModelBundleKey([bundle.package.id])
  }
  const draft =
    bundle.draft_source._tag === "Separate" ? bundle.draft_source.draft.id : undefined
  return speculativeServableModelBundleKey(bundle.target.id, draft, bundle.method)
}

export const packageRelationship = (
  relationship: ComponentRelationship,
  idsByDeclaredPath: Map<string, ModelFileId>,
): ModelFileRelationship | undefined => {
  switch (relationship._tag) {
    case "ProjectorFor": {
      const projector = idsByDeclaredPath.get(relationship.projector)
      const model = idsByDeclaredPath.get(relationship.model)
      if (projector === undefined || model === undefined) return undefined
      return { _tag: "ProjectorFor", projector_file_id: projector, weights_file_id: model }
    }
    case "MtpFor": {
      const mtp = idsByDeclaredPath.get(relationship.mtp)
      const model = idsByDeclaredPath.get(relationship.model)
      if (mtp === undefined || model === undefined) return undefined
      return { _tag: "MtpFor", mtp_file_id: mtp, weights_file_id: model }
    }
    case "DraftFor": {
      const draft = idsByDeclaredPath.get(relationship.draft)
      const model = idsByDeclaredPath.get(relationship.model)
      if (draft === undefined || model === undefined) return undefined
      return {
        _tag: "DraftFor",
        draft_file_id: draft,
        weights_file_id: model,
        method: relationship.method,
      }
    }
  }
}

export const shardCount = (indices: Iterable<number | undefined>): number => {
  let max = 0
  for (const index of indices) {
    if (index !== undefined && index > max) {
      max = index
    }
  }
  return max
}

const invalidPackageValidation = (code: string, message: string): PackageValidation => ({
  _tag: "Invalid",
  failure: { code, message, retryable: false },
})

export const packageValidationFor = (
  model: InventoryModel,
  package_: ModelPackage,
): PackageValidation => {
  switch (model.availability._tag) {
    case "InvalidArtifact":
      return {
        _tag: "Invalid",
        failure: {
          code: model.availability.code,
          message: model.availability.message,
          retryable: false,
        },
      }
    case "IncompatibleArtifact":
      return {
        _tag: "Unsupported",
        failure: {
          code: model.availability.code,
          message: model.availability.message,
          retryable: false,
        },
      }
    default:
      break
  }

  switch (model.properties._tag) {
    case "Pending":
      return { _tag: "Pending" }
    case "Unavailable":
      return {
        _tag: "Invalid",
        failure: {
          code: "inspection_unavailable",
          message: model.properties.reason,
          retryable: true,
        },
      }
    case "Inspected": {
      const projectors = package_.files.filter((file) => file.role === "projector")
      if (projectors.length === 0) {
        return { _tag: "Valid" }
      }
      if (projectors.length > 1) {
        return invalidPackageValidation(
          "ambiguous_projector_components",
          "a model package may contain at most one multimodal projector",
        )
      }
      const projector = projectors[0]
      const related = package_.relationships.some(
        (relationship) =>
          relationship._tag === "ProjectorFor" &&
          relationship.projector_file_id === projector.id &&
          package_.files.some(
            (file) => file.id === relationship.weights_file_id && file.role === "weights",
          ),
      )
      if (!related) {
        return invalidPackageValidation(
          "invalid_projector_relationship",
          "the multimodal projector is not related to package weights",
        )
      }
      return { _tag: "Valid" }
    }
  }
}

const digestFile = async (path: string): Promise<string> =>
  new Promise((resolve, reject) => {
    const hash = createHash("sha256")
    const stream = createReadStream(path)
    stream.on("data", (chunk) => hash.update(chunk))
    stream.on("error", (error) =>
      reject(InventoryError.Io({ message: `failed to read ${path}: ${error}` })),
    )
    stream.on("end", () => resolve(hash.digest("hex")))
  })

const fileId = (sha256Hex: string): ModelFileId => ModelFileIdBrand(`file_${sha256Hex}`)

const toModelFileRole = (role: ComponentRole): ModelFileRole => {
  switch (role) {
    case "Weights":
    case "Shard":
      return "weights"
    case "Projector":
      return "projector"
    case "Draft":
      return "draft"
    case "Mtp":
      return "mtp"
    case "Auxiliary":
      return "auxiliary"
  }
}

const packageSource = (model: InventoryModel, resolved: ResolvedModel): ModelPackageSource => {
  if (model.source._tag === "HuggingFace") {
    return {
      _tag: "HuggingFace",
      repository: model.source.repository,
      revision: model.source.commit,
    }
  }
  const root =
    model.location._tag === "Directory"
      ? model.location.root
      : model.location._tag === "File"
        ? dirname(model.location.path)
        : resolved.components[0]?.path !== undefined
          ? dirname(resolved.components[0].path)
          : "."
  return { _tag: "Local", path: root }
}

const packageProperties = (
  resolved: ResolvedModel,
  inspections: ReadonlyArray<[ComponentRole, GgufInspection]>,
): ModelPackageProperties => {
  const inspected = inspections
    .filter(([role]) => role === "Weights" || role === "Shard")
    .map(([, inspection]) => inspection)
  const modelIds = new Set(inspected.map((item) => item.name).filter((name): name is string => name !== null))
  const qualityIds = new Set(
    inspected.map((item) => item.quantization).filter((value): value is string => value !== null),
  )
  const complete = inspected.length > 0 && modelIds.size === 1 && qualityIds.size === 1
  const intrinsic_model_id = complete ? [...modelIds][0] ?? null : null
  const intrinsic_quality_id = complete ? [...qualityIds][0] ?? null : null

  if (resolved.model.properties._tag === "Inspected") {
    const properties = resolved.model.properties
    return {
      format: "gguf",
      quantization: properties.quantization ?? "unknown",
      quantization_name: properties.quantization_name ?? "unknown",
      architecture: properties.architecture ?? "unknown",
      maximum_context_length: properties.training_context_length,
      intrinsic_model_id,
      intrinsic_quality_id,
    }
  }
  return {
    format: "gguf",
    quantization: "unknown",
    quantization_name: "unknown",
    architecture: "unknown",
    maximum_context_length: null,
    intrinsic_model_id: null,
    intrinsic_quality_id: null,
  }
}

export const packageFromResolvedWith = async (
  resolved: ResolvedModel,
  digest: (path: string) => Promise<string>,
  inspectGguf: (path: string, content: ContentIdentity) => GgufInspection | undefined,
): Promise<ModelPackage> => {
  const model = resolved.model
  const source = packageSource(model, resolved)
  const declaredComponents = modelLocationComponents(model.location)
  if (declaredComponents.length !== resolved.components.length) {
    throw InventoryError.Integrity({
      message: `resolved model ${model.id} has ${declaredComponents.length} declared components but ${resolved.components.length} resolved components`,
    })
  }

  const files: ModelFile[] = []
  const idsByDeclaredPath = new Map<string, ModelFileId>()
  const inspections: Array<[ComponentRole, GgufInspection]> = []
  for (let index = 0; index < declaredComponents.length; index++) {
    const declared = declaredComponents[index]
    const resolvedComponent = resolved.components[index]!
    const absolute = resolvedComponent.path
    const inspection =
      model.properties._tag === "Inspected"
        ? inspectGguf(absolute, declared.content)
        : undefined
    if (inspection !== undefined) {
      inspections.push([declared.role, inspection])
    }
    let sha256Hex: string
    if (
      declared.content._tag === "Sha256" &&
      declared.content.value.length === 64 &&
      /^[0-9a-f]+$/.test(declared.content.value)
    ) {
      sha256Hex = declared.content.value
    } else {
      sha256Hex = await digest(absolute)
    }
    const id = fileId(sha256Hex)
    idsByDeclaredPath.set(declared.path, id)
    files.push({
      id,
      path: declared.path,
      role: toModelFileRole(declared.role),
      size_bytes: declared.size_bytes,
      tensor_storage_bytes: inspection?.tensor_storage_bytes ?? null,
      sha256: sha256Hex,
    })
  }
  files.sort((left, right) => left.path.localeCompare(right.path))

  const shardCountValue = shardCount(declaredComponents.map((component) => component.shard_index))
  const relationships: ModelFileRelationship[] = []
  for (const component of declaredComponents) {
    const fileIdValue = idsByDeclaredPath.get(component.path)
    if (fileIdValue === undefined) continue
    if (component.shard_index !== undefined) {
      relationships.push({
        _tag: "Shard",
        file_id: fileIdValue,
        index: component.shard_index,
        count: Math.max(shardCountValue, 1),
      })
    }
    if (component.relationship !== undefined) {
      const relationship = packageRelationship(component.relationship, idsByDeclaredPath)
      if (relationship !== undefined) {
        relationships.push(relationship)
      }
    }
  }
  relationships.sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)))
  const properties = packageProperties(resolved, inspections)
  const id = canonicalPackageId(files, relationships)
  return { id, source, files, relationships, properties }
}

export class ValidatedModelPackage {
  readonly package: ModelPackage
  readonly validation: PackageValidation
  constructor(package_: ModelPackage, validation: PackageValidation) {
    this.package = package_
    this.validation = validation
  }
}

export const validatedPackageFromResolved = async (
  resolved: ResolvedModel,
): Promise<ValidatedModelPackage> => {
  const package_ = await packageFromResolvedWith(
    resolved,
    digestFile,
    (path) => {
      try {
        return inspect(path)
      } catch {
        return undefined
      }
    },
  )
  return new ValidatedModelPackage(package_, packageValidationFor(resolved.model, package_))
}
