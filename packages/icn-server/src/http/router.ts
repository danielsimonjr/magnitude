import { cpus, platform } from "node:os"
import { Option, Schema } from "effect"
import {
  ChatCompletionRequest,
  ChatCompletionResponse,
  type CatalogModelsResponse,
  type DiscoveredModelsResponse,
  type HealthResponse,
} from "@magnitudedev/icn-protocol"
import { authorizeBearer, unauthorizedResponse } from "../auth.js"
import { defaultFakeBackend, type FakeBackend } from "../fake-backend.js"
import type { ServerIdentity } from "../config.js"
import { enabledBackends } from "../build-identity.js"
import {
  abortReserveBytes,
  observeSystemMemory,
  systemMemoryThresholds,
} from "@magnitudedev/icn-hardware"

const json = (status: number, body: unknown, headers?: HeadersInit): Response =>
  new Response(JSON.stringify(body), {
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

const decodeChatRequest = Schema.decodeUnknownSync(ChatCompletionRequest)
const encodeChatResponse = Schema.encodeSync(ChatCompletionResponse)

export interface HttpRouterState {
  readonly identity: ServerIdentity
  readonly authorization?: string
  readonly fakeBackend?: FakeBackend
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
      const body: CatalogModelsResponse = {
        revision: 0,
        reconciliationComplete: true,
        models: [],
      }
      return json(200, body)
    }

    if (method === "GET" && pathname === "/api/v1/discovery/models") {
      const body: DiscoveredModelsResponse = {
        revision: 0,
        reconciliationComplete: true,
        models: [],
      }
      return json(200, body)
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
      if (!state.fakeBackend) {
        return notImplemented("anthropic messages")
      }
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
      return notImplemented("openai responses")
    }

    if (method === "GET" && pathname === "/v1/responses") {
      return notImplemented("openai responses websocket")
    }

    if (pathname.startsWith("/api/v1/catalog/")) {
      return notImplemented("catalog management")
    }
    if (pathname.startsWith("/api/v1/instances")) {
      return notImplemented("model instances")
    }
    if (pathname.startsWith("/api/v1/models/")) {
      return notImplemented("model management")
    }
    if (pathname.startsWith("/api/v1/sources/hugging-face/")) {
      return notImplemented("hugging face sources")
    }
    if (pathname.startsWith("/api/v1/discovery/")) {
      return notImplemented("discovery refresh")
    }
    if (pathname.startsWith("/api/v1/chat/templates/")) {
      return notImplemented("chat templates")
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
