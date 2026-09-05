import { describe, expect, it } from "vitest"
import { Schema } from "effect"
import {
  CatalogInstallationsResponse,
  CatalogModelsResponse,
  DiscoveredModelsResponse,
  ModelInstancesSnapshot,
} from "@magnitudedev/icn-protocol"
import { createHttpHandler } from "./http/router.js"
import { createServerServices } from "./services.js"
import { minimalRecommendableCatalog } from "./test-catalog.js"

const testIdentity = {
  instanceId: "test",
  apiVersion: 1,
  nativeBuild: "test-build",
}

const authHeaders = { authorization: "Bearer test-token" }

const jsonPost = (path: string, body: unknown) =>
  new Request(`http://127.0.0.1${path}`, {
    method: "POST",
    headers: { ...authHeaders, "content-type": "application/json" },
    body: JSON.stringify(body),
  })

describe("management routes", () => {
  const services = createServerServices({
    catalog: minimalRecommendableCatalog(),
    hub: {
      fetch: async (input) => {
        const url = String(input)
        const commit = "c".repeat(40)
        if (url.includes("/api/models?")) {
          return new Response(
            JSON.stringify([
              {
                id: "owner/model-gguf",
                sha: commit,
                downloads: 3,
                likes: 1,
                gated: false,
                private: false,
                tags: ["gguf"],
              },
            ]),
            { status: 200 },
          )
        }
        if (url.includes("/api/models/owner/model-gguf/revision/")) {
          return new Response(
            JSON.stringify({
              id: "owner/model-gguf",
              sha: commit,
              siblings: [
                {
                  rfilename: "model.gguf",
                  size: 11,
                  lfs: { sha256: "d".repeat(64), size: 11 },
                },
              ],
            }),
            { status: 200 },
          )
        }
        return new Response("missing", { status: 404 })
      },
    },
  })
  const handler = createHttpHandler({
    identity: testIdentity,
    authorization: "test-token",
    services,
  })

  it("lists catalog models from authored catalog", async () => {
    const response = await handler(new Request("http://127.0.0.1/api/v1/catalog/models", { headers: authHeaders }))
    expect(response.status).toBe(200)
    const body = Schema.decodeUnknownSync(Schema.parseJson(CatalogModelsResponse))(await response.text())
    expect(body.reconciliationComplete).toBe(true)
    expect(body.models.length).toBeGreaterThan(0)
    expect(body.models[0]?.displayName.length).toBeGreaterThan(0)
    expect(body.models[0]?.localState._tag).toBe("NotInstalled")
  })

  it("gets one catalog model by id", async () => {
    const list = await handler(new Request("http://127.0.0.1/api/v1/catalog/models", { headers: authHeaders }))
    const catalog = Schema.decodeUnknownSync(Schema.parseJson(CatalogModelsResponse))(await list.text())
    const modelId = catalog.models[0]!.id
    const response = await handler(
      new Request(`http://127.0.0.1/api/v1/catalog/models/${encodeURIComponent(modelId)}`, {
        headers: authHeaders,
      }),
    )
    expect(response.status).toBe(200)
    const body = await response.json() as { id: string }
    expect(body.id).toBe(modelId)
  })

  it("returns discovery and installation snapshots", async () => {
    const discovery = await handler(
      new Request("http://127.0.0.1/api/v1/discovery/models", { headers: authHeaders }),
    )
    expect(discovery.status).toBe(200)
    const discoveryBody = Schema.decodeUnknownSync(Schema.parseJson(DiscoveredModelsResponse))(
      await discovery.text(),
    )
    expect(discoveryBody.reconciliationComplete).toBe(true)
    expect(discoveryBody.models).toEqual([])

    const installations = await handler(
      new Request("http://127.0.0.1/api/v1/catalog/installations", { headers: authHeaders }),
    )
    expect(installations.status).toBe(200)
    const installationsBody = Schema.decodeUnknownSync(Schema.parseJson(CatalogInstallationsResponse))(
      await installations.text(),
    )
    expect(installationsBody.operations).toEqual([])

    const instances = await handler(
      new Request("http://127.0.0.1/api/v1/instances", { headers: authHeaders }),
    )
    expect(instances.status).toBe(200)
    const instancesBody = Schema.decodeUnknownSync(Schema.parseJson(ModelInstancesSnapshot))(
      await instances.text(),
    )
    expect(instancesBody.instances).toEqual([])
  })

  it("keeps /health open and protects catalog routes", async () => {
    const health = await handler(new Request("http://127.0.0.1/health"))
    expect(health.status).toBe(200)

    const unauthorized = await handler(new Request("http://127.0.0.1/api/v1/catalog/models"))
    expect(unauthorized.status).toBe(401)
  })

  it("implements former 501 management routes without 501", async () => {
    const list = await handler(new Request("http://127.0.0.1/api/v1/catalog/models", { headers: authHeaders }))
    const catalog = Schema.decodeUnknownSync(Schema.parseJson(CatalogModelsResponse))(await list.text())
    const modelId = catalog.models[0]!.id

    const checks: Array<[string, Request]> = [
      ["install", jsonPost(`/api/v1/catalog/models/${encodeURIComponent(modelId)}/install`, {})],
      [
        "remove installation",
        new Request(`http://127.0.0.1/api/v1/catalog/models/${encodeURIComponent(modelId)}/installation`, {
          method: "DELETE",
          headers: authHeaders,
        }),
      ],
      [
        "get installation",
        new Request("http://127.0.0.1/api/v1/catalog/installations/missing-op", { headers: authHeaders }),
      ],
      ["cancel installation", jsonPost("/api/v1/catalog/installations/missing-op/cancel", {})],
      [
        "acknowledge failure",
        jsonPost("/api/v1/catalog/installations/missing-op/acknowledge-failure", {}),
      ],
      ["refresh discovery", jsonPost("/api/v1/discovery/refresh", {})],
      [
        "model assessments",
        new Request("http://127.0.0.1/api/v1/model-assessments", { headers: authHeaders }),
      ],
      ["load plan", jsonPost(`/api/v1/models/${encodeURIComponent(modelId)}/load-plan`, {})],
      ["properties", jsonPost(`/api/v1/models/${encodeURIComponent(modelId)}/properties`, {})],
      ["ensure instance", jsonPost("/api/v1/instances", { modelId })],
      ["hf search", jsonPost("/api/v1/sources/hugging-face/search", { query: "model", limit: 5 })],
      [
        "hf resolve",
        jsonPost("/api/v1/sources/hugging-face/resolve", {
          repository: "owner/model-gguf",
          revision: "main",
        }),
      ],
      [
        "apply template",
        jsonPost("/api/v1/chat/templates/apply", {
          model: modelId,
          messages: [{ role: "user", content: "hi" }],
        }),
      ],
      ["responses post", jsonPost("/v1/responses", { model: "icn-fake", input: "hello" })],
      ["responses get", new Request("http://127.0.0.1/v1/responses", { headers: authHeaders })],
      ["openapi", new Request("http://127.0.0.1/openapi.json", { headers: authHeaders })],
      ["events", new Request("http://127.0.0.1/api/v1/events", { headers: authHeaders })],
      ["anthropic messages", jsonPost("/anthropic/v1/messages", { model: "icn-fake", messages: [] })],
    ]

    for (const [label, request] of checks) {
      const response = await handler(request)
      expect(response.status, label).not.toBe(501)
      expect(response.status, label).toBeLessThan(600)
    }

    // Follow-up instance get/stop after ensure
    const ensured = await handler(jsonPost("/api/v1/instances", { modelId }))
    expect(ensured.status).toBe(200)
    const instance = (await ensured.json()) as { id: string }
    const got = await handler(
      new Request(`http://127.0.0.1/api/v1/instances/${encodeURIComponent(instance.id)}`, {
        headers: authHeaders,
      }),
    )
    expect(got.status).not.toBe(501)
    expect(got.status).toBe(200)

    const stopped = await handler(jsonPost(`/api/v1/instances/${encodeURIComponent(instance.id)}/stop`, {}))
    expect(stopped.status).not.toBe(501)
    expect(stopped.status).toBe(204)
  })
})
