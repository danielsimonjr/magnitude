import { Option } from "effect"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type {
  ApplyTemplateRequest,
  ApplyTemplateResponse,
  CatalogInstallationAdmission,
  CatalogInstallationOperation,
  CatalogInstallationRemoval,
  CatalogInstallationsResponse,
  CatalogModel,
  CatalogModelsResponse,
  DiscoveredModelsResponse,
  EnsureModelInstanceRequest,
  HuggingFaceModelSearchRequest,
  HuggingFaceModelSearchResults,
  HuggingFaceRepositoryRequest,
  HuggingFaceRepositorySnapshot,
  ModelAssessmentsSnapshot,
  ModelInstance,
  ModelInstancesSnapshot,
  ModelLoadPlan,
} from "@magnitudedev/icn-protocol"
import {
  searchHuggingFaceModels,
  resolveHuggingFaceRepository,
} from "@magnitudedev/icn-models"
import type { ModelId } from "@magnitudedev/icn-contracts"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import type { CatalogPackageAffiliation, RecommendableModelCatalog } from "@magnitudedev/icn-contracts"
import {
  CatalogAffiliations,
  InventoryConfig,
  ManagedCatalogInstallations,
  ManagedCatalogModels,
  ManagedDiscoveredModels,
  ManagedModelDownloads,
  ManagedModelStore,
  ModelDomainResolver,
  type InstalledPackageSnapshot,
} from "@magnitudedev/icn-models"
import { developmentRecommendableCatalog } from "./catalog-development.js"
import type { ServeConfig } from "./config.js"
import { ManagedStoreInventory, type InventoryPort } from "./inventory-port.js"
import { toWireJson } from "./wire.js"

export interface ServerServices {
  listCatalogModels(): Promise<CatalogModelsResponse>
  getCatalogModel(modelId: string): Promise<CatalogModel | undefined>
  installCatalogModel(modelId: string): Promise<CatalogInstallationAdmission>
  removeCatalogModelInstallation(modelId: string): Promise<CatalogInstallationRemoval>
  listCatalogInstallations(): Promise<CatalogInstallationsResponse>
  getCatalogInstallation(operationId: string): Promise<CatalogInstallationOperation | undefined>
  cancelCatalogInstallation(operationId: string): Promise<CatalogInstallationOperation>
  acknowledgeCatalogInstallationFailure(operationId: string): Promise<CatalogInstallationOperation>
  listDiscoveredModels(): Promise<DiscoveredModelsResponse>
  refreshDiscovery(): Promise<DiscoveredModelsResponse>
  listModelInstances(): Promise<ModelInstancesSnapshot>
  getModelInstance(instanceId: string): Promise<ModelInstance | undefined>
  ensureModelInstance(request: EnsureModelInstanceRequest): Promise<ModelInstance>
  stopModelInstance(instanceId: string): Promise<ModelInstance>
  listModelAssessments(): Promise<ModelAssessmentsSnapshot>
  previewModelLoad(modelId: string, body: unknown): Promise<ModelLoadPlan>
  searchHuggingFace(request: HuggingFaceModelSearchRequest): Promise<HuggingFaceModelSearchResults>
  resolveHuggingFace(request: HuggingFaceRepositoryRequest): Promise<HuggingFaceRepositorySnapshot>
  applyChatTemplate(request: ApplyTemplateRequest): Promise<ApplyTemplateResponse>
  modelProperties(modelId: string, body: unknown): Promise<Record<string, unknown>>
  openApiDocument(): unknown
}

export interface ServerServicesOptions {
  readonly catalog?: RecommendableModelCatalog
  readonly inventory?: InventoryPort
  readonly installations?: Pick<
    ManagedCatalogInstallations,
    | "listCatalogInstallations"
    | "install"
    | "remove"
    | "get"
    | "cancel"
    | "acknowledgeFailure"
  >
}

class InMemoryInventory implements InventoryPort {
  private snapshotState: InstalledPackageSnapshot = { records: new Map() }
  private generation = 0
  private readonly affiliations: CatalogAffiliations

  constructor(root: string) {
    this.affiliations = CatalogAffiliations.load(root)
  }

