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

describe("management routes", () => {
  const services = createServerServices({ catalog: minimalRecommendableCatalog() })
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


  it("covers remaining management routes without 501", async () => {
    const refresh = await handler(
      new Request("http://127.0.0.1/api/v1/discovery/refresh", { method: "POST", headers: authHeaders }),
    )
    expect(refresh.status).toBe(200)

    const assessments = await handler(
      new Request("http://127.0.0.1/api/v1/model-assessments", { headers: authHeaders }),
    )
    expect(assessments.status).toBe(200)

    const openapi = await handler(new Request("http://127.0.0.1/openapi.json", { headers: authHeaders }))
    expect(openapi.status).toBe(200)

    const list = await handler(new Request("http://127.0.0.1/api/v1/catalog/models", { headers: authHeaders }))
    const catalog = Schema.decodeUnknownSync(Schema.parseJson(CatalogModelsResponse))(await list.text())
    const modelId = catalog.models[0]!.id

    const install = await handler(
      new Request(`http://127.0.0.1/api/v1/catalog/models/${encodeURIComponent(modelId)}/install`, {
        method: "POST",
        headers: authHeaders,
      }),
    )
    expect([200, 400, 404, 409]).toContain(install.status)

    const ensure = await handler(
      new Request("http://127.0.0.1/api/v1/instances", {
        method: "POST",
        headers: { ...authHeaders, "content-type": "application/json" },
        body: JSON.stringify({ modelId }),
      }),
    )
    expect(ensure.status).toBe(200)
    const instance = await ensure.json() as { id: string }
    expect(instance.id.length).toBeGreaterThan(0)

    const loadPlan = await handler(
      new Request(`http://127.0.0.1/api/v1/models/${encodeURIComponent(modelId)}/load-plan`, {
        method: "POST",
        headers: { ...authHeaders, "content-type": "application/json" },
        body: "{}",
      }),
    )
    expect(loadPlan.status).toBe(200)

    const template = await handler(
      new Request("http://127.0.0.1/api/v1/chat/templates/apply", {
        method: "POST",
        headers: { ...authHeaders, "content-type": "application/json" },
        body: JSON.stringify({ messages: [{ role: "user", content: "hi" }] }),
      }),
    )
    expect(template.status).toBe(200)

    const responses = await handler(
      new Request("http://127.0.0.1/v1/responses", {
        method: "POST",
        headers: { ...authHeaders, "content-type": "application/json" },
        body: JSON.stringify({ model: "fake" }),
      }),
    )
    expect(responses.status).toBe(200)

    const anthropic = await handler(
      new Request("http://127.0.0.1/anthropic/v1/messages", {
        method: "POST",
        headers: { ...authHeaders, "content-type": "application/json" },
        body: JSON.stringify({ model: "fake", messages: [], max_tokens: 16 }),
      }),
    )
    expect(anthropic.status).toBe(200)

    const hfSearch = await handler(
      new Request("http://127.0.0.1/api/v1/sources/hugging-face/search", {
        method: "POST",
        headers: { ...authHeaders, "content-type": "application/json" },
        body: JSON.stringify({ query: "llama", limit: 1 }),
      }),
    )
    // Network may fail in CI; must not be 501.
    expect([200, 400, 404, 500, 502]).toContain(hfSearch.status)

    const events = await handler(new Request("http://127.0.0.1/api/v1/events", { headers: authHeaders }))
    expect(events.status).toBe(200)
  })

})
