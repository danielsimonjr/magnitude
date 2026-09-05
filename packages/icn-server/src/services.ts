import { readFileSync, mkdtempSync } from "node:fs"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { Option } from "effect"
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
  HuggingFaceModelSearchRequest,
  HuggingFaceModelSearchResults,
  HuggingFaceRepositoryRequest,
  HuggingFaceRepositorySnapshot,
  ModelAssessmentsSnapshot,
  ModelInstance,
  ModelInstancesSnapshot,
  ModelLoadPlan,
  PropsResponse,
  ResponseObject,
} from "@magnitudedev/icn-protocol"
import {
  inventoryErrorMessage,
  ModelId,
  ModelIdError,
  type CatalogPackageAffiliation,
  type InventoryError,
  type RecommendableModelCatalog,
} from "@magnitudedev/icn-contracts"
import {
  CatalogAffiliations,
  InventoryConfig,
  ManagedCatalogInstallations,
  ManagedCatalogModels,
  ManagedDiscoveredModels,
  ManagedModelDownloads,
  ManagedModelStore,
  ModelDomainResolver,
  resolveHuggingFaceRepository,
  searchHuggingFaceModels,
  type HuggingFaceHubOptions,
  type InstalledPackageSnapshot,
  type ModelDownloadsService,
} from "@magnitudedev/icn-models"
import { developmentRecommendableCatalog } from "./catalog-development.js"
import type { ServeConfig } from "./config.js"
import { InMemoryInstanceManager } from "./instances.js"
import { ManagedStoreInventory, type InventoryPort } from "./inventory-port.js"
import { toWireJson } from "./wire.js"

const require = createRequire(import.meta.url)

export interface ServerServices {
  listCatalogModels(): Promise<CatalogModelsResponse>
  getCatalogModel(modelId: string): Promise<CatalogModel | undefined>
  installCatalogModel(modelId: string): Promise<CatalogInstallationAdmission>
  removeCatalogInstallation(modelId: string): Promise<CatalogInstallationRemoval>
  listCatalogInstallations(): Promise<CatalogInstallationsResponse>
  getCatalogInstallation(operationId: string): Promise<CatalogInstallationOperation>
  cancelCatalogInstallation(operationId: string): Promise<CatalogInstallationOperation>
  acknowledgeCatalogInstallationFailure(operationId: string): Promise<CatalogInstallationOperation>
  listDiscoveredModels(): Promise<DiscoveredModelsResponse>
  refreshDiscovery(): Promise<DiscoveredModelsResponse>
  searchHuggingFace(request: HuggingFaceModelSearchRequest): Promise<HuggingFaceModelSearchResults>
  resolveHuggingFace(request: HuggingFaceRepositoryRequest): Promise<HuggingFaceRepositorySnapshot>
  modelAssessments(): Promise<ModelAssessmentsSnapshot>
  previewLoadPlan(modelId: string): Promise<ModelLoadPlan>
  listModelInstances(): Promise<ModelInstancesSnapshot>
  ensureInstance(modelId: string): Promise<ModelInstance>
  getInstance(instanceId: string): Promise<ModelInstance | undefined>
  stopInstance(instanceId: string): Promise<boolean>
  listEvents(topics: ReadonlyArray<string> | undefined): AsyncIterable<unknown>
  applyChatTemplate(request: ApplyTemplateRequest): Promise<ApplyTemplateResponse>
  modelProperties(modelId: string): Promise<PropsResponse>
  responses(body: unknown): Promise<ResponseObject>
  openapiDocument(): Promise<unknown>
}

export interface ServerServicesOptions {
  readonly catalog?: RecommendableModelCatalog
  readonly inventory?: InventoryPort & {
    ensureInstalledModelInventory?(): Promise<void>
    ensureModelInventory?(): Promise<void>
  }
  readonly installations?: ManagedCatalogInstallations
  readonly hub?: HuggingFaceHubOptions
  readonly instances?: InMemoryInstanceManager
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

  async ensureInstalledModelInventory(): Promise<void> {
    this.generation += 1
  }

