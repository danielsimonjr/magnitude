import { describe, expect, it } from "vitest"
import { PromptLayout } from "../scheduler/index.js"
import { admitFromQueue, cancellationToken, createAdmissionQueue } from "./queues.js"

describe("admission queue", () => {
  it("drops cancelled head items before sequence acquisition", () => {
    const queue = createAdmissionQueue<{ layout: PromptLayout; promptTokens: number }>()
    const cancelled = cancellationToken()
    cancelled.cancel()
    queue.enqueue({
      id: "a",
      prepared: { layout: PromptLayout.text([]), promptTokens: 0 },
      cancellation: cancelled,
      queuedAtMs: 0,
    })

    const admitted: string[] = []
    admitFromQueue({
      queue,
      acquireSequence: () => ({ id: 0 }),
      onCancelled: (item) => admitted.push(`cancelled:${item.id}`),
      onAdmitted: (item) => admitted.push(`admitted:${item.id}`),
      onReleased: () => {},
    })

    expect(admitted).toEqual(["cancelled:a"])
    expect(queue.isEmpty()).toBe(true)
  })

  it("returns sequence when admission is cancelled after acquire", () => {
    const queue = createAdmissionQueue<{ layout: PromptLayout; promptTokens: number }>()
    const token = cancellationToken()
    queue.enqueue({
      id: "b",
      prepared: { layout: PromptLayout.text([]), promptTokens: 1 },
      cancellation: token,
      queuedAtMs: 0,
    })

    const released: number[] = []
    const originalAcquire = () => {
      token.cancel()
      return { id: 7 }
    }
    admitFromQueue({
      queue,
      acquireSequence: originalAcquire,
      onCancelled: () => {},
      onAdmitted: () => {},
      onReleased: (sequence) => released.push(sequence.id),
    })

    expect(released).toEqual([7])
  })
})
