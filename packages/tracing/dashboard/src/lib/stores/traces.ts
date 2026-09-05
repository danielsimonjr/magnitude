import { useMemo, useSyncExternalStore } from 'react'
import type { AgentCallTrace, SessionInfo, ForkNode, SessionPage } from '../types'

export interface TraceState {
  readonly traces: AgentCallTrace[]
  readonly sessions: SessionInfo[]
  readonly selectedSessionId: string | null
  readonly selectedForkId: string | null | undefined
  readonly hiddenForkIds: Set<string | null>
  readonly selectedTraceId: string | null
  readonly hiddenCallTypes: Set<string>
  readonly loading: boolean
  readonly sessionsLoading: boolean
  readonly sessionsLoadingMore: boolean
  readonly sessionsCursor: string | null
  readonly hasMoreSessions: boolean
  readonly error: string | null
}

export interface ForkInfo {
  count: number
  name: string
}

export interface TokenTotals {
  readonly input: number
  readonly output: number
  readonly total: number
}

const initialState: TraceState = {
  traces: [],
  sessions: [],
  selectedSessionId: null,
  selectedForkId: undefined,
  hiddenForkIds: new Set(),
  selectedTraceId: null,
  hiddenCallTypes: new Set(),
  loading: false,
  sessionsLoading: false,
  sessionsLoadingMore: false,
  sessionsCursor: null,
  hasMoreSessions: true,
  error: null,
}

export function availableForks(traces: readonly AgentCallTrace[]): Map<string | null, ForkInfo> {
  const forks = new Map<string | null, ForkInfo>()
  for (const t of traces) {
    const forkId = t.actor.forkId
    const existing = forks.get(forkId)
    if (existing) {
      existing.count++
    } else {
      forks.set(forkId, {
        count: 1,
        name: forkId === null ? 'root' : forkId.slice(0, 8),
      })
    }
  }
  return forks
}

export function allTracesSorted(
  source: readonly AgentCallTrace[],
  hiddenForkIds: Set<string | null>,
  hiddenCallTypes: Set<string>,
): AgentCallTrace[] {
  let traces = [...source]
  if (hiddenForkIds.size > 0) {
    traces = traces.filter(t => !hiddenForkIds.has(t.actor.forkId))
  }
  if (hiddenCallTypes.size > 0) {
    traces = traces.filter(t => !hiddenCallTypes.has(t.callType))
  }
  return traces.sort((a, b) => a.startedAt - b.startedAt)
}

export function totalTokens(traces: readonly AgentCallTrace[]): TokenTotals {
  let input = 0
  let output = 0
  for (const t of traces) {
    if (t.response.usage?.inputTokens) input += t.response.usage.inputTokens
    if (t.response.usage?.outputTokens) output += t.response.usage.outputTokens
  }
  return { input, output, total: input + output }
}

export function callTypes(traces: readonly AgentCallTrace[]): string[] {
  const types = new Set<string>()
  for (const t of traces) {
    types.add(t.callType)
  }
  return [...types].sort()
}

export function buildForkTree(traces: readonly AgentCallTrace[]): ForkNode[] {
  const forkMap = new Map<string | null, { count: number }>()

  for (const t of traces) {
    const key = t.actor.forkId
    if (!forkMap.has(key)) {
      forkMap.set(key, { count: 0 })
    }
    forkMap.get(key)!.count++
  }

  const nodes: ForkNode[] = []
  for (const [forkId, info] of forkMap) {
    nodes.push({
      forkId,
      name: forkId === null ? 'root' : forkId.slice(0, 8),
      mode: forkId === null ? 'root' : 'spawn',
      parentForkId: null,
      children: [],
      traceCount: info.count,
    })
  }

  return nodes
}

class TraceStore {
  private state: TraceState = initialState
  private listeners = new Set<() => void>()
  private eventSource: EventSource | null = null

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  getSnapshot = (): TraceState => this.state

  private set(patch: Partial<TraceState>) {
    this.state = { ...this.state, ...patch }
    for (const listener of this.listeners) listener()
  }

  get traces() { return this.state.traces }
  get sessions() { return this.state.sessions }
  get selectedSessionId() { return this.state.selectedSessionId }
  get selectedForkId() { return this.state.selectedForkId }
  get hiddenForkIds() { return this.state.hiddenForkIds }
  get selectedTraceId() { return this.state.selectedTraceId }
  get hiddenCallTypes() { return this.state.hiddenCallTypes }
  get loading() { return this.state.loading }
  get sessionsLoading() { return this.state.sessionsLoading }
  get sessionsLoadingMore() { return this.state.sessionsLoadingMore }
  get sessionsCursor() { return this.state.sessionsCursor }
  get hasMoreSessions() { return this.state.hasMoreSessions }
  get error() { return this.state.error }

  get availableForks() { return availableForks(this.state.traces) }
  get allTracesSorted() { return allTracesSorted(this.state.traces, this.state.hiddenForkIds, this.state.hiddenCallTypes) }
  get selectedTrace(): AgentCallTrace | null {
    if (this.state.selectedTraceId === null) return null
    return this.state.traces.find(t => t.traceId === this.state.selectedTraceId) ?? null
  }
  get forkTree() { return buildForkTree(this.state.traces) }
  get totalTokens() { return totalTokens(this.state.traces) }
  get callTypes(): string[] { return callTypes(this.state.traces) }

