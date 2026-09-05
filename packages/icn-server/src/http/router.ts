import { cpus, platform } from "node:os"
import { Option, Schema } from "effect"
import {
  ApplyTemplateRequest,
  ChatCompletionRequest,
  ChatCompletionResponse,
  EnsureModelInstanceRequest,
  HuggingFaceModelSearchRequest,
  HuggingFaceRepositoryRequest,
  type HealthResponse,
} from "@magnitudedev/icn-protocol"
import { authorizeBearer, unauthorizedResponse } from "../auth.js"
import { defaultFakeBackend, type FakeBackend } from "../fake-backend.js"
import type { ServerIdentity } from "../config.js"
import { enabledBackends } from "../build-identity.js"
import { mapServiceError, type ServerServices } from "../services.js"
import {
  abortReserveBytes,
  observeSystemMemory,
  systemMemoryThresholds,
} from "@magnitudedev/icn-hardware"

const json = (status: number, body: unknown, headers?: HeadersInit): Response =>
  new Response(JSON.stringify(body, (_key, value) => (typeof value === "bigint" ? Number(value) : value)), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      ...headers,
    },
  })

const notFound = (message: string): Response =>
  json(404, {
    error: {
      type: "invalid_request_error",
      code: "not_found",
      message,
      param: null,
    },
  })

const serviceErrorResponse = (error: unknown): Response => {
  const mapped = mapServiceError(error)
  return json(mapped.status, {
    error: {
      type: mapped.status === 404 ? "invalid_request_error" : "api_error",
      code: mapped.status === 404 ? "not_found" : "server_error",
      message: mapped.message,
      param: null,
    },
  })
}

const decodeChatRequest = Schema.decodeUnknownSync(ChatCompletionRequest)
const encodeChatResponse = Schema.encodeSync(ChatCompletionResponse)
const decodeEnsureInstance = Schema.decodeUnknownSync(EnsureModelInstanceRequest)
const decodeHfSearch = Schema.decodeUnknownSync(HuggingFaceModelSearchRequest)
const decodeHfResolve = Schema.decodeUnknownSync(HuggingFaceRepositoryRequest)
const decodeApplyTemplate = Schema.decodeUnknownSync(ApplyTemplateRequest)

const KNOWN_EVENT_TOPICS = new Set([
  "hardware",
  "catalog",
  "discovery",
  "model-assessments",
  "catalog-installations",
  "instances",
])

const matchSuffix = (pathname: string, prefix: string, suffix: string): string | undefined => {
  if (!pathname.startsWith(prefix) || !pathname.endsWith(suffix)) {
    return undefined
  }
  const middle = pathname.slice(prefix.length, pathname.length - suffix.length)
  if (middle.length === 0) {
    return undefined
  }
  return decodeURIComponent(middle)
}

export interface HttpRouterState {
  readonly identity: ServerIdentity
  readonly authorization?: string
  readonly fakeBackend?: FakeBackend
  readonly services: ServerServices
}

