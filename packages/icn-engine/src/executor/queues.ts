import type { PromptLayout } from "../scheduler/index.js"

/** Bounded command queue capacity from the Rust executor. */
export const COMMAND_QUEUE_CAPACITY = 32

/** Brief poll when no decode work is available. */
export const IDLE_POLL_INTERVAL_MS = 1

/** Coalesce admission when the executor is idle with queued work. */
export const IDLE_ADMISSION_COALESCE_INTERVAL_MS = 1

export type ExecutorFailureReason =
  | "cancelled"
  | "executor_stopped"
  | "backend"
  | "validation"

export interface CancellationToken {
  readonly cancelled: boolean
  cancel(): void
}

export const cancellationToken = (): CancellationToken => {
  let cancelled = false
  return {
    get cancelled() {
      return cancelled
    },
    cancel() {
      cancelled = true
    },
  }
}

export interface QueuedCompletion<TPrepared> {
  readonly id: string
  readonly prepared: TPrepared
  readonly cancellation: CancellationToken
  readonly queuedAtMs: number
}

export interface AdmissionQueue<TPrepared> {
  readonly items: readonly QueuedCompletion<TPrepared>[]
}

export const createAdmissionQueue = <TPrepared>(): {
  queue: QueuedCompletion<TPrepared>[]
  enqueue(item: QueuedCompletion<TPrepared>): void
  drainCancelled(onCancelled: (item: QueuedCompletion<TPrepared>) => void): void
  popFront(): QueuedCompletion<TPrepared> | undefined
  peekFront(): QueuedCompletion<TPrepared> | undefined
  isEmpty(): boolean
} => {
  const queue: QueuedCompletion<TPrepared>[] = []
  return {
    queue,
    enqueue(item) {
      if (queue.length >= COMMAND_QUEUE_CAPACITY) {
        throw new Error("admission queue is full")
      }
      queue.push(item)
    },
    drainCancelled(onCancelled) {
      while (queue.length > 0 && queue[0].cancellation.cancelled) {
        onCancelled(queue.shift()!)
      }
    },
    popFront() {
      return queue.shift()
    },
    peekFront() {
      return queue[0]
    },
    isEmpty() {
      return queue.length === 0
    },
  }
}

export interface PreparedPromptInput {
  readonly layout: PromptLayout
  readonly promptTokens: number
}

/**
 * CPU-verifiable admission gate: checks cancellation before sequence acquisition.
 *
 * Native mutation happens only after this returns a sequence to activate.
 */
export const admitFromQueue = <T extends PreparedPromptInput>(args: {
  queue: ReturnType<typeof createAdmissionQueue<T>>
  acquireSequence: (prepared: T) => { id: number } | undefined
  onCancelled: (item: QueuedCompletion<T>) => void
  onAdmitted: (item: QueuedCompletion<T>, sequence: { id: number }) => void
  onReleased: (sequence: { id: number }) => void
}): boolean => {
  if (args.queue.isEmpty()) return false

  const front = args.queue.peekFront()
  if (front === undefined) return false
  if (front.cancellation.cancelled) {
    args.onCancelled(args.queue.popFront()!)
    return true
  }

  const sequence = args.acquireSequence(front.prepared)
  if (sequence === undefined) return false

  const item = args.queue.popFront()
  if (item === undefined) return false

  if (item.cancellation.cancelled) {
    args.onCancelled(item)
    args.onReleased(sequence)
    return true
  }

  args.onAdmitted(item, sequence)
  return true
}
