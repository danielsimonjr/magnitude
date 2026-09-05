import { describe, expect, it } from "vitest"
import { LlamaToken } from "../token.js"
import { BatchPlanner } from "./batch-planner.js"
import { advancePromptBoundary, promptBoundary, speculativePosition } from "./prompt-boundary.js"
import { multimodalLayout, PromptLayout } from "./prompt-layout.js"
import {
  activateSequence,
  intoAvailableSequence,
  quarantineSequence,
  reusablePrefix,
  SequencePool,
} from "./sequence-pool.js"
import { batchWorkSize } from "./types.js"

describe("prompt boundary", () => {
  it("linked position preserves target and draft coordinate systems", () => {
    const boundary = promptBoundary(4096, 137)
    expect(speculativePosition(boundary)).toEqual({ target: 137, draft: 4096 })
    expect(advancePromptBoundary(boundary, 3)).toEqual(promptBoundary(4099, 140))
  })
})

describe("batch planner", () => {
  it("decode work always precedes prefill", () => {
    const planner = new BatchPlanner(2)
    const plan = planner.plan(
      [
        { sequenceId: 0, kind: { kind: "prefill", remaining: 10 } },
        { sequenceId: 1, kind: { kind: "decode" } },
        { sequenceId: 2, kind: { kind: "prefill", remaining: 10 } },
      ],
      6
    )
    expect(plan[0]).toEqual({ kind: "decode", sequenceId: 1 })
    expect(plan.reduce((sum, work) => sum + batchWorkSize(work), 0)).toBe(6)
  })

  it("prompt quanta are fair and fill the batch", () => {
    const planner = new BatchPlanner(2)
    const candidates = [
      { sequenceId: 0, kind: { kind: "prefill" as const, remaining: 100 } },
      { sequenceId: 1, kind: { kind: "prefill" as const, remaining: 100 } },
    ]
    const first = planner.plan(candidates, 6)
    const second = planner.plan(candidates, 6)

    expect(first.reduce((sum, work) => sum + batchWorkSize(work), 0)).toBe(6)
    expect(second.reduce((sum, work) => sum + batchWorkSize(work), 0)).toBe(6)
    expect(first[0]).toEqual({ kind: "prefill", sequenceId: 0, tokens: 2 })
    expect(second[0]).toEqual({ kind: "prefill", sequenceId: 1, tokens: 2 })

    const allocated = (plan: ReturnType<BatchPlanner["plan"]>, sequenceId: number) =>
      plan
        .filter((work) => work.kind === "prefill" && work.sequenceId === sequenceId)
        .reduce((sum, work) => sum + (work.kind === "prefill" ? work.tokens : 0), 0)

    expect(Math.abs(allocated(first, 0) - allocated(first, 1))).toBeLessThanOrEqual(2)
    expect(Math.abs(allocated(second, 0) - allocated(second, 1))).toBeLessThanOrEqual(2)
  })

  it("decode order is stable when every sequence fits", () => {
    const planner = new BatchPlanner(2)
    const candidates = [
      { sequenceId: 2, kind: { kind: "decode" as const } },
      { sequenceId: 0, kind: { kind: "decode" as const } },
      { sequenceId: 1, kind: { kind: "decode" as const } },
    ]
    const expected = [
      { kind: "decode", sequenceId: 0 },
      { kind: "decode", sequenceId: 1 },
      { kind: "decode", sequenceId: 2 },
    ]
    expect(planner.plan(candidates, 3)).toEqual(expected)
    expect(planner.plan(candidates, 3)).toEqual(expected)
  })
})

