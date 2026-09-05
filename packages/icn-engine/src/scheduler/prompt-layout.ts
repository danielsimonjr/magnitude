import { LlamaToken } from "../token.js"
import {
  advancePromptBoundary,
  defaultPromptBoundary,
  type PromptBoundary,
  promptBoundary,
} from "./prompt-boundary.js"

export type PromptSegment =
  | { readonly kind: "text"; readonly tokens: readonly LlamaToken[] }
  | {
      readonly kind: "media"
      readonly identity: string
      readonly logicalTokens: number
      readonly nativePositions: number
    }

const segmentLogicalTokens = (segment: PromptSegment): number =>
  segment.kind === "text" ? segment.tokens.length : segment.logicalTokens

const segmentNativePositions = (segment: PromptSegment): number =>
  segment.kind === "text" ? segment.tokens.length : segment.nativePositions

/**
 * Semantic prompt input used to correlate native KV with future requests.
 *
 * Text may be matched token-by-token. Media is an indivisible span identified by content and
 * preprocessing semantics, with logical token and native position counts kept separate for
 * M-RoPE models.
 */
export class PromptLayout {
  private constructor(private readonly segmentList: readonly PromptSegment[]) {}

  static text(tokens: readonly LlamaToken[]): PromptLayout {
    return new PromptLayout([{ kind: "text", tokens: [...tokens] }])
  }

  static new(segments: readonly PromptSegment[]): PromptLayout {
    return new PromptLayout(segments.map((segment) => segment))
  }

  segments(): readonly PromptSegment[] {
    return this.segmentList
  }

  logicalTokens(): number {
    return this.segmentList.reduce((sum, segment) => sum + segmentLogicalTokens(segment), 0)
  }

  textTokens(): LlamaToken[] {
    const tokens: LlamaToken[] = []
    for (const segment of this.segmentList) {
      if (segment.kind === "text") tokens.push(...segment.tokens)
    }
    return tokens
  }

  textTokensAt(logicalToken: number): readonly LlamaToken[] | undefined {
    let start = 0
    for (const segment of this.segmentList) {
      const end = start + segmentLogicalTokens(segment)
      if (logicalToken < end) {
        if (segment.kind === "text") {
          return segment.tokens.slice(logicalToken - start)
        }
        return undefined
      }
      start = end
    }
    return undefined
  }

  mediaAt(logicalToken: number): { logicalTokens: number; nativePositions: number } | undefined {
    let start = 0
    for (const segment of this.segmentList) {
      if (start === logicalToken && segment.kind === "media") {
        return {
          logicalTokens: segment.logicalTokens,
          nativePositions: segment.nativePositions,
        }
      }
      start += segmentLogicalTokens(segment)
    }
    return undefined
  }

  commonPrefix(incoming: PromptLayout): PromptBoundary {
    let boundary = defaultPromptBoundary()
    const left = [...this.segmentList]
    const right = [...incoming.segmentList]

    while (left.length > 0 && right.length > 0) {
      const leftSegment = left.shift()!
      const rightSegment = right.shift()!

      if (leftSegment.kind === "text" && rightSegment.kind === "text") {
        const matched = leftSegment.tokens.findIndex(
          (token, index) =>
            index >= rightSegment.tokens.length || !token.equals(rightSegment.tokens[index])
        )
        const count =
          matched === -1
            ? Math.min(leftSegment.tokens.length, rightSegment.tokens.length)
            : matched
        boundary = {
          logicalTokens: boundary.logicalTokens + count,
          nativePosition: boundary.nativePosition + count,
        }
        if (count !== leftSegment.tokens.length || count !== rightSegment.tokens.length) {
          return boundary
        }
        continue
      }

      if (
        leftSegment.kind === "media" &&
        rightSegment.kind === "media" &&
        leftSegment.identity === rightSegment.identity &&
        leftSegment.logicalTokens === rightSegment.logicalTokens &&
        leftSegment.nativePositions === rightSegment.nativePositions
      ) {
        boundary = {
          logicalTokens: boundary.logicalTokens + leftSegment.logicalTokens,
          nativePosition: boundary.nativePosition + leftSegment.nativePositions,
        }
        continue
      }

      return boundary
    }

    return boundary
  }

