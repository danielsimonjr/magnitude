import { useEffect } from 'react'
import { traceStore, useTraceStore } from '../stores/traces'
import { TurnDetail } from './TurnDetail'
import { traceFailure, type AgentCallTrace } from '../types'

interface Props {
  sessionId: string
  selectedTraceIdFromRoute?: string | null
  onSelectTrace?: (traceId: string | null, replace?: boolean) => void
  onBack: () => void
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M'
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'k'
  return String(n)
}

function formatTime(ts: number): string {
  return new Date(ts).toLocaleTimeString()
}

function scopeLabel(trace: AgentCallTrace): string {
  switch (trace.scope.kind) {
    case 'turn':
      return trace.scope.turnId.slice(0, 8)
    case 'operation':
      return trace.scope.operationId.slice(0, 8)
  }
}

const callTypeColors: Record<string, string> = {
  chat: 'var(--accent-blue)',
  compact: 'var(--accent-yellow)',
  autopilot: 'var(--accent-green)',
  observer: 'var(--accent-purple)',
  advisor: 'var(--accent-purple)',
  image: 'var(--accent-green)',
  title: 'var(--text-muted)',
}

function getCallTypeColor(type: string | undefined): string {
  return callTypeColors[type ?? 'chat'] ?? 'var(--text-secondary)'
}

function finishReasonClass(reason: string): string {
  if (reason === 'length' || reason === 'content_filter') return 'text-[var(--accent-red)]'
  if (reason === 'stop' || reason === 'end_turn') return 'text-[var(--text-muted)]'
  return 'text-[var(--accent-yellow)]'
}

