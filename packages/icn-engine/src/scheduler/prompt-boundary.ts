import type { SpeculativePosition } from "./types.js"

/** Logical token and native KV position at a committed semantic boundary. */
export interface PromptBoundary {
  readonly logicalTokens: number
  readonly nativePosition: number
}

export const defaultPromptBoundary = (): PromptBoundary => ({
  logicalTokens: 0,
  nativePosition: 0,
})

export const promptBoundary = (logicalTokens: number, nativePosition: number): PromptBoundary => ({
  logicalTokens,
  nativePosition,
})

export const speculativePosition = (boundary: PromptBoundary): SpeculativePosition | undefined => {
  if (boundary.logicalTokens > 0x7fff_ffff) return undefined
  return {
    target: boundary.nativePosition,
    draft: boundary.logicalTokens,
  }
}

export const advancePromptBoundary = (
  boundary: PromptBoundary,
  tokens: number
): PromptBoundary | undefined => {
  const logicalTokens = boundary.logicalTokens + tokens
  if (logicalTokens < boundary.logicalTokens) return undefined
  const nativePosition = boundary.nativePosition + tokens
  if (nativePosition < boundary.nativePosition) return undefined
  return { logicalTokens, nativePosition }
}
