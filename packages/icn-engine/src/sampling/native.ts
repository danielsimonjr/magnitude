import type { Context } from "@magnitudedev/icn-native"
import { isNativeAvailable, Sampler, wantsStochasticSampling } from "@magnitudedev/icn-native"
import type { CommonSamplerConfig } from "./config.js"

export interface GreedyGenerationResult {
  readonly tokens: readonly number[]
  readonly text: string
}

const samplerCache = new WeakMap<Context, { key: string; sampler: Sampler }>()

const samplerKey = (config: CommonSamplerConfig, nVocab: number): string =>
  [
    nVocab,
    config.seed ?? "",
    config.temperature ?? "",
    config.topP ?? "",
    config.topK ?? "",
    config.penaltyLastN ?? "",
    config.penaltyRepeat ?? "",
    config.penaltyFreq ?? "",
    config.penaltyPresent ?? "",
  ].join("|")

const getOrCreateSampler = (ctx: Context, config: CommonSamplerConfig): Sampler | undefined => {
  if (!isNativeAvailable()) return undefined
  if (
    !wantsStochasticSampling({
      temperature: config.temperature,
      topP: config.topP,
      topK: config.topK,
      penaltyLastN: config.penaltyLastN,
      penaltyRepeat: config.penaltyRepeat,
      penaltyFreq: config.penaltyFreq,
      penaltyPresent: config.penaltyPresent,
    })
  ) {
    return undefined
  }
  const key = samplerKey(config, ctx.model.nVocab)
  const cached = samplerCache.get(ctx)
  if (cached?.key === key) return cached.sampler
  cached?.sampler.free()
  const sampler = Sampler.create({
    nVocab: ctx.model.nVocab,
    topK: config.topK,
    topP: config.topP,
    temperature: config.temperature,
    penaltyLastN: config.penaltyLastN,
    penaltyRepeat: config.penaltyRepeat,
    penaltyFreq: config.penaltyFreq,
    penaltyPresent: config.penaltyPresent,
    seed: config.seed,
  })
  samplerCache.set(ctx, { key, sampler })
  return sampler
}

/**
 * Sample one token from the worker-owned context.
 *
 * Uses a llama.cpp sampler chain (temp / top-k / top-p / penalties) when native
 * bindings are available and the config requests non-greedy sampling; otherwise
 * falls back to greedy argmax.
 */
export const sampleTokenFromContext = (
  ctx: Context,
  config: CommonSamplerConfig,
  batchIndex: number
): number => {
  const idx = batchIndex >= 0 ? batchIndex : -1
  try {
    const sampler = getOrCreateSampler(ctx, config)
    if (sampler !== undefined) {
      return sampler.sample(ctx, idx)
    }
  } catch {
    // Native sampler unavailable or failed — greedy fallback below.
  }
  return ctx.sampleGreedy()
}

/**
 * Greedy generation over an already-decoded context position.
 *
 * Assumes prompt tokens were decoded into `ctx` (or that `ctx` is positioned
 * for the next decode step). Yields each sampled token id; stops at EOG unless
 * `config.ignoreEos` is set.
 */
export async function* generateGreedyTokens(
  ctx: Context,
  model: { isEog(token: number): boolean },
  maxTokens: number,
  config: CommonSamplerConfig
): AsyncGenerator<number> {
  const ignoreEos = config.ignoreEos === true
  for (let i = 0; i < maxTokens; i++) {
    const token = sampleTokenFromContext(ctx, config, -1)
    if (!ignoreEos && model.isEog(token)) break
    yield token
    ctx.decode([token])
    if (ctx.position >= ctx.nCtx) break
    await Promise.resolve()
  }
}
