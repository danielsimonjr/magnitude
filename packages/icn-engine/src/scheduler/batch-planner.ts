import type { BatchWork, WorkCandidate } from "./types.js"

/**
 * Magnitude-owned, policy-light batch assembly.
 *
 * Every runnable decode token is placed before prompt work. Prompt work is then split into
 * rotating round-robin quanta until the logical batch is full.
 */
export class BatchPlanner {
  private cursor = 0

  constructor(private readonly prefillQuantum: number) {
    if (prefillQuantum <= 0) {
      throw new Error("prefill quantum must be positive")
    }
  }

  plan(candidates: readonly WorkCandidate[], capacity: number): BatchWork[] {
    if (candidates.length === 0 || capacity === 0) return []

    let available = capacity
    const result: BatchWork[] = []

    const decodeCandidates = candidates
      .filter((candidate) => candidate.kind.kind === "decode")
      .sort((left, right) => left.sequenceId - right.sequenceId)

    for (const candidate of decodeCandidates) {
      if (available === 0) break
      result.push({ kind: "decode", sequenceId: candidate.sequenceId })
      available -= 1
    }

    const prefillCandidates = candidates.flatMap((candidate) =>
      candidate.kind.kind === "prefill"
        ? [[candidate.sequenceId, candidate.kind.remaining] as const]
        : []
    )
    if (prefillCandidates.length === 0) return result

    const start = this.cursor % prefillCandidates.length
    const prefill = Array.from({ length: prefillCandidates.length }, (_, offset) => {
      const [sequenceId, remaining] = prefillCandidates[(start + offset) % prefillCandidates.length]
      return { sequenceId, remaining }
    })
    this.cursor = (start + 1) % prefillCandidates.length

    while (available > 0) {
      let progressed = false
      for (const entry of prefill) {
        if (available === 0) break
        const tokens = Math.min(entry.remaining, this.prefillQuantum, available)
        if (tokens === 0) continue
        result.push({ kind: "prefill", sequenceId: entry.sequenceId, tokens })
        entry.remaining -= tokens
        available -= tokens
        progressed = true
      }
      if (!progressed) break
    }

    return result
  }
}