export const createHttpHandler = (state: HttpRouterState) => {
  const fake = state.fakeBackend ?? defaultFakeBackend()

  const requireAuth = (request: Request): Response | undefined => {
    if (authorizeBearer(state.authorization, request.headers.get("authorization"))) {
      return undefined
    }
    return unauthorizedResponse()
  }

  const hardwareSnapshot = () => {
    const sample = observeSystemMemory()
    const thresholds = systemMemoryThresholds(sample.physicalCapacityBytes)
    return {
      architecture: process.arch,
      captured_at: Math.floor(Date.now() / 1000),
      cpu_model: cpus()[0]?.model ?? null,
      enabled_backends: [...enabledBackends()],
      logical_cores: cpus().length,
      memory_domains: [
        {
          id: "system",
          kind: "system",
          shares_system_memory: true,
          stable_capacity_bytes: sample.physicalCapacityBytes,
          total_capacity_bytes: sample.physicalCapacityBytes,
          current_free_bytes: sample.physicalAvailableBytes,
          devices: [
            {
              id: "cpu:0",
              backend: "cpu",
              description: cpus()[0]?.model ?? "CPU",
              kind: "cpu",
              name: "CPU",
              native_index: 0,
              physical_id: null,
              memory_limit: null,
            },
          ],
        },
      ],
      native_build: state.identity.nativeBuild,
      platform: platform(),
      system_memory: {
        abort_reserve_bytes: thresholds.abortReserveBytes,
        allocation_capacity_bytes: sample.allocationCapacityBytes,
        allocation_headroom_bytes: sample.allocationHeadroomBytes,
        assess_reserve_bytes: thresholds.assessReserveBytes,
        physical_available_bytes: sample.physicalAvailableBytes,
        physical_capacity_bytes: sample.physicalCapacityBytes,
      },
      system_product_name: null,
      topology_fingerprint: `ts-${sample.physicalCapacityBytes}`,
    }
  }

  return async (request: Request): Promise<Response> => {
    const url = new URL(request.url)
    const { pathname } = url
    const method = request.method.toUpperCase()

    if (method === "GET" && pathname === "/health") {
      const body: HealthResponse = {
        status: "ok",
        ready: true,
        version: "0.0.1",
        apiVersion: state.identity.apiVersion,
        instanceId: state.identity.instanceId,
        nativeBuild: state.identity.nativeBuild,
      }
      return json(200, body)
    }

    const authFailure = requireAuth(request)
    if (authFailure !== undefined) return authFailure

    try {
      if (method === "GET" && pathname === "/openapi.json") {
        return json(200, await state.services.openapiDocument())
      }

      if (method === "GET" && pathname === "/api/v1/hardware") {
        return json(200, hardwareSnapshot())
      }

      if (method === "GET" && pathname === "/v1/models") {
        const body = {
          object: "list",
          data: [fake.modelsListEntry()],
        }
        return json(200, body)
      }

      if (method === "GET" && pathname === "/api/v1/catalog/models") {
        return json(200, await state.services.listCatalogModels())
      }

      if (method === "POST" && pathname.endsWith("/install") && pathname.startsWith("/api/v1/catalog/models/")) {
        const modelId = matchSuffix(pathname, "/api/v1/catalog/models/", "/install")
        if (modelId === undefined) {
          return notFound(`catalog model install path was not found`)
        }
        return json(200, await state.services.installCatalogModel(modelId))
      }

      if (
        method === "DELETE" &&
        pathname.endsWith("/installation") &&
        pathname.startsWith("/api/v1/catalog/models/")
      ) {
        const modelId = matchSuffix(pathname, "/api/v1/catalog/models/", "/installation")
        if (modelId === undefined) {
          return notFound(`catalog model installation path was not found`)
        }
        return json(200, await state.services.removeCatalogInstallation(modelId))
      }

      if (method === "GET" && pathname.startsWith("/api/v1/catalog/models/")) {
        const modelId = decodeURIComponent(pathname.slice("/api/v1/catalog/models/".length))
        if (modelId.includes("/")) {
          return notFound(`catalog model ${modelId} was not found`)
        }
        const model = await state.services.getCatalogModel(modelId)
        if (model === undefined) {
          return notFound(`catalog model ${modelId} was not found`)
        }
        return json(200, model)
      }

      if (method === "GET" && pathname === "/api/v1/discovery/models") {
        return json(200, await state.services.listDiscoveredModels())
      }

      if (method === "POST" && pathname === "/api/v1/discovery/refresh") {
        return json(200, await state.services.refreshDiscovery())
      }

      if (method === "GET" && pathname === "/api/v1/catalog/installations") {
        return json(200, await state.services.listCatalogInstallations())
      }

      if (
        method === "POST" &&
        pathname.endsWith("/cancel") &&
        pathname.startsWith("/api/v1/catalog/installations/")
      ) {
        const operationId = matchSuffix(pathname, "/api/v1/catalog/installations/", "/cancel")
        if (operationId === undefined) {
          return notFound("catalog installation cancel path was not found")
        }
        return json(200, await state.services.cancelCatalogInstallation(operationId))
      }

      if (
        method === "POST" &&
        pathname.endsWith("/acknowledge-failure") &&
        pathname.startsWith("/api/v1/catalog/installations/")
      ) {
        const operationId = matchSuffix(
          pathname,
          "/api/v1/catalog/installations/",
          "/acknowledge-failure",
        )
        if (operationId === undefined) {
          return notFound("catalog installation acknowledge path was not found")
        }
        return json(200, await state.services.acknowledgeCatalogInstallationFailure(operationId))
      }

      if (method === "GET" && pathname.startsWith("/api/v1/catalog/installations/")) {
        const operationId = decodeURIComponent(
          pathname.slice("/api/v1/catalog/installations/".length),
        )
        if (operationId.includes("/")) {
          return notFound(`catalog installation ${operationId} was not found`)
        }
        return json(200, await state.services.getCatalogInstallation(operationId))
      }

      if (method === "GET" && pathname === "/api/v1/model-assessments") {
        return json(200, await state.services.modelAssessments())
      }

      if (method === "POST" && pathname.endsWith("/load-plan") && pathname.startsWith("/api/v1/models/")) {
        const modelId = matchSuffix(pathname, "/api/v1/models/", "/load-plan")
        if (modelId === undefined) {
          return notFound("model load-plan path was not found")
        }
        return json(200, await state.services.previewLoadPlan(modelId))
      }

      if (method === "POST" && pathname.endsWith("/properties") && pathname.startsWith("/api/v1/models/")) {
        const modelId = matchSuffix(pathname, "/api/v1/models/", "/properties")
        if (modelId === undefined) {
          return notFound("model properties path was not found")
        }
        return json(200, await state.services.modelProperties(modelId))
      }

      if (method === "GET" && pathname === "/api/v1/instances") {
        return json(200, await state.services.listModelInstances())
      }

      if (method === "POST" && pathname === "/api/v1/instances") {
        const payload = await request.json()
        const body = decodeEnsureInstance(payload)
        return json(200, await state.services.ensureInstance(String(body.modelId)))
      }

      if (method === "POST" && pathname.endsWith("/stop") && pathname.startsWith("/api/v1/instances/")) {
        const instanceId = matchSuffix(pathname, "/api/v1/instances/", "/stop")
        if (instanceId === undefined) {
          return notFound("instance stop path was not found")
        }
        const stopped = await state.services.stopInstance(instanceId)
        if (!stopped) {
          return notFound(`model instance ${instanceId} was not found`)
        }
        return new Response(null, { status: 204 })
      }

      if (method === "GET" && pathname.startsWith("/api/v1/instances/")) {
        const instanceId = decodeURIComponent(pathname.slice("/api/v1/instances/".length))
        if (instanceId.includes("/")) {
          return notFound(`model instance ${instanceId} was not found`)
        }
        const instance = await state.services.getInstance(instanceId)
        if (instance === undefined) {
          return notFound(`model instance ${instanceId} was not found`)
        }
        return json(200, instance)
      }

      if (method === "GET" && pathname === "/api/v1/events") {
        const topicsParam = url.searchParams.get("topics")
        let topics: string[] | undefined
        if (topicsParam !== null) {
          topics = topicsParam
            .split(",")
            .map((topic) => topic.trim())
            .filter((topic) => topic.length > 0)
          if (topics.length === 0) {
            return json(400, {
              error: {
                type: "invalid_request_error",
                code: "invalid_request",
                message: "topics must name at least one resource",
                param: "topics",
              },
            })
          }
          for (const topic of topics) {
            if (!KNOWN_EVENT_TOPICS.has(topic)) {
              return json(400, {
                error: {
                  type: "invalid_request_error",
                  code: "invalid_request",
                  message: `unknown inference resource topic: ${topic}`,
                  param: "topics",
                },
              })
            }
          }
        }
        const events = state.services.listEvents(topics)
        return new Response(
          new ReadableStream({
            async start(controller) {
              const encoder = new TextEncoder()
              for await (const event of events) {
                controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`))
              }
              controller.close()
            },
          }),
          {
            status: 200,
            headers: {
              "content-type": "text/event-stream; charset=utf-8",
              "cache-control": "no-cache",
            },
          },
        )
      }

      if (method === "POST" && pathname === "/api/v1/sources/hugging-face/search") {
        const payload = await request.json()
        return json(200, await state.services.searchHuggingFace(decodeHfSearch(payload)))
      }

      if (method === "POST" && pathname === "/api/v1/sources/hugging-face/resolve") {
        const payload = await request.json()
        return json(200, await state.services.resolveHuggingFace(decodeHfResolve(payload)))
      }

      if (method === "POST" && pathname === "/api/v1/chat/templates/apply") {
        const payload = await request.json()
        return json(200, await state.services.applyChatTemplate(decodeApplyTemplate(payload)))
      }

      if (method === "POST" && pathname === "/v1/chat/completions") {
        const payload = await request.json()
        const chatRequest = decodeChatRequest(payload)
        if (!fake.acceptsModel(chatRequest.model)) {
          return json(404, {
            error: {
              type: "invalid_request_error",
              code: "model_not_found",
              message: `model ${chatRequest.model} is not available`,
              param: null,
            },
          })
        }
        if (Option.getOrElse(chatRequest.stream, () => false)) {
          const events = fake.streamEvents(chatRequest)
          return new Response(
            new ReadableStream({
              start(controller) {
                const encoder = new TextEncoder()
                for (const event of events) {
                  controller.enqueue(encoder.encode(event))
                }
                controller.close()
              },
            }),
            {
              status: 200,
              headers: {
                "content-type": "text/event-stream; charset=utf-8",
                "cache-control": "no-cache",
              },
            },
          )
        }
        return json(200, encodeChatResponse(fake.complete(chatRequest)))
      }

      if (method === "POST" && pathname === "/anthropic/v1/messages") {
        return json(200, {
          id: "msg_fake",
          type: "message",
          role: "assistant",
          model: fake.modelId,
          content: [{ type: "text", text: fake.response }],
          stop_reason: "end_turn",
          stop_sequence: null,
          usage: { input_tokens: 1, output_tokens: 1 },
        })
      }

      if (method === "POST" && pathname === "/anthropic/v1/messages/count_tokens") {
        return json(200, { input_tokens: 1 })
      }

      if (method === "POST" && pathname === "/v1/responses") {
        const payload = await request.json().catch(() => ({}))
        return json(200, await state.services.responses(payload))
      }

      if (method === "GET" && pathname === "/v1/responses") {
        return json(400, {
          error: {
            type: "invalid_request_error",
            code: "websocket_required",
            message: "GET /v1/responses requires a WebSocket upgrade",
            param: null,
          },
        })
      }
    } catch (error) {
      return serviceErrorResponse(error)
    }

    return json(404, {
      error: {
        type: "invalid_request_error",
        code: "not_found",
        message: `${method} ${pathname} was not found`,
        param: null,
      },
    })
  }
}

export const memoryReserveForHealth = (): number => abortReserveBytes(observeSystemMemory())
