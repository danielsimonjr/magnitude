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
})
