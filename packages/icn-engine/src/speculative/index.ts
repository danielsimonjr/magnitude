import type { ExecutionIntent, SpeculativeDecodingConfig } from "@magnitudedev/icn-contracts"

export type SpeculativePreflightError =
  | { readonly _tag: "InvalidExecution"; readonly message: string }
  | { readonly _tag: "Incompatible"; readonly message: string }

/**
 * Validate the exact speculative configuration already selected by the servable bundle.
 *
 * Disabled intent remains disabled. Enabled intent is returned unchanged only after the native
 * target/draft context and selected llama.cpp speculative implementation can be constructed.
 *
 * Hardware-gated: requires `@magnitudedev/icn-native` speculative preflight FFI.
 */
export const preflightSpeculative = async (
  plan: ExecutionIntent
): Promise<SpeculativeDecodingConfig | SpeculativePreflightError> => {
  if (plan.speculative.type === "disabled") {
    return plan.speculative
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