  boundaryBeforeFinalTextToken(): PromptBoundary | undefined {
    const logicalTokens = this.logicalTokens()
    if (logicalTokens === 0) return undefined
    return this.boundaryAt(logicalTokens - 1)
  }

  boundaryAt(logicalTokens: number): PromptBoundary | undefined {
    let boundary = defaultPromptBoundary()
    for (const segment of this.segmentList) {
      const segmentTokens = segmentLogicalTokens(segment)
      if (boundary.logicalTokens + segmentTokens <= logicalTokens) {
        boundary = {
          logicalTokens: boundary.logicalTokens + segmentTokens,
          nativePosition: boundary.nativePosition + segmentNativePositions(segment),
        }
        continue
      }
      const within = logicalTokens - boundary.logicalTokens
      if (segment.kind === "text") {
        return {
          logicalTokens: boundary.logicalTokens + within,
          nativePosition: boundary.nativePosition + within,
        }
      }
      return undefined
    }
    return boundary.logicalTokens === logicalTokens ? boundary : undefined
  }

  /**
   * Return the first legal semantic boundary at or after a requested logical position.
   *
   * Text can be split token-by-token. Media cannot, so a position inside a media span advances
   * to the end of that span instead of inventing a partially reusable media boundary.
   */
  boundaryAtOrAfter(logicalTokens: number): PromptBoundary | undefined {
    let boundary = defaultPromptBoundary()
    for (const segment of this.segmentList) {
      const segmentTokens = segmentLogicalTokens(segment)
      const segmentEnd = boundary.logicalTokens + segmentTokens
      if (segmentEnd < logicalTokens) {
        boundary = {
          logicalTokens: segmentEnd,
          nativePosition: boundary.nativePosition + segmentNativePositions(segment),
        }
        continue
      }
      if (logicalTokens <= boundary.logicalTokens) {
        return boundary
      }
      if (segment.kind === "text") {
        const within = logicalTokens - boundary.logicalTokens
        return {
          logicalTokens: boundary.logicalTokens + within,
          nativePosition: boundary.nativePosition + within,
        }
      }
      return {
        logicalTokens: segmentEnd,
        nativePosition: boundary.nativePosition + segmentNativePositions(segment),
      }
    }
    return boundary.logicalTokens === logicalTokens ? boundary : undefined
  }

  prefix(boundary: PromptBoundary): PromptLayout | undefined {
    const at = this.boundaryAt(boundary.logicalTokens)
    if (at === undefined) return undefined
    if (at.logicalTokens !== boundary.logicalTokens || at.nativePosition !== boundary.nativePosition) {
      return undefined
    }

    let remaining = boundary.logicalTokens
    const segments: PromptSegment[] = []
    for (const segment of this.segmentList) {
      if (remaining === 0) break
      const segmentTokens = segmentLogicalTokens(segment)
      if (segmentTokens <= remaining) {
        segments.push(segment)
        remaining -= segmentTokens
      } else if (segment.kind === "text") {
        segments.push({ kind: "text", tokens: segment.tokens.slice(0, remaining) })
        remaining = 0
      } else {
        return undefined
      }
    }
    return remaining === 0 ? PromptLayout.new(segments) : undefined
  }
}

export const promptSegment = {
  text: (tokens: readonly number[] | readonly LlamaToken[]): PromptSegment => ({
    kind: "text",
    tokens: tokens.map((token) => (token instanceof LlamaToken ? token : LlamaToken.new(token))),
  }),
  media: (identity: string, logicalTokens: number, nativePositions: number): PromptSegment => ({
    kind: "media",
    identity,
    logicalTokens,
    nativePositions,
  }),
}

export const multimodalLayout = (
  identity: string,
  before: readonly number[],
  mediaTokens: number,
  mediaPositions: number,
  after: readonly number[]
): PromptLayout =>
  PromptLayout.new([
    promptSegment.text(before),
    promptSegment.media(identity, mediaTokens, mediaPositions),
    promptSegment.text(after),
  ])

export { advancePromptBoundary, promptBoundary }
