import type { Context } from "@magnitudedev/icn-native"

/**
 * Worker-thread-local native context used by `sampleToken`.
 *
 * The FFI owner thread must call `bindSamplingContext` before sampling and
 * `unbindSamplingContext` before releasing the context.
 */
let boundContext: Context | undefined

export const bindSamplingContext = (ctx: Context): void => {
  boundContext = ctx
}

export const unbindSamplingContext = (): void => {
  boundContext = undefined
}

export const getSamplingContext = (): Context => {
  if (boundContext === undefined) {
    throw new Error(
      "sampleToken requires a worker-bound native context — call bindSamplingContext on the FFI owner thread"
    )
  }
  return boundContext
}