  installedPackagesResponse() {
    return {
      revision: this.generation,
      reconciliationComplete: true,
      packages: [],
    }
  }

  catalogAffiliations(): readonly CatalogPackageAffiliation[] {
    return this.affiliations.entries()
  }

  snapshot(): InstalledPackageSnapshot {
    return this.snapshotState
  }

  revision(): number {
    return this.generation
  }

  async ensureModelInventory(): Promise<void> {
    // In-memory inventory is already current.
  }
}

const wireCatalogModels = (snapshot: {
  revision: number
  reconciliationComplete: boolean
  models: readonly unknown[]
}): CatalogModelsResponse => toWireJson(snapshot) as CatalogModelsResponse

const wireDiscoveredModels = (snapshot: {
  revision: bigint
  reconciliationComplete: boolean
  models: readonly unknown[]
}): DiscoveredModelsResponse => toWireJson(snapshot) as DiscoveredModelsResponse

const wireInstallations = (response: {
  operations: readonly unknown[]
}): CatalogInstallationsResponse => toWireJson(response) as CatalogInstallationsResponse

const emptyDownloads = {
  start: async () => ({ download: null }),
  list: async () => ({ downloads: [] as const }),
  cancel: async () => {
    throw new Error("catalog installation downloads are not configured")
  },
  acknowledgeFailure: async () => {
    throw new Error("catalog installation downloads are not configured")
  },
}

const emptyRemover = {
  removeCatalogPackages: async () => 0,
}

