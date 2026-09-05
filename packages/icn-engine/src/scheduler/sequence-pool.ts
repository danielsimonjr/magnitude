import type { PromptBoundary } from "./prompt-boundary.js"
import { PromptLayout } from "./prompt-layout.js"

/** Opaque native sequence state placeholder — actual KV lives in llama.cpp. */
export type NativeSequenceState = { readonly _tag: "native" }

/** Linked target/draft checkpoint for speculative prompt reuse. */
export type PromptCheckpointState =
  | { readonly kind: "target"; readonly state: NativeSequenceState }
  | { readonly kind: "speculative"; readonly state: unknown }

export interface PromptCheckpoint {
  readonly state: PromptCheckpointState
  readonly boundary: PromptBoundary
}

export interface ReusablePrefix {
  readonly layout: PromptLayout
  readonly checkpoints: readonly PromptCheckpoint[]
}

export interface AvailableSequence {
  readonly id: number
  readonly reusablePrefix: ReusablePrefix | undefined
}

export interface ActiveSequence {
  readonly id: number
}

export const SLOT_PROMPT_SIMILARITY_THRESHOLD = 0.1

export class SequencePool {
  private readonly available: AvailableSequence[]

  constructor(count: number) {
    this.available = Array.from({ length: count }, (_, value) => ({
      id: value,
      reusablePrefix: undefined,
    }))
  }

  acquire(): AvailableSequence | undefined {
    return this.available.shift()
  }

  isEmpty(): boolean {
    return this.available.length === 0
  }

  acquireMatching(prompt: PromptLayout): AvailableSequence | undefined {
    const promptTokens = prompt.logicalTokens()
    if (promptTokens === 0) {
      return this.available.pop()
    }

    let bestIndex: number | undefined
    let bestPrefix = -1
    for (let index = 0; index < this.available.length; index += 1) {
      const sequence = this.available[index]
      const prefix = sequence.reusablePrefix
      if (prefix === undefined) continue
      const commonPrefix = prefix.layout.commonPrefix(prompt).logicalTokens
      const similarity = commonPrefix / promptTokens
      if (similarity > SLOT_PROMPT_SIMILARITY_THRESHOLD && commonPrefix > bestPrefix) {
        bestIndex = index
        bestPrefix = commonPrefix
      }
    }

    if (bestIndex === undefined) {
      return this.available.pop()
    }
    const [sequence] = this.available.splice(bestIndex, 1)
    return sequence
  }

  release(sequence: AvailableSequence): void {
    this.available.unshift(sequence)
  }

  /** Native context reset erases KV for available sequences as well as active ones. */
  invalidateReuse(): void {
    for (let index = 0; index < this.available.length; index += 1) {
      this.available[index] = {
        ...this.available[index],
        reusablePrefix: undefined,
      }
    }
  }
}

export const activateSequence = (available: AvailableSequence): ActiveSequence => ({
  id: available.id,
})

export const intoAvailableSequence = (
  active: ActiveSequence,
  reusablePrefix: ReusablePrefix | undefined
): AvailableSequence => ({
  id: active.id,
  reusablePrefix,
})

/** Consume capacity whose native state could not be made safe for another request. */
export const quarantineSequence = (_active: ActiveSequence): void => {}

export const reusablePrefix = (
  layout: PromptLayout,
  checkpoints: readonly PromptCheckpoint[] = []
): ReusablePrefix => ({
  layout,
  checkpoints,
})
