/** Linked target-native / draft-sequential coordinates for speculative execution. */
export interface SpeculativePosition {
  readonly target: number
  readonly draft: number
}

export type WorkKind =
  | { readonly kind: "decode" }
  | { readonly kind: "prefill"; readonly remaining: number }

export interface WorkCandidate {
  readonly sequenceId: number
  readonly kind: WorkKind
}

export type BatchWork =
  | { readonly kind: "decode"; readonly sequenceId: number }
  | { readonly kind: "prefill"; readonly sequenceId: number; readonly tokens: number }

export const batchWorkSize = (work: BatchWork): number =>
  work.kind === "decode" ? 1 : work.tokens
