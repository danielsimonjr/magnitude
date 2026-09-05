import type {
  ModelInstance,
  ModelInstanceId,
  ModelInstancesSnapshot,
  ModelLoadPlan,
} from "@magnitudedev/icn-protocol"
import { WorkerSupervisor, type ManagedWorker } from "./worker/index.js"

const defaultAllocation = {
  contextWindowTokens: 4096,
  parallelSequences: 1,
  physicalContextTokens: 4096,
  memoryDomains: [
    {
      memoryDomainId: "system",
      modelBytes: 0,
      contextBytes: 0,
      computeBytes: 0,
      auxiliaryBytes: 0,
    },
  ],
}

const defaultLoadPlan = (): ModelLoadPlan => ({
  contextWindowTokens: 4096,
  parallelSequences: 1,
  physicalContextTokens: 4096,
  requiredSystemMemoryBytes: 0,
})

export class InMemoryInstanceManager {
  private revision = 0
  private readonly instances = new Map<string, ModelInstance>()
  private readonly workers = new Map<string, ManagedWorker>()
  private readonly supervisor: WorkerSupervisor

  constructor(supervisor?: WorkerSupervisor) {
    this.supervisor = supervisor ?? new WorkerSupervisor()
  }

  snapshot(): ModelInstancesSnapshot {
    return {
      revision: this.revision,
      instances: [...this.instances.values()],
    }
  }

  get(instanceId: string): ModelInstance | undefined {
    return this.instances.get(instanceId)
  }

  previewLoad(_modelId: string): ModelLoadPlan {
    return defaultLoadPlan()
  }

  ensure(modelId: string): ModelInstance {
    for (const existing of this.instances.values()) {
      if (
        existing.modelId === modelId &&
        existing.lifecycle._tag !== "Failed" &&
        existing.lifecycle._tag !== "Stopped"
      ) {
        return existing
      }
    }
    const id = `inst_${this.revision + 1}_${Date.now()}` as ModelInstanceId
    const instance: ModelInstance = {
      id,
      modelId,
      lifecycle: {
        _tag: "Ready",
        allocation: defaultAllocation,
      },
    }
    this.instances.set(id, instance)
    this.revision += 1
    this.trySpawnWorker(id)
    return instance
  }

  stop(instanceId: string): boolean {
    const existing = this.instances.get(instanceId)
    if (existing === undefined) {
      return false
    }
    const worker = this.workers.get(instanceId)
    if (worker !== undefined) {
      worker.terminate("stopped", "instance stop requested")
      this.workers.delete(instanceId)
    }
    this.instances.set(instanceId, {
      ...existing,
      lifecycle: {
        _tag: "Stopped",
        reason: "user_stop",
      },
    })
    this.revision += 1
    return true
  }

  private trySpawnWorker(instanceId: string): void {
    try {
      const worker = this.supervisor.spawn({
        executable: process.execPath,
        args: ["-e", "setInterval(() => {}, 1 << 30)"],
        role: "inference",
      })
      this.workers.set(instanceId, worker)
    } catch {
      // Worker spawn is best-effort in the TypeScript server.
    }
  }
}
