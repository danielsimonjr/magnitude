import { existsSync } from "node:fs"
import { Context, isNativeAvailable, Model } from "@magnitudedev/icn-native"
import { sampleTokenFromContext, type CommonSamplerConfig } from "@magnitudedev/icn-engine/sampling"

export interface GreedyDeterminismResult {
  readonly prompt: string
  readonly maxTokens: number
  readonly first: readonly number[]
  readonly second: readonly number[]
  readonly identical: boolean
}

const greedyConfig = (): CommonSamplerConfig => ({
  seed: 0,
  ignoreEos: undefined,
  topK: undefined,
  topP: undefined,
  temperature: 0,
  penaltyLastN: undefined,
  penaltyRepeat: undefined,
  penaltyFreq: undefined,
  penaltyPresent: undefined,
  grammar: undefined,
  grammarLazy: undefined,
  grammarTriggers: undefined,
  preservedTokens: undefined,
  generationPrompt: undefined,
  reasoningBudget: undefined,
})

/** True when native libs resolve and `MAGNITUDE_TEST_GGUF` points at a readable file. */
export const nativeParityAvailable = (
  env: Readonly<Record<string, string | undefined>> = process.env
): boolean => {
  const gguf = env.MAGNITUDE_TEST_GGUF?.trim()
  if (!gguf || !existsSync(gguf)) return false
  return isNativeAvailable()
}

/**
 * CPU greedy determinism harness: load a GGUF, decode a prompt twice after reset,
 * and compare token sequences from `sampleTokenFromContext`.
 */
export const greedyDeterminismHarness = async (options: {
  readonly modelPath: string
  readonly prompt?: string
  readonly maxTokens?: number
  readonly nCtx?: number
}): Promise<GreedyDeterminismResult> => {
  const prompt = options.prompt ?? "Hello"
  const maxTokens = options.maxTokens ?? 8
  const model = Model.load(options.modelPath, { nGpuLayers: 0 })
  const ctx = new Context(model, { nCtx: options.nCtx ?? 256, nBatch: 64, nThreads: 2 })
  const config = greedyConfig()

  const runOnce = (): number[] => {
    ctx.reset()
    const tokens = model.tokenize(prompt)
    ctx.decode(tokens)
    const out: number[] = []
    for (let i = 0; i < maxTokens; i++) {
      const token = sampleTokenFromContext(ctx, config, -1)
      if (model.isEog(token)) break
      out.push(token)
      ctx.decode([token])
      if (ctx.position >= ctx.nCtx) break
    }
    return out
  }

  try {
    const first = runOnce()
    const second = runOnce()
    return {
      prompt,
      maxTokens,
      first,
      second,
      identical: first.length === second.length && first.every((t, i) => t === second[i]),
    }
  } finally {
    ctx.free()
    model.free()
  }
}
