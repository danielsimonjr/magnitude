import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import {
  CatalogBaseId,
  CatalogVariantId,
  type CatalogPackageAffiliation,
  type CatalogPackageRole,
  type ModelPackageId,
} from "./_contracts-shim"
import { validIdentityComponent, validVariantId } from "./catalog"

export class CatalogAffiliations {
  private readonly serializedEntries = new Set<string>()

  private constructor(entries: Iterable<CatalogPackageAffiliation>) {
    for (const entry of entries) {
      this.serializedEntries.add(serializeEntry(entry))
    }
  }

  static load(root: string): CatalogAffiliations {
    try {
      const bytes = readFileSync(affiliationsPath(root))
      const document = JSON.parse(bytes.toString()) as unknown
      if (typeof document !== "object" || document === null || !("affiliations" in document)) {
        return new CatalogAffiliations([])
      }
      const affiliations = (document as { affiliations: unknown }).affiliations
      if (!Array.isArray(affiliations)) {
        return new CatalogAffiliations([])
      }
      const entries = affiliations
        .map((value) => decodeEntry(value))
        .filter((value): value is CatalogPackageAffiliation => value !== undefined)
      return new CatalogAffiliations(entries)
    } catch {
      return new CatalogAffiliations([])
    }
  }

  entries(): readonly CatalogPackageAffiliation[] {
    return [...this.serializedEntries]
      .map((value) => JSON.parse(value) as CatalogPackageAffiliation)
      .sort((left, right) => serializeEntry(left).localeCompare(serializeEntry(right)))
  }

  add(affiliation: CatalogPackageAffiliation): boolean {
    if (!validAffiliation(affiliation)) {
      return false
    }
    const key = serializeEntry(affiliation)
    if (this.serializedEntries.has(key)) {
      return false
    }
    this.serializedEntries.add(key)
    return true
  }

  persist(root: string): void {
    const payload = {
      affiliations: this.entries().map((entry) => ({
        modelId: entry.model_id,
        variantId: entry.variant_id,
        packageId: entry.package_id,
        repository: entry.repository,
        role: entry.role,
      })),
    }
    const destination = affiliationsPath(root)
    mkdirSync(root, { recursive: true })
    const temporary = join(root, `catalog-affiliations.json.tmp-${Date.now()}`)
    writeFileSync(temporary, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 })
    renameSync(temporary, destination)
  }

  equals(other: CatalogAffiliations): boolean {
    if (this.serializedEntries.size !== other.serializedEntries.size) {
      return false
    }
    for (const entry of this.serializedEntries) {
      if (!other.serializedEntries.has(entry)) {
        return false
      }
    }
    return true
  }
}

const affiliationsPath = (root: string): string => join(root, "catalog-affiliations.json")

const serializeEntry = (affiliation: CatalogPackageAffiliation): string =>
  JSON.stringify(affiliation)

const decodeEntry = (value: unknown): CatalogPackageAffiliation | undefined => {
  if (typeof value !== "object" || value === null) {
    return undefined
  }
  const entry = value as Record<string, unknown>
  const role = entry.role
  if (role !== "Target" && role !== "Dependency") {
    return undefined
  }
  try {
    const affiliation: CatalogPackageAffiliation = {
      model_id: CatalogBaseId.new(String(entry.modelId)),
      variant_id: CatalogVariantId.new(String(entry.variantId)),
      package_id: String(entry.packageId) as ModelPackageId,
      repository: String(entry.repository),
      role: role as CatalogPackageRole,
    }
    return validAffiliation(affiliation) ? affiliation : undefined
  } catch {
    return undefined
  }
}

const validRepository = (value: string): boolean => {
  const slash = value.indexOf("/")
  if (slash === -1) {
    return false
  }
  const owner = value.slice(0, slash)
  const name = value.slice(slash + 1)
  return (
    validRepositoryComponent(owner) &&
    validRepositoryComponent(name) &&
    !name.includes("/")
  )
}

const validRepositoryComponent = (value: string): boolean =>
  value.length > 0 && value !== "." && value !== ".." && !value.includes("\\") && !value.includes("\0")

export const validAffiliation = (affiliation: CatalogPackageAffiliation): boolean =>
  validIdentityComponent(CatalogBaseId.asStr(affiliation.model_id)) &&
  validVariantId(CatalogVariantId.asStr(affiliation.variant_id)) &&
  affiliation.package_id.length > 0 &&
  affiliation.package_id.trim() === affiliation.package_id &&
  validRepository(affiliation.repository)