export function SessionDetail({
  sessionId,
  selectedTraceIdFromRoute = null,
  onSelectTrace,
  onBack,
}: Props) {
  const store = useTraceStore()

  useEffect(() => {
    if (sessionId) {
      void traceStore.selectSession(sessionId)
    }
  }, [sessionId])

  useEffect(() => {
    if (!sessionId || store.selectedSessionId !== sessionId || store.loading) return

    if (!selectedTraceIdFromRoute) {
      if (store.selectedTraceId !== null) traceStore.selectTrace(null)
      return
    }

    const exists = store.allTracesSorted.some(
      (trace) => trace.traceId === selectedTraceIdFromRoute,
    )

    if (exists) {
      if (store.selectedTraceId !== selectedTraceIdFromRoute) {
        traceStore.selectTrace(selectedTraceIdFromRoute)
      }
    } else if (store.allTracesSorted.length > 0) {
      traceStore.selectTrace(null)
      onSelectTrace?.(null, true)
    }
  }, [sessionId, selectedTraceIdFromRoute, store.selectedSessionId, store.loading, store.selectedTraceId, store.allTracesSorted, onSelectTrace])

  return (
    <div className="flex flex-col h-screen">
      {/* Header */}
      <header className="border-b border-[var(--border)] px-4 py-2 flex items-center gap-4 flex-shrink-0">
        <button className="text-sm text-[var(--accent-blue)] hover:underline cursor-pointer" onClick={onBack}>← Sessions</button>
        <span className="text-sm font-mono text-[var(--text-secondary)]">{sessionId}</span>
      </header>

      <div className="flex flex-1 overflow-hidden">
        {/* Left sidebar: filters */}
        <div className="w-64 border-r border-[var(--border)] flex flex-col overflow-y-auto">
          {/* Stats */}
          <div className="p-4 border-b border-[var(--border)]">
            <div className="text-xs font-semibold uppercase tracking-wider text-[var(--text-muted)] mb-2">Overview</div>
            <div className="space-y-1 text-sm">
              <div className="flex justify-between">
                <span className="text-[var(--text-secondary)]">Traces</span>
                <span className="font-mono">{store.traces.length}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-[var(--text-secondary)]">Input tokens</span>
                <span className="font-mono">{formatTokens(store.totalTokens.input)}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-[var(--text-secondary)]">Output tokens</span>
                <span className="font-mono">{formatTokens(store.totalTokens.output)}</span>
              </div>
            </div>
          </div>

          {/* Call Type filter */}
          <div className="p-4 border-b border-[var(--border)]">
            <div className="flex items-center justify-between mb-2">
              <div className="text-xs font-semibold uppercase tracking-wider text-[var(--text-muted)]">Call Type</div>
              <button className="text-xs text-[var(--accent-blue)] hover:underline cursor-pointer" onClick={() => traceStore.showAllCallTypes()}>All</button>
            </div>
            <div className="space-y-1">
              {store.callTypes.map((ct) => (
                <button
                  key={ct}
                  className={`w-full text-left px-2 py-1 rounded text-xs flex items-center gap-2 cursor-pointer transition-colors ${store.hiddenCallTypes.has(ct) ? 'text-[var(--text-muted)]' : 'text-[var(--text-primary)]'}`}
                  onClick={() => traceStore.toggleCallType(ct)}
                >
                  <span className="inline-block w-2 h-2 rounded-full flex-shrink-0" style={{ background: getCallTypeColor(ct), opacity: store.hiddenCallTypes.has(ct) ? 0.3 : 1 }}></span>
                  {ct}
                </button>
              ))}
            </div>
          </div>

          {/* Forks filter */}
          <div className="p-4">
            <div className="flex items-center justify-between mb-2">
              <div className="text-xs font-semibold uppercase tracking-wider text-[var(--text-muted)]">Forks</div>
              <button className="text-xs text-[var(--accent-blue)] hover:underline cursor-pointer" onClick={() => traceStore.showAllForks()}>All</button>
            </div>
            <div className="space-y-1">
              {[...store.availableForks].map(([forkId, info]) => (
                <button
                  key={forkId ?? 'root'}
                  className={`w-full text-left px-2 py-1 rounded text-xs flex items-center justify-between cursor-pointer transition-colors ${store.hiddenForkIds.has(forkId) ? 'text-[var(--text-muted)] hover:bg-[var(--bg-hover)]' : 'text-[var(--text-primary)] bg-[var(--bg-hover)]'}`}
                  onClick={() => traceStore.toggleFork(forkId)}
                >
                  <span className="font-mono" title={forkId ?? 'root'}>{info.name}</span>
                  <span className="text-[var(--text-muted)]">{info.count}</span>
                </button>
              ))}
            </div>
          </div>
        </div>

        {/* Main content: turn list + detail */}
        <div className="flex-1 flex flex-col overflow-hidden">
          {store.loading ? (
            <div className="flex-1 flex items-center justify-center">
              <p className="text-[var(--text-muted)]">Loading traces...</p>
            </div>
          ) : store.error ? (
            <div className="flex-1 flex items-center justify-center">
              <p className="text-[var(--accent-red)]">{store.error}</p>
            </div>
          ) : store.traces.length === 0 ? (
            <div className="flex-1 flex items-center justify-center">
              <p className="text-[var(--text-muted)]">No traces for this selection</p>
            </div>
          ) : (
            <div className="flex-1 flex overflow-hidden">
              {/* Turn list */}
              <div className="w-80 border-r border-[var(--border)] overflow-y-auto">
                {store.allTracesSorted.map((trace) => (
                  <button
                    key={trace.traceId}
                    className={`w-full text-left px-3 py-2 text-sm border-b border-[var(--border)]/50 transition-colors cursor-pointer ${store.selectedTraceId === trace.traceId ? 'bg-[var(--bg-hover)] border-l-2 border-l-[var(--accent-blue)]' : 'hover:bg-[var(--bg-hover)]'}`}
                    onClick={() => {
                      traceStore.selectTrace(trace.traceId)
                      onSelectTrace?.(trace.traceId)
                    }}
                  >
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-1.5">
                        {traceFailure(trace) ? (
                          <span className="inline-block w-1.5 h-1.5 rounded-full flex-shrink-0" style={{ background: 'var(--accent-red)' }}></span>
                        ) : (
                          <span className="inline-block w-1.5 h-1.5 rounded-full flex-shrink-0" style={{ background: getCallTypeColor(trace.callType) }}></span>
                        )}
                        <span className="font-mono text-xs" style={{ color: traceFailure(trace) ? 'var(--accent-red)' : getCallTypeColor(trace.callType) }}>{trace.callType}</span>
                      </div>
                      <span className="text-xs text-[var(--text-muted)]">{formatTime(trace.startedAt)}</span>
                    </div>
                    <div className="flex items-center gap-2 mt-1">
                      <span className="text-xs text-[var(--text-secondary)]">{trace.modelId ?? 'unknown'}</span>
                      <span className="text-xs font-mono text-[var(--text-muted)]">{trace.scope.kind}:{scopeLabel(trace)}</span>
                      {trace.response.finishReason && (
                        <span className={`text-xs font-mono ${finishReasonClass(trace.response.finishReason)}`}>{trace.response.finishReason}</span>
                      )}
                      {traceFailure(trace) && (
                        <span className="text-xs text-[var(--accent-red)]">error</span>
                      )}
                      {trace.response.usage?.inputTokens ? (
                        <span className="text-xs text-[var(--text-muted)]">{formatTokens(trace.response.usage.inputTokens)} in</span>
                      ) : null}
                      {trace.response.usage?.outputTokens ? (
                        <span className="text-xs text-[var(--text-muted)]">{formatTokens(trace.response.usage.outputTokens)} out</span>
                      ) : null}
                    </div>
                    {trace.actor.forkId && (
                      <div className="text-xs text-[var(--accent-purple)] mt-0.5 font-mono">{trace.actor.forkId.slice(0, 8)}</div>
                    )}
                  </button>
                ))}
              </div>

              {/* Turn detail */}
              <div className="flex-1 overflow-y-auto">
                {store.selectedTrace ? (
                  <TurnDetail trace={store.selectedTrace} />
                ) : (
                  <div className="flex-1 flex items-center justify-center h-full">
                    <p className="text-[var(--text-muted)]">Select a trace to view details</p>
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