  async ensureModelInventory(): Promise<void> {
    this.generation += 1
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

/** Preserve snake_case HF wire keys while unwrapping Effect Options / bigints. */
const wireHubJson = (value: unknown): unknown => {
  if (typeof value === "bigint") {
    return Number(value)
  }
  if (Array.isArray(value)) {
    return value.map(wireHubJson)
  }
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>
    if (record._tag === "Some" && "value" in record) {
      return wireHubJson(record.value)
    }
    if (record._tag === "None") {
      return undefined
    }
    return Object.fromEntries(
      Object.entries(record)
        .map(([key, nested]) => [key, wireHubJson(nested)] as const)
        .filter(([, nested]) => nested !== undefined),
    )
  }
  return value
}

const emptyDownloads: ModelDownloadsService = {
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

const isInventoryError = (error: unknown): error is InventoryError =>
  typeof error === "object" &&
  error !== null &&
  "_tag" in error &&
  typeof (error as { _tag: unknown })._tag === "string"

export const mapServiceError = (error: unknown): { status: number; message: string } => {
  if (isInventoryError(error)) {
    const message = inventoryErrorMessage(error)
    switch (error._tag) {
      case "NotFound":
        return { status: 404, message }
      case "InvalidRequest":
      case "InvalidId":
        return { status: 400, message }
      case "Busy":
      case "Loaded":
      case "ModelOperation":
      case "ConcurrentMutation":
        return { status: 409, message }
      case "Integrity":
        return { status: 422, message }
      default:
        return { status: 500, message }
    }
  }
  if (error instanceof Error) {
    return { status: 500, message: error.message }
  }
  return { status: 500, message: String(error) }
}

const parseModelId = (modelId: string): ModelId => {
  const parsed = ModelId.fromString(modelId)
  if (parsed instanceof ModelIdError) {
    throw { _tag: "InvalidRequest", message: parsed.message } satisfies InventoryError
  }
  return parsed
}

const messageText = (content: unknown): string => {
  if (typeof content === "string") {
    return content
  }
  if (Option.isOption(content)) {
    return String(Option.getOrElse(content, () => ""))
  }
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "object" && part !== null && "text" in part) {
          return String((part as { text: unknown }).text)
        }
        return ""
      })
      .join("")
  }
  return ""
}

const minimalApplyTemplate = (request: ApplyTemplateRequest): ApplyTemplateResponse => {
  const prompt = request.messages
    .map((message) => {
      const role = "role" in message ? String(message.role) : "user"
      const content =
        "content" in message ? messageText((message as { content: unknown }).content) : ""
      return `${role}: ${content}`
    })
    .join("\n")
  return {
    prompt,
    generation_prompt: "assistant:",
    additional_stops: [],
    grammar: "",
    grammar_lazy: false,
    grammar_triggers: [],
    preserved_tokens: [],
    supports_thinking: false,
    template_fingerprint: "ts-minimal",
    thinking_end_tag: Option.none(),
    thinking_start_tag: Option.none(),
  }
}

const defaultExecutionSettings = () => ({
  cache_type_k: "f16" as const,
  cache_type_v: "f16" as const,
  flash_attention: "auto" as const,
  gpu_layers: { mode: "auto" as const },
  kv_unified: true,
  offload_kqv: true,
  operation_offload: false,
  split_mode: "layer" as const,
  swa_full: false,
  tensor_split: Option.none(),
  threads: Option.none(),
  threads_batch: Option.none(),
  use_mlock: false,
  use_mmap: true,
})

const defaultProps = (modelId: string): PropsResponse => ({
  build_info: "icn-server-ts",
  chat_template: "",
  default_generation_settings: { n_ctx: 4096 },
  execution: {
    requested: defaultExecutionSettings(),
    resolved: defaultExecutionSettings(),
  },
  general_architecture: Option.some("unknown"),
  general_name: Option.some(modelId),
  modalities: { audio: false, video: false, vision: false },
  model_path: modelId,
  model_size_bytes: 0,
  reasoning: {
    default_reasoning_effort: Option.none(),
    reasoning_efforts: [],
  },
  sliding_window_tokens: -1,
  template_capabilities: {
    enable_thinking: false,
    object_arguments: false,
    parallel_tool_calls: false,
    preserve_reasoning: false,
    string_content: true,
    system_role: true,
    tool_calls: false,
    tools: false,
    typed_content: false,
  },
  template_fingerprint: "ts-minimal",
  training_context_tokens: 4096,
})

const fakeResponseObject = (body: unknown): ResponseObject => {
  const record = (body ?? {}) as Record<string, unknown>
  const model = typeof record.model === "string" ? record.model : "icn-fake"
  const inputText =
    typeof record.input === "string"
      ? record.input
      : Array.isArray(record.input)
        ? JSON.stringify(record.input)
        : ""
  return {
    id: `resp_fake_${Date.now()}`,
    object: "response",
    created_at: Math.floor(Date.now() / 1000),
    status: "completed",
    model,
    output: [
      {
        type: "message",
        id: `msg_fake_${Date.now()}`,
        role: "assistant",
        status: "completed",
        content: [
          {
            type: "output_text",
            text: `Hello from ICN responses (${inputText.length} chars).`,
            annotations: [],
          },
        ],
      },
    ],
    error: Option.none(),
    incomplete_details: Option.none(),
    instructions: Option.fromNullable(
      typeof record.instructions === "string" ? record.instructions : null,
    ),
    max_output_tokens: Option.none(),
    metadata: {},
    parallel_tool_calls: false,
    previous_response_id: Option.none(),
    reasoning: { effort: Option.none(), summary: Option.none() },
    store: false,
    temperature: Option.none(),
    text: {
      format: {
        type: "text",
        name: Option.none(),
        schema: Option.none(),
        strict: Option.none(),
      },
    },
    tool_choice: "auto",
    tools: [],
    top_p: Option.none(),
    truncation: "disabled",
    usage: {
      input_tokens: Math.max(1, inputText.length),
      output_tokens: 1,
      total_tokens: Math.max(2, inputText.length + 1),
      input_tokens_details: { cached_tokens: 0 },
      output_tokens_details: { reasoning_tokens: 0 },
    },
  } as unknown as ResponseObject
}

