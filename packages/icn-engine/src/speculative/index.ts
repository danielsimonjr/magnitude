import type {
  ExecutionIntent,
  SpeculativeDecodingConfig,
  SpeculativeMethodConfig,
} from "@magnitudedev/icn-contracts"
import { isNativeAvailable } from "@magnitudedev/icn-native"

export type SpeculativePreflightError =
  | { readonly _tag: "InvalidExecution"; readonly message: string }
  | { readonly _tag: "Incompatible"; readonly message: string }
  | { readonly _tag: "NativeUnavailable"; readonly message: string }

const validateMethodThreshold = (
  method: SpeculativeMethodConfig
): SpeculativePreflightError | undefined => {
  const threshold = (() => {
    switch (method.method) {
      case "mtp":
        return method.min_draft_probability
      case "dflash":
        return method.min_sample_probability
      case "dspark":
        return method.acceptance_threshold
    }
  })()
  if (!Number.isFinite(threshold) || threshold < 0 || threshold > 1) {
    return {
      _tag: "InvalidExecution",
      message: `speculative method ${method.method} threshold must be a finite number in [0, 1]; got ${threshold}`,
    }
  }
  return undefined
}

/**
 * Pure validation of an enabled speculative plan (no native construction).
 *
 * Checks n_max/n_min ordering, method thresholds, and separate draft paths.
 */
export const validateSpeculativeConfig = (
  speculative: SpeculativeDecodingConfig
): SpeculativePreflightError | undefined => {
  if (speculative.type === "disabled") return undefined
  if (speculative.n_max < speculative.n_min) {
    return {
      _tag: "InvalidExecution",
      message: `speculative n_max (${speculative.n_max}) must be >= n_min (${speculative.n_min})`,
    }
  }
  if (speculative.n_min < 1) {
    return {
      _tag: "InvalidExecution",
      message: `speculative n_min must be >= 1; got ${speculative.n_min}`,
    }
  }
  const thresholdError = validateMethodThreshold(speculative.method)
  if (thresholdError !== undefined) return thresholdError
  if (speculative.source.type === "separate") {
    const path = speculative.source.model_path.trim()
    if (path.length === 0) {
      return {
        _tag: "InvalidExecution",
        message: "separate speculative draft source requires a non-empty model_path",
      }
    }
  }
  return undefined
}

/**
 * Validate the exact speculative configuration already selected by the servable bundle.
 *
 * Disabled intent remains disabled. Enabled intent is validated in pure TypeScript
 * then rejected with a typed error until native speculative preflight FFI lands.
 */
export const preflightSpeculative = async (
  plan: ExecutionIntent
): Promise<SpeculativeDecodingConfig | SpeculativePreflightError> => {
  if (plan.speculative.type === "disabled") {
    return plan.speculative
  }
  const validation = validateSpeculativeConfig(plan.speculative)
  if (validation !== undefined) return validation
  if (!isNativeAvailable()) {
    return {
      _tag: "NativeUnavailable",
      message:
        "native speculative preflight requires @magnitudedev/icn-native libraries; build with bun run build:native",
    }
  }
  return {
    _tag: "Incompatible",
    message:
      "native speculative preflight is not yet wired — requires icn-native speculative FFI",
  }
}

/**
 * Hardware-gated: linked target/draft speculative verification for one batch.
 */
export const verifySpeculativeBatch = async (): Promise<never> => {
  throw new Error(
    "verifySpeculativeBatch requires native speculative integration — not yet wired"
  )
}

/**
 * Hardware-gated: draft token proposal for one decode step.
 */
export const draftSpeculativeTokens = async (): Promise<never> => {
  throw new Error(
    "draftSpeculativeTokens requires native speculative integration — not yet wired"
  )
}
