import type { Context } from "@magnitudedev/icn-native"
import type { CommonSamplerConfig } from "./config.js"

export interface GreedyGenerationResult {
  readonly tokens: readonly number[]
  readonly text: string
}

/**
 * Sample one token from the worker-owned context.
 *
 * Only greedy decoding is wired today. `temperature`, `topP`, grammars, and
 * reasoning budgets require the native sampler-chain FFI surface (not yet
 * exposed by `@magnitudedev/icn-native`).
 */
export const sampleTokenFromContext = (
  ctx: Context,
  _config: CommonSamplerConfig,
  _batchIndex: number
): number => {
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
