import type { AgentCallTrace as BaseAgentCallTrace } from '@magnitudedev/tracing'

export type { TokenLogprob, RawInputToken, RawOutputToken, RawLogprobEntry } from '@magnitudedev/tracing'

/**
 * Trace shape as read from ~/.magnitude/traces. Current writers record
 * `modelAttemptFailure`; older files carry a `streamStartFailure` marker. Both
 * are rendered through `traceFailure`.
 */
export type AgentCallTrace = BaseAgentCallTrace & {
  readonly streamStartFailure?: {
    readonly _tag: string
    readonly message?: string | null
  } | null
}

export interface TraceFailure {
  readonly label: string
  readonly message: string | null
}

/** The failure to display for a trace, preferring the current snapshot over the legacy marker. */
export const traceFailure = (trace: AgentCallTrace): TraceFailure | null => {
  const current = trace.modelAttemptFailure
  if (current) {
    return {
      label: `${current.phase}: ${current.tag}${current.detailTag ? ` (${current.detailTag})` : ''}`,
      message: current.providerMessage ?? current.message ?? null,
    }
  }
  const legacy = trace.streamStartFailure
  if (legacy) return { label: legacy._tag, message: legacy.message ?? null }
  return null
}

export interface SessionInfo {
  id: string
  timestamp: string
  traceCount?: number
  meta?: Record<string, any>
}

export interface SessionPage {
  items: SessionInfo[]
  nextCursor: string | null
}

export interface ForkNode {
  forkId: string | null
  name: string
  mode: 'clone' | 'spawn' | 'root'
  parentForkId: string | null
  children: ForkNode[]
  traceCount: number
}
