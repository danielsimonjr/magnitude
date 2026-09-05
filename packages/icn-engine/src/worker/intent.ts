import type { ModelLoadIntent } from "./types.js"

export const parseModelLoadIntent = (intent: unknown): ModelLoadIntent => {
  if (typeof intent !== "object" || intent === null) {
    throw new Error("executionIntent must be an object with modelPath")
  }
  const candidate = intent as Partial<ModelLoadIntent>
  if (typeof candidate.modelPath !== "string" || candidate.modelPath.length === 0) {
    throw new Error("executionIntent.modelPath must be a non-empty string")
  }
  return {
    modelPath: candidate.modelPath,
    nCtx: candidate.nCtx,
    nBatch: candidate.nBatch,
    nThreads: candidate.nThreads,
    nGpuLayers: candidate.nGpuLayers,
  }
}