describe("sequence pool", () => {
  it("sequence ownership is isolated and reused only after release", () => {
    const pool = new SequencePool(2)
    const first = pool.acquire()
    const second = pool.acquire()
    expect(first).toBeDefined()
    expect(second).toBeDefined()
    expect(first!.id).not.toBe(second!.id)
    expect(pool.acquire()).toBeUndefined()

    const firstId = first!.id
    pool.release(first!)
    expect(pool.acquire()?.id).toBe(firstId)
    expect(pool.acquire()).toBeUndefined()
  })

  it("failed cleanup quarantines only the affected sequence", () => {
    const pool = new SequencePool(2)
    const quarantined = activateSequence(pool.acquire()!)
    const survivor = pool.acquire()!
    quarantineSequence(quarantined)

    expect(pool.acquire()).toBeUndefined()
    const survivorId = survivor.id
    pool.release(survivor)
    expect(pool.acquire()?.id).toBe(survivorId)
    expect(pool.acquire()).toBeUndefined()
  })

  it("returning an unmodified available sequence preserves its reusable prefix", () => {
    const pool = new SequencePool(2)
    const available = pool.acquire()!
    const sequenceId = available.id
    const active = activateSequence(available)
    pool.release(
      intoAvailableSequence(
        active,
        reusablePrefix(PromptLayout.text([LlamaToken.new(7)]))
      )
    )
    const returned = pool.acquire()!
    expect(returned.id).toBe(sequenceId)
    pool.release(returned)
    const prefix = pool.acquire()!.reusablePrefix
    expect(prefix?.layout.textTokens()).toEqual([LlamaToken.new(7)])
    expect(prefix?.checkpoints).toEqual([])
  })

  it("matching cache is selected independently of free order", () => {
    const pool = new SequencePool(2)
    const first = pool.acquire()!
    const firstId = first.id
    const second = pool.acquire()!
    pool.release(
      intoAvailableSequence(
        activateSequence(first),
        reusablePrefix(PromptLayout.text([LlamaToken.new(1), LlamaToken.new(2)]))
      )
    )
    pool.release(
      intoAvailableSequence(
        activateSequence(second),
        reusablePrefix(PromptLayout.text([LlamaToken.new(7), LlamaToken.new(8)]))
      )
    )

    const acquired = pool.acquireMatching(
      PromptLayout.text([LlamaToken.new(1), LlamaToken.new(9)])
    )
    expect(acquired?.id).toBe(firstId)
  })

  it("weak cache match uses an empty lru sequence", () => {
    const pool = new SequencePool(2)
    const cached = pool.acquire()!
    const cachedId = cached.id
    pool.release(
      intoAvailableSequence(
        activateSequence(cached),
        reusablePrefix(PromptLayout.text([LlamaToken.new(1)]))
      )
    )

    const acquired = pool.acquireMatching(
      PromptLayout.text(Array.from({ length: 11 }, (_, index) => LlamaToken.new(index + 1)))
    )
    expect(acquired?.id).not.toBe(cachedId)
    expect(acquired?.reusablePrefix).toBeUndefined()
  })

  it("cache match must strictly exceed similarity threshold", () => {
    const pool = new SequencePool(2)
    const cached = pool.acquire()!
    const cachedId = cached.id
    pool.release(
      intoAvailableSequence(
        activateSequence(cached),
        reusablePrefix(PromptLayout.text([LlamaToken.new(1)]))
      )
    )

    const acquired = pool.acquireMatching(
      PromptLayout.text(Array.from({ length: 10 }, (_, index) => LlamaToken.new(index + 1)))
    )
    expect(acquired?.id).not.toBe(cachedId)
    expect(acquired?.reusablePrefix).toBeUndefined()
  })

  it("qualifying cache match wins over an empty lru sequence", () => {
    const pool = new SequencePool(2)
    const cached = pool.acquire()!
    const cachedId = cached.id
    pool.release(
      intoAvailableSequence(
        activateSequence(cached),
        reusablePrefix(PromptLayout.text([LlamaToken.new(1)]))
      )
    )

    const acquired = pool.acquireMatching(
      PromptLayout.text(Array.from({ length: 9 }, (_, index) => LlamaToken.new(index + 1)))
    )
    expect(acquired?.id).toBe(cachedId)
  })

  it("missing qualifying match uses least recently used cached sequence", () => {
    const pool = new SequencePool(2)
    const oldest = pool.acquire()!
    const oldestId = oldest.id
    const newest = pool.acquire()!
    pool.release(
      intoAvailableSequence(
        activateSequence(oldest),
        reusablePrefix(PromptLayout.text([LlamaToken.new(1)]))
      )
    )
    pool.release(
      intoAvailableSequence(
        activateSequence(newest),
        reusablePrefix(PromptLayout.text([LlamaToken.new(2)]))
      )
    )

    const acquired = pool.acquireMatching(
      PromptLayout.text(Array.from({ length: 11 }, () => LlamaToken.new(3)))
    )
    expect(acquired?.id).toBe(oldestId)
  })

  it("context reset invalidates available reusable prefixes", () => {
    const pool = new SequencePool(1)
    pool.release(
      intoAvailableSequence(
        activateSequence(pool.acquire()!),
        reusablePrefix(PromptLayout.text([LlamaToken.new(7)]))
      )
    )
    pool.invalidateReuse()
    expect(pool.acquire()?.reusablePrefix).toBeUndefined()
  })
})

describe("prompt layout", () => {
  it("multimodal prefix matches identical media and tracks mrope positions", () => {
    const cached = multimodalLayout("image-a", [1, 2], 576, 1, [3, 4])
    const incoming = multimodalLayout("image-a", [1, 2], 576, 1, [3, 9])

    const boundary = cached.commonPrefix(incoming)
    expect(boundary).toEqual(promptBoundary(2 + 576 + 1, 2 + 1 + 1))
    expect(speculativePosition(boundary)).toEqual({ target: 4, draft: 579 })
  })

  it("multimodal prefix stops before changed media", () => {
    const cached = multimodalLayout("image-a", [1, 2], 64, 64, [3])
    const incoming = multimodalLayout("image-b", [1, 2], 64, 64, [3])
    expect(cached.commonPrefix(incoming)).toEqual(promptBoundary(2, 2))
  })

  it("media cannot be split by a cache boundary", () => {
    const layout = multimodalLayout("image-a", [1], 64, 1, [2])
    expect(layout.boundaryAt(32)).toBeUndefined()
    expect(layout.prefix(promptBoundary(32, 32))).toBeUndefined()
  })

  it("checkpoint inside media advances to the next semantic boundary", () => {
    const layout = multimodalLayout("image-a", [1, 2], 512, 32, [3, 4])
    expect(layout.boundaryAtOrAfter(128)).toEqual(promptBoundary(514, 34))
    expect(layout.boundaryAtOrAfter(515)).toEqual(promptBoundary(515, 35))
  })

  it("retained partial text prefix matches longer text segment", () => {
    const complete = PromptLayout.text([
      LlamaToken.new(1),
      LlamaToken.new(2),
      LlamaToken.new(3),
    ])
    const boundary = complete.boundaryAt(2)
    expect(boundary).toBeDefined()
    const retained = complete.prefix(boundary!)
    expect(retained?.commonPrefix(complete)).toEqual(boundary)
  })
})
