import { cpus, platform } from "node:os"
import { Option, Schema } from "effect"
import {
  ChatCompletionRequest,
  ChatCompletionResponse,
  type HealthResponse,
} from "@magnitudedev/icn-protocol"
import { authorizeBearer, unauthorizedResponse } from "../auth.js"
import { defaultFakeBackend, type FakeBackend } from "../fake-backend.js"
import type { ServerIdentity } from "../config.js"
import { enabledBackends } from "../build-identity.js"
import type { ServerServices } from "../services.js"
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

const notImplemented = (operation: string): Response =>
  json(501, {
    error: {
      type: "api_error",
      code: "not_implemented",
      message: `${operation} is not implemented in the TypeScript ICN server yet`,
      param: null,
    },
  })

const serviceError = (error: unknown): Response => {
  const message = error instanceof Error ? error.message : String(error)
  const notFoundish = /not found/i.test(message)
  return json(notFoundish ? 404 : 400, {
    error: {
      type: notFoundish ? "invalid_request_error" : "api_error",
      code: notFoundish ? "not_found" : "service_error",
      message,
      param: null,
    },
  })
}

const notFound = (message: string): Response =>
  json(404, {
    error: {
      type: "invalid_request_error",
      code: "not_found",
      message,
      param: null,
    },
  })

const decodeChatRequest = Schema.decodeUnknownSync(ChatCompletionRequest)
const encodeChatResponse = Schema.encodeSync(ChatCompletionResponse)

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

  const dispatch = async (request: Request): Promise<Response> => {
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

    if (method === "GET" && pathname === "/api/v1/catalog/installations") {
      return json(200, await state.services.listCatalogInstallations())
    }

    if (method === "GET" && pathname === "/api/v1/instances") {
      return json(200, await state.services.listModelInstances())
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
      const payload = (await request.json()) as { model?: string }
      return json(200, {
        id: "resp_fake",
        object: "response",
        created_at: Math.floor(Date.now() / 1000),
        status: "completed",
        model: payload.model ?? fake.modelId,
        output: [
          {
            type: "message",
            id: "msg_fake",
            role: "assistant",
            content: [{ type: "output_text", text: fake.response }],
          },
        ],
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
      })
    }

    if (method === "GET" && pathname === "/v1/responses") {
      // WebSocket upgrade is negotiated by the Bun server layer; HTTP GET reports readiness.
      return json(200, { object: "websocket.ready", protocol: "openai.responses" })
    }

    if (method === "GET" && pathname === "/openapi.json") {
      return json(200, state.services.openApiDocument())
    }

    if (method === "GET" && pathname === "/api/v1/model-assessments") {
      return json(200, await state.services.listModelAssessments())
    }

    if (method === "POST" && pathname === "/api/v1/discovery/refresh") {
      return json(200, await state.services.refreshDiscovery())
    }

    if (method === "POST" && pathname === "/api/v1/sources/hugging-face/search") {
      const body = await request.json()
      return json(200, await state.services.searchHuggingFace(body as never))
    }

    if (method === "POST" && pathname === "/api/v1/sources/hugging-face/resolve") {
      const body = await request.json()
      return json(200, await state.services.resolveHuggingFace(body as never))
    }

    if (method === "POST" && pathname === "/api/v1/chat/templates/apply") {
      const body = await request.json()
      return json(200, await state.services.applyChatTemplate(body as never))
    }

    if (method === "POST" && pathname === "/api/v1/instances") {
      const body = await request.json()
      return json(200, await state.services.ensureModelInstance(body as never))
    }

    // /api/v1/catalog/models/{id}/install
    {
      const match = pathname.match(/^\/api\/v1\/catalog\/models\/([^/]+)\/install$/)
      if (method === "POST" && match !== null) {
        return json(200, await state.services.installCatalogModel(decodeURIComponent(match[1]!)))
      }
    }

    // /api/v1/catalog/models/{id}/installation
    {
      const match = pathname.match(/^\/api\/v1\/catalog\/models\/([^/]+)\/installation$/)
      if (method === "DELETE" && match !== null) {
        return json(200, await state.services.removeCatalogModelInstallation(decodeURIComponent(match[1]!)))
      }
    }

    // /api/v1/catalog/installations/{operationId}
    {
      const match = pathname.match(/^\/api\/v1\/catalog\/installations\/([^/]+)$/)
      if (method === "GET" && match !== null) {
        const operation = await state.services.getCatalogInstallation(decodeURIComponent(match[1]!))
        if (operation === undefined) {
          return notFound(`catalog installation ${match[1]} was not found`)
        }
        return json(200, operation)
      }
    }

    // /api/v1/catalog/installations/{operationId}/cancel
    {
      const match = pathname.match(/^\/api\/v1\/catalog\/installations\/([^/]+)\/cancel$/)
      if (method === "POST" && match !== null) {
        return json(200, await state.services.cancelCatalogInstallation(decodeURIComponent(match[1]!)))
      }
    }

    // /api/v1/catalog/installations/{operationId}/acknowledge-failure
    {
      const match = pathname.match(/^\/api\/v1\/catalog\/installations\/([^/]+)\/acknowledge-failure$/)
      if (method === "POST" && match !== null) {
        return json(
          200,
          await state.services.acknowledgeCatalogInstallationFailure(decodeURIComponent(match[1]!)),
        )
      }
    }

    // /api/v1/instances/{instanceId}
    {
      const match = pathname.match(/^\/api\/v1\/instances\/([^/]+)$/)
      if (method === "GET" && match !== null) {
        const instance = await state.services.getModelInstance(decodeURIComponent(match[1]!))
        if (instance === undefined) {
          return notFound(`model instance ${match[1]} was not found`)
        }
        return json(200, instance)
      }
    }

    // /api/v1/instances/{instanceId}/stop
    {
      const match = pathname.match(/^\/api\/v1\/instances\/([^/]+)\/stop$/)
      if (method === "POST" && match !== null) {
        return json(200, await state.services.stopModelInstance(decodeURIComponent(match[1]!)))
      }
    }

    // /api/v1/models/{modelId}/load-plan
    {
      const match = pathname.match(/^\/api\/v1\/models\/([^/]+)\/load-plan$/)
      if (method === "POST" && match !== null) {
        const body = await request.json().catch(() => ({}))
        return json(200, await state.services.previewModelLoad(decodeURIComponent(match[1]!), body))
      }
    }

    // /api/v1/models/{modelId}/properties
    {
      const match = pathname.match(/^\/api\/v1\/models\/([^/]+)\/properties$/)
      if (method === "POST" && match !== null) {
        const body = await request.json().catch(() => ({}))
        return json(200, await state.services.modelProperties(decodeURIComponent(match[1]!), body))
      }
    }

    if (method === "GET" && pathname === "/api/v1/events") {
      const encoder = new TextEncoder()
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode(`event: heartbeat\ndata: {}\n\n`))
          controller.close()
        },
      })
      return new Response(stream, {
        status: 200,
        headers: {
          "content-type": "text/event-stream; charset=utf-8",
          "cache-control": "no-cache",
        },
      })
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

  return async (request: Request): Promise<Response> => {
    try {
      return await dispatch(request)
    } catch (error) {
      return serviceError(error)
    }
  }
}

export const memoryReserveForHealth = (): number => abortReserveBytes(observeSystemMemory())
