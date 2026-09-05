import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import {
  catalogBaseId,
  catalogVariantId,
  ModelIdError,
  modelPackageId,
  type CatalogPackageAffiliation,
  type CatalogPackageRole,
  type ModelPackageId,
} from "@magnitudedev/icn-contracts"
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
        modelId: entry.modelId,
        variantId: entry.variantId,
        packageId: entry.packageId,
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
  const base = catalogBaseId(String(entry.modelId))
  const variant = catalogVariantId(String(entry.variantId))
  if (base instanceof ModelIdError || variant instanceof ModelIdError) return undefined
  const affiliation: CatalogPackageAffiliation = {
    modelId: base,
    variantId: variant,
    packageId: modelPackageId(String(entry.packageId)),
    repository: String(entry.repository),
    role: role as CatalogPackageRole,
  }
  return validAffiliation(affiliation) ? affiliation : undefined
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
  validIdentityComponent(affiliation.modelId) &&
  validVariantId(affiliation.variantId) &&
  affiliation.packageId.length > 0 &&
  affiliation.packageId.trim() === affiliation.packageId &&
  validRepository(affiliation.repository)