  async fetchSessionsInitial(limit = 50) {
    this.set({
      sessionsLoading: true,
      sessionsLoadingMore: false,
      error: null,
      sessions: [],
      sessionsCursor: null,
      hasMoreSessions: true,
    })
    try {
      const res = await fetch(`/api/sessions?limit=${limit}`)
      if (!res.ok) throw new Error(`Failed to fetch sessions: ${res.status}`)
      const page = await res.json() as SessionPage
      this.set({
        sessions: page.items,
        sessionsCursor: page.nextCursor,
        hasMoreSessions: page.nextCursor !== null,
      })
    } catch (e: any) {
      this.set({ error: e.message, hasMoreSessions: false })
    } finally {
      this.set({ sessionsLoading: false })
    }
  }

  async fetchMoreSessions(limit = 50) {
    if (!this.state.hasMoreSessions || this.state.sessionsLoading || this.state.sessionsLoadingMore) return
    if (!this.state.sessionsCursor) return
    this.set({ sessionsLoadingMore: true, error: null })

    try {
      const cursor = encodeURIComponent(this.state.sessionsCursor)
      const res = await fetch(`/api/sessions?limit=${limit}&cursor=${cursor}`)
      if (!res.ok) throw new Error(`Failed to fetch sessions: ${res.status}`)
      const page = await res.json() as SessionPage
      this.set({
        sessions: [...this.state.sessions, ...page.items],
        sessionsCursor: page.nextCursor,
        hasMoreSessions: page.nextCursor !== null,
      })
    } catch (e: any) {
      this.set({ error: e.message })
    } finally {
      this.set({ sessionsLoadingMore: false })
    }
  }

  async selectSession(id: string) {
    this.set({
      selectedSessionId: id,
      hiddenForkIds: new Set(),
      selectedTraceId: null,
      traces: [],
      loading: true,
      error: null,
    })
    this.disconnectSSE()

    try {
      const res = await fetch(`/api/sessions/${encodeURIComponent(id)}/traces`)
      if (!res.ok) throw new Error(`Failed to fetch traces: ${res.status}`)
      this.set({ traces: await res.json() })
      this.connectSSE(id)
    } catch (e: any) {
      this.set({ error: e.message })
    } finally {
      this.set({ loading: false })
    }
  }

  private connectSSE(sessionId: string) {
    this.disconnectSSE()
    const es = new EventSource(`/api/sessions/${encodeURIComponent(sessionId)}/stream`)
    es.onmessage = (event) => {
      try {
        const trace: AgentCallTrace = JSON.parse(event.data)
        this.set({ traces: [...this.state.traces, trace] })
      } catch {}
    }
    es.onerror = () => {}
    this.eventSource = es
  }

  private disconnectSSE() {
    if (this.eventSource) {
      this.eventSource.close()
      this.eventSource = null
    }
  }

  toggleFork(forkId: string | null) {
    const next = new Set(this.state.hiddenForkIds)
    if (next.has(forkId)) {
      next.delete(forkId)
    } else {
      next.add(forkId)
    }
    this.set({ hiddenForkIds: next, selectedForkId: undefined, selectedTraceId: null })
  }

  showAllForks() {
    this.set({
      hiddenForkIds: this.state.hiddenForkIds.size === 0
        ? new Set(this.availableForks.keys())
        : new Set(),
      selectedForkId: undefined,
      selectedTraceId: null,
    })
  }

  selectFork(forkId: string | null) {
    this.set({
      selectedForkId: forkId,
      hiddenForkIds: new Set(
        [...this.availableForks.keys()].filter((candidate) => candidate !== forkId),
      ),
      selectedTraceId: null,
    })
  }

  toggleCallType(type: string) {
    const next = new Set(this.state.hiddenCallTypes)
    if (next.has(type)) {
      next.delete(type)
    } else {
      next.add(type)
    }
    this.set({ hiddenCallTypes: next, selectedTraceId: null })
  }

  showAllCallTypes() {
    this.set({
      hiddenCallTypes: this.state.hiddenCallTypes.size === 0
        ? new Set(this.callTypes)
        : new Set(),
      selectedTraceId: null,
    })
  }

  selectTrace(traceId: string | null) {
    this.set({ selectedTraceId: traceId })
  }

  clearSelection() {
    this.set({ hiddenForkIds: new Set(), hiddenCallTypes: new Set(), selectedForkId: undefined })
  }

  destroy() {
    this.disconnectSSE()
  }
}

export const traceStore = new TraceStore()

export interface TraceSnapshot extends TraceState {
  readonly availableForks: Map<string | null, ForkInfo>
  readonly allTracesSorted: AgentCallTrace[]
  readonly selectedTrace: AgentCallTrace | null
  readonly forkTree: ForkNode[]
  readonly totalTokens: TokenTotals
  readonly callTypes: string[]
}

/** Subscribes a component to the trace store; derived values are memoized per state snapshot. */
export function useTraceStore(): TraceSnapshot {
  const state = useSyncExternalStore(traceStore.subscribe, traceStore.getSnapshot, traceStore.getSnapshot)
  return useMemo<TraceSnapshot>(() => ({
    ...state,
    availableForks: availableForks(state.traces),
    allTracesSorted: allTracesSorted(state.traces, state.hiddenForkIds, state.hiddenCallTypes),
    selectedTrace: state.selectedTraceId === null
      ? null
      : state.traces.find(t => t.traceId === state.selectedTraceId) ?? null,
    forkTree: buildForkTree(state.traces),
    totalTokens: totalTokens(state.traces),
    callTypes: callTypes(state.traces),
  }), [state])
}
