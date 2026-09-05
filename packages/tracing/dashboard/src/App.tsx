import { useEffect, useState } from 'react'
import { SessionList } from './lib/components/SessionList'
import { SessionDetail } from './lib/components/SessionDetail'

function parsePath(pathname: string): { sessionId: string | null; traceId: string | null } {
  if (pathname === '/') return { sessionId: null, traceId: null }
  const traceMatch = pathname.match(/^\/session\/([^/]+)\/trace\/([^/]+)$/)
  if (traceMatch) {
    return {
      sessionId: decodeURIComponent(traceMatch[1]),
      traceId: decodeURIComponent(traceMatch[2]),
    }
  }
  const sessionMatch = pathname.match(/^\/session\/([^/]+)$/)
  if (sessionMatch) {
    return {
      sessionId: decodeURIComponent(sessionMatch[1]),
      traceId: null,
    }
  }
  return { sessionId: null, traceId: null }
}

export function App() {
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null)
  const [selectedTraceId, setSelectedTraceId] = useState<string | null>(null)

  function applyRoute(pathname: string) {
    const route = parsePath(pathname)
    setSelectedSessionId(route.sessionId)
    setSelectedTraceId(route.traceId)
  }

  function navigate(path: string, replace = false) {
    if (replace) history.replaceState(null, '', path)
    else history.pushState(null, '', path)
    applyRoute(path)
  }

  function handleSelectSession(id: string) {
    navigate(`/session/${encodeURIComponent(id)}`)
  }

  function handleTraceSelection(traceId: string | null, replace = false) {
    if (!selectedSessionId) return
    if (!traceId) {
      navigate(`/session/${encodeURIComponent(selectedSessionId)}`, replace)
      return
    }
    navigate(`/session/${encodeURIComponent(selectedSessionId)}/trace/${encodeURIComponent(traceId)}`, replace)
  }

  function handleBack() {
    navigate('/')
  }

  useEffect(() => {
    applyRoute(window.location.pathname)
    const onPopState = () => applyRoute(window.location.pathname)
    window.addEventListener('popstate', onPopState)
    return () => window.removeEventListener('popstate', onPopState)
  }, [])

  return (
    <div className="min-h-screen bg-[var(--bg-primary)]">
      {!selectedSessionId ? (
        <SessionList onSelect={handleSelectSession} />
      ) : (
        <SessionDetail
          sessionId={selectedSessionId}
          selectedTraceIdFromRoute={selectedTraceId}
          onSelectTrace={handleTraceSelection}
          onBack={handleBack}
        />
      )}
    </div>
  )
}