export const createServerServices = (options: ServerServicesOptions = {}): ServerServices => {
  const catalog = options.catalog ?? developmentRecommendableCatalog()
  const inventory = options.inventory ?? new InMemoryInventory(mkdtempSync(join(tmpdir(), "icn-inventory-")))
  const resolver = new ModelDomainResolver(inventory, catalog)
  const catalogModels = new ManagedCatalogModels(resolver)
  const discovered = new ManagedDiscoveredModels({
    revision: () => inventory.revision(),
    installedPackageSnapshot: () => inventory.snapshot(),
    installedPackagesResponse: () => ({
      revision: inventory.revision(),
      reconciliationComplete: inventory.installedPackagesResponse().reconciliationComplete,
    }),
    ensureModelInventory: () => inventory.ensureModelInventory(),
  })
  const installations =
    options.installations ??
    new ManagedCatalogInstallations(resolver, emptyDownloads, emptyRemover)

  const instances = new Map<string, ModelInstance>()
  let instanceRevision = 0

  const asModelId = (modelId: string): ModelId => modelId as unknown as ModelId

  return {
    async listCatalogModels() {
      return wireCatalogModels(catalogModels.listCatalog())
    },
    async getCatalogModel(modelId) {
      const snapshot = catalogModels.listCatalog()
      const model = snapshot.models.find((entry) => String(entry.id) === modelId)
      if (model === undefined) {
        return undefined
      }
      return toWireJson(model) as CatalogModel
    },
    async installCatalogModel(modelId) {
      return toWireJson(await installations.install(asModelId(modelId))) as CatalogInstallationAdmission
    },
    async removeCatalogModelInstallation(modelId) {
      return toWireJson(await installations.remove(asModelId(modelId))) as CatalogInstallationRemoval
    },
    async listCatalogInstallations() {
      return wireInstallations(await installations.listCatalogInstallations())
    },
    async getCatalogInstallation(operationId) {
      try {
        return toWireJson(await installations.get(operationId as never)) as CatalogInstallationOperation
      } catch {
        return undefined
      }
    },
    async cancelCatalogInstallation(operationId) {
      return toWireJson(await installations.cancel(operationId as never)) as CatalogInstallationOperation
    },
    async acknowledgeCatalogInstallationFailure(operationId) {
      return toWireJson(
        await installations.acknowledgeFailure(operationId as never),
      ) as CatalogInstallationOperation
    },
    async listDiscoveredModels() {
      return wireDiscoveredModels(discovered.snapshot())
    },
    async refreshDiscovery() {
      return wireDiscoveredModels(await discovered.refreshDiscovery())
    },
    async listModelInstances() {
      return { revision: instanceRevision, instances: [...instances.values()] }
    },
    async getModelInstance(instanceId) {
      return instances.get(instanceId)
    },
    async ensureModelInstance(request) {
      const modelId = String(request.modelId)
      for (const existing of instances.values()) {
        if (String(existing.modelId) === modelId && existing.lifecycle._tag === "Ready") {
          return existing
        }
      }
      instanceRevision += 1
      const id = `inst_${instanceRevision}`
      const instance: ModelInstance = {
        id,
        modelId: request.modelId,
        lifecycle: {
          _tag: "Ready",
          allocation: {
            contextWindowTokens: 4096,
            parallelSequences: 1,
            physicalContextTokens: 4096,
            memoryDomains: [],
          },
        },
      }
      instances.set(id, instance)
      return instance
    },
    async stopModelInstance(instanceId) {
      const current = instances.get(instanceId)
      if (current === undefined) {
        throw new Error(`model instance ${instanceId} was not found`)
      }
      const stopped: ModelInstance = {
        ...current,
        lifecycle: { _tag: "Stopped", reason: { _tag: "UserRequested" } as never },
      }
      // Prefer a simple stopped reason compatible with wire JSON.
      const lifecycle = { _tag: "Stopped" as const, reason: "user" as never }
      const next = { ...current, lifecycle: lifecycle as ModelInstance["lifecycle"] }
      instances.set(instanceId, next)
      instanceRevision += 1
      return next
    },
    async listModelAssessments() {
      return {
        revision: 0,
        state: { _tag: "Preparing" },
      }
    },
    async previewModelLoad(_modelId, _body) {
      return {
        contextWindowTokens: 4096,
        parallelSequences: 1,
        physicalContextTokens: 4096,
        requiredSystemMemoryBytes: 0,
      }
    },
    async searchHuggingFace(request) {
      return toWireJson(await searchHuggingFaceModels(request as never)) as HuggingFaceModelSearchResults
    },
    async resolveHuggingFace(request) {
      return toWireJson(await resolveHuggingFaceRepository(request as never)) as HuggingFaceRepositorySnapshot
    },
    async applyChatTemplate(request) {
      const messages = request.messages
      const lines: string[] = []
      for (const message of messages) {
        const role = "role" in message ? String((message as { role: string }).role) : "user"
        const content = "content" in message ? (message as { content: unknown }).content : ""
        const text =
          typeof content === "string"
            ? content
            : content === null || content === undefined
              ? ""
              : JSON.stringify(content)
        lines.push(`<|im_start|>${role}\n${text}<|im_end|>`)
      }
      lines.push("<|im_start|>assistant\n")
      const prompt = lines.join("\n")
      return {
        additional_stops: ["<|im_end|>"],
        generation_prompt: "<|im_start|>assistant\n",
        grammar: "",
        grammar_lazy: false,
        grammar_triggers: [],
        preserved_tokens: [],
        prompt,
        supports_thinking: false,
        template_fingerprint: "ts-basic-chatml",
        thinking_end_tag: Option.none(),
        thinking_start_tag: Option.none(),
      } as ApplyTemplateResponse
    },
    async modelProperties(modelId, _body) {
      return {
        model_id: modelId,
        properties: {},
      }
    },
    openApiDocument() {
      const openapiPath = fileURLToPath(
        new URL("../../icn-protocol/openapi.json", import.meta.url),
      )
      return JSON.parse(readFileSync(openapiPath, "utf8"))
    },
  }
}

export const createServerServicesFromConfig = async (
  config: ServeConfig,
): Promise<ServerServices> => {
  if (config.modelStore === undefined) {
    return createServerServices()
  }

  const store = await ManagedModelStore.open(
    InventoryConfig.withRoots(
      config.modelStore,
      config.cacheRoot ?? join(config.modelStore, "cache"),
    ),
  )
  store.startBackgroundReconciliation()
  const inventory = new ManagedStoreInventory(store)
  const catalog = developmentRecommendableCatalog()
  const resolver = new ModelDomainResolver(inventory, catalog)
  return createServerServices({
    catalog,
    inventory,
    installations: new ManagedCatalogInstallations(
      resolver,
      ManagedModelDownloads.open(store),
      emptyRemover,
    ),
  })
}
