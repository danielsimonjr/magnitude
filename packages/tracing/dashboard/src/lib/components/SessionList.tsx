import { useEffect, useRef, useState } from 'react'
import { traceStore, useTraceStore } from '../stores/traces'

function formatDate(ts: string): string {
  try {
    const d = new Date(ts)
    return d.toLocaleString()
  } catch {
    return ts
  }
}

export function SessionList({ onSelect }: { onSelect: (id: string) => void }) {
  const store = useTraceStore()
  const [sentinel, setSentinel] = useState<HTMLDivElement | null>(null)
  const observerRef = useRef<IntersectionObserver | null>(null)

  useEffect(() => {
    const observer = new IntersectionObserver((entries) => {
      const visible = entries.some((e) => e.isIntersecting)
      const canFetchMoreSessions =
        traceStore.hasMoreSessions && !traceStore.sessionsLoading && !traceStore.sessionsLoadingMore
      if (visible && canFetchMoreSessions) {
        void traceStore.fetchMoreSessions()
      }
    }, { rootMargin: '400px 0px' })
    observerRef.current = observer

    void traceStore.fetchSessionsInitial()

    return () => {
      observer.disconnect()
      observerRef.current = null
    }
  }, [])

  useEffect(() => {
    const observer = observerRef.current
    if (!observer || !sentinel) return
    observer.observe(sentinel)
    return () => {
      observer.unobserve(sentinel)
    }
  }, [sentinel])

  return (
    <div className="p-6">
      <h1 className="text-2xl font-semibold mb-6 text-[var(--text-primary)]">Sessions</h1>

      {store.sessionsLoading ? (
        <p className="text-[var(--text-muted)]">Loading sessions...</p>
      ) : store.error ? (
        <p className="text-[var(--accent-red)]">{store.error}</p>
      ) : store.sessions.length === 0 ? (
        <div className="text-[var(--text-muted)] text-center py-12">
          <p className="text-lg mb-2">No trace sessions found</p>
          <p className="text-sm">Traces will appear here once Magnitude records LLM calls to ~/.magnitude/traces/</p>
        </div>
      ) : (
        <>
          <div className="space-y-2">
            {store.sessions.map((session) => (
              <button
                key={session.id}
                className="w-full text-left p-4 rounded-lg bg-[var(--bg-secondary)] border border-[var(--border)] hover:bg-[var(--bg-hover)] hover:border-[var(--accent-blue)]/30 transition-colors cursor-pointer"
                onClick={() => onSelect(session.id)}
              >
                <div className="flex items-center justify-between">
                  <div>
                    {session.meta?.chatName ? (
                      <span className="text-sm text-[var(--text-primary)]">{session.meta.chatName}</span>
                    ) : (
                      <span className="text-sm text-[var(--text-muted)]">New Chat</span>
                    )}
                    <span className="ml-3 text-sm text-[var(--text-muted)]">{formatDate(session.timestamp)}</span>
                  </div>
                  <div className="flex items-center gap-4 text-sm text-[var(--text-secondary)]">
                    {session.traceCount !== undefined && (
                      <span>{session.traceCount} traces</span>
                    )}
                  </div>
                </div>
              </button>
            ))}
          </div>
          <div ref={setSentinel} className="h-4"></div>
          {store.sessionsLoadingMore && (
            <div className="mt-3 flex items-center gap-2 text-sm text-[var(--text-muted)]">
              <span className="inline-block h-4 w-4 animate-spin rounded-full border-2 border-[var(--border)] border-t-[var(--accent-blue)]"></span>
              <span>Loading more sessions…</span>
            </div>
          )}
        </>
      )}
    </div>
  )
}