const loadOpenApiDocument = (): unknown => {
  try {
    const packageJson = require.resolve("@magnitudedev/icn-protocol/package.json")
    return JSON.parse(readFileSync(join(dirname(packageJson), "openapi.json"), "utf8"))
  } catch {
    return {
      openapi: "3.1.0",
      info: { title: "Magnitude Inference Control Node", version: "0.0.1" },
      paths: {},
    }
  }
}

export const createServerServices = (options: ServerServicesOptions = {}): ServerServices => {
  const catalog = options.catalog ?? developmentRecommendableCatalog()
  const inventory =
    options.inventory ?? new InMemoryInventory(mkdtempSync(join(tmpdir(), "icn-inventory-")))
  const resolver = new ModelDomainResolver(inventory, catalog)
  const catalogModels = new ManagedCatalogModels(resolver)
  const discovered = new ManagedDiscoveredModels({
    revision: () => inventory.revision(),
    installedPackageSnapshot: () => inventory.snapshot(),
    installedPackagesResponse: () => ({
      revision: inventory.revision(),
      reconciliationComplete: inventory.installedPackagesResponse().reconciliationComplete,
    }),
    ensureModelInventory: async () => {
      if (inventory.ensureInstalledModelInventory !== undefined) {
        await inventory.ensureInstalledModelInventory()
        return
      }
      if (inventory.ensureModelInventory !== undefined) {
        await inventory.ensureModelInventory()
      }
    },
  })
  const installations =
    options.installations ??
    new ManagedCatalogInstallations(resolver, emptyDownloads, emptyRemover)
  const instances = options.instances ?? new InMemoryInstanceManager()
  const hub = options.hub ?? {}
  const openapi = loadOpenApiDocument()

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
      return toWireJson(await installations.install(parseModelId(modelId))) as CatalogInstallationAdmission
    },
    async removeCatalogInstallation(modelId) {
      return toWireJson(await installations.remove(parseModelId(modelId))) as CatalogInstallationRemoval
    },
    async listDiscoveredModels() {
      return wireDiscoveredModels(discovered.snapshot())
    },
    async refreshDiscovery() {
      return wireDiscoveredModels(await discovered.refreshDiscovery())
    },
    async listCatalogInstallations() {
      return wireInstallations(await installations.listCatalogInstallations())
    },
    async getCatalogInstallation(operationId) {
      return toWireJson(await installations.get(operationId as never)) as CatalogInstallationOperation
    },
    async cancelCatalogInstallation(operationId) {
      return toWireJson(await installations.cancel(operationId as never)) as CatalogInstallationOperation
    },
    async acknowledgeCatalogInstallationFailure(operationId) {
      return toWireJson(
        await installations.acknowledgeFailure(operationId as never),
      ) as CatalogInstallationOperation
    },
    async searchHuggingFace(request) {
      const result = await searchHuggingFaceModels(request, hub)
      return wireHubJson(result) as HuggingFaceModelSearchResults
    },
    async resolveHuggingFace(request) {
      const result = await resolveHuggingFaceRepository(request, hub)
      return wireHubJson(result) as HuggingFaceRepositorySnapshot
    },
    async modelAssessments() {
      return {
        revision: 0,
        state: { _tag: "Preparing" },
      }
    },
    async previewLoadPlan(modelId) {
      return instances.previewLoad(modelId)
    },
    async listModelInstances() {
      return instances.snapshot()
    },
    async ensureInstance(modelId) {
      return instances.ensure(modelId)
    },
    async getInstance(instanceId) {
      return instances.get(instanceId)
    },
    async stopInstance(instanceId) {
      return instances.stop(instanceId)
    },
    async *listEvents(topics) {
      const selected = topics ?? [
        "hardware",
        "catalog",
        "discovery",
        "model-assessments",
        "catalog-installations",
        "instances",
      ]
      for (const topic of selected) {
        yield { topic, revision: inventory.revision() }
      }
    },
    async applyChatTemplate(request) {
      try {
        const engine = await import("@magnitudedev/icn-engine")
        if (typeof engine.inspectTemplate === "function") {
          try {
            await engine.inspectTemplate()
          } catch {
            // Native template inspection is not wired; fall back to minimal apply.
          }
        }
      } catch {
        // Engine may be unavailable in constrained environments.
      }
      return toWireJson(minimalApplyTemplate(request)) as ApplyTemplateResponse
    },
    async modelProperties(modelId) {
      return toWireJson(defaultProps(modelId)) as PropsResponse
    },
    async responses(body) {
      return toWireJson(fakeResponseObject(body)) as ResponseObject
    },
    async openapiDocument() {
      return openapi
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
    inventory: Object.assign(inventory, {
      ensureInstalledModelInventory: store.ensureInstalledModelInventory.bind(store),
      ensureModelInventory: store.ensureModelInventory.bind(store),
    }),
    installations: new ManagedCatalogInstallations(
      resolver,
      ManagedModelDownloads.open(store),
      emptyRemover,
    ),
  })
}
