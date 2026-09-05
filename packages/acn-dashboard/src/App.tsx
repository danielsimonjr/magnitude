import { useEffect, useMemo, useState } from 'react'
import { MemoryAtlasCanvas } from './MemoryAtlasCanvas'
import type {
  AcnDisplayViewIntrospection,
  AcnInfo,
  AcnSession,
  AcnSessionIntrospection,
  AddressedAtlasNode,
  AddressedAtlasResident,
  AddressedAtlasSegment,
  AddressedPin,
  KillAllAcnResult,
  ProjectionIntrospection,
  RpcTraceSummary,
} from './lib/types'

interface ClientSegmentPin {
  readonly node: AddressedAtlasSegment
}

interface ClientSummary {
  readonly id: string
  readonly view: AcnDisplayViewIntrospection | null
  readonly shapeLabel: string
  readonly subscriberCount: number
  readonly lastActivityAt: number | null
  readonly pinnedSegments: readonly ClientSegmentPin[]
  readonly pinnedBytes: number
}

interface MemoryStats {
  readonly addressedRootCount: number
  readonly loadedEntries: number
  readonly offloadedEntries: number
  readonly pinnedEntries: number
  readonly producerPinnedEntries: number
  readonly projectionStateBytes: number
  readonly addressedBytes: number
  readonly knownBytes: number
}

type WorkspaceTab = 'atlas' | 'projections' | 'rpc'

type InspectorSelection =
  | { readonly kind: 'session' }
  | { readonly kind: 'client'; readonly clientId: string }
  | { readonly kind: 'projection'; readonly projectionName: string }
  | { readonly kind: 'addressed'; readonly node: AddressedAtlasNode }

type StreamState = 'idle' | 'connecting' | 'live' | 'error'

const EMPTY_PROJECTIONS: readonly ProjectionIntrospection[] = []
const EMPTY_ATLAS: readonly AddressedAtlasNode[] = []
const EMPTY_VIEWS: readonly AcnDisplayViewIntrospection[] = []

function formatTime(timestamp: number | null | undefined): string {
  if (!timestamp) return 'never'
  return new Date(timestamp).toLocaleTimeString()
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MiB`
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KiB`
  return `${bytes} B`
}

function shortId(value: string): string {
  return value.length > 12 ? value.slice(0, 12) : value
}

function durationLabel(trace: RpcTraceSummary): string {
  const startedAt = new Date(trace.startedAt).getTime()
  const duration = trace.isRunning && Number.isFinite(startedAt)
    ? Date.now() - startedAt
    : trace.durationMs
  if (duration >= 1000) return `${(duration / 1000).toFixed(1)}s`
  return `${Math.max(0, Math.round(duration))}ms`
}

function projectionLabel(projection: ProjectionIntrospection): string {
  return projection.name.replace(/Projection$/, '')
}

function projectionSummary(projection: ProjectionIntrospection): string {
  if (projection.summary?.label) return projection.summary.label
  const state = projection.state
  if (state == null) return 'empty'
  if (typeof state !== 'object') return typeof state
  if (Array.isArray(state)) return `${state.length} items`
  return `${Object.keys(state as Record<string, unknown>).length} keys`
}

function segmentRange(segment: AddressedAtlasSegment): string {
  if (segment.itemCount <= 0) return `${segment.startOffset}`
  const end = segment.startOffset + segment.itemCount - 1
  return segment.startOffset === end ? `${segment.startOffset}` : `${segment.startOffset}-${end}`
}

function segmentStateLabel(segment: AddressedAtlasSegment): string {
  const state = segment.residency === 'resident' ? 'loaded' : 'offloaded'
  const dirty = segment.dirty ? ' dirty' : ''
  const pinned = segment.pins.length > 0 ? ` pinned ${segment.pins.length}` : ''
  return `${state}${dirty}${pinned}`
}

function segmentHiddenItemCount(segment: AddressedAtlasSegment): number {
  return Math.max(0, segment.itemCount - segment.itemIdsSample.length)
}

function displayViewShapeSummary(view: AcnDisplayViewIntrospection): string {
  if (!view.shape) return 'shape not set'
  const timelines = Object.entries(view.shape.timelines)
  if (timelines.length === 0) return 'no timelines'
  return timelines.map(([timeline, window]) => {
    const label = window.kind === 'tail'
      ? `tail ${window.limit}`
      : `${window.start}-${window.start + window.limit}`
    return `${timeline}: ${label}${window.live ? ' live' : ''}`
  }).join(' · ')
}

function pinClientId(pin: AddressedPin): string | null {
  if (pin.kind !== 'display-view') return null
  return pin.viewId ?? pin.owner.replace(/^display-view:/, '')
}

function displayPins(node: AddressedAtlasSegment | AddressedAtlasResident): readonly AddressedPin[] {
  return node.pins.filter((pin) => pin.kind === 'display-view')
}

function producerPins(node: AddressedAtlasSegment | AddressedAtlasResident): readonly AddressedPin[] {
  return node.pins.filter((pin) => pin.kind === 'display-producer')
}

function segmentEstimatedBytes(segment: AddressedAtlasSegment): number {
  return segment.estimatedBytes ?? segment.estimatedResidentBytes ?? segment.estimatedStoredBytes ?? 0
}

function addressedNodeTitle(node: AddressedAtlasNode): string {
  return node.path.join(' / ')
}

function addressedNodeSize(node: AddressedAtlasNode): string {
  return node.bytes > 0 ? formatBytes(node.bytes) : 'unknown'
}

function walkAddressedNodes(
  nodes: readonly AddressedAtlasNode[],
  visit: (node: AddressedAtlasNode) => void,
): void {
  for (const node of nodes) {
    visit(node)
    if (node.kind === 'group') walkAddressedNodes(node.children, visit)
  }
}

function addressedSegments(nodes: readonly AddressedAtlasNode[]): AddressedAtlasSegment[] {
  const segments: AddressedAtlasSegment[] = []
  walkAddressedNodes(nodes, (node) => {
    if (node.kind === 'segment') segments.push(node)
  })
  return segments
}

function buildMemoryStats(
  currentProjections: readonly ProjectionIntrospection[],
  roots: readonly AddressedAtlasNode[],
): MemoryStats {
  let producerPinnedEntries = 0
  const projectionStateBytes = currentProjections.reduce(
    (total, projection) => total + (projection.summary?.estimatedBytes ?? 0),
    0,
  )
  const rootMetrics = roots.reduce((metrics, root) => ({
    bytes: metrics.bytes + root.bytes,
    residentEntryCount: metrics.residentEntryCount + root.residentEntryCount,
    offloadedEntryCount: metrics.offloadedEntryCount + root.offloadedEntryCount,
    pinnedEntryCount: metrics.pinnedEntryCount + root.pinnedEntryCount,
  }), {
    bytes: 0,
    residentEntryCount: 0,
    offloadedEntryCount: 0,
    pinnedEntryCount: 0,
  })

  for (const segment of addressedSegments(roots)) {
    if (producerPins(segment).length > 0) producerPinnedEntries += 1
  }

  return {
    addressedRootCount: roots.length,
    loadedEntries: rootMetrics.residentEntryCount,
    offloadedEntries: rootMetrics.offloadedEntryCount,
    pinnedEntries: rootMetrics.pinnedEntryCount,
    producerPinnedEntries,
    projectionStateBytes,
    addressedBytes: rootMetrics.bytes,
    knownBytes: projectionStateBytes + rootMetrics.bytes,
  }
}

function buildClientSummaries(
  views: readonly AcnDisplayViewIntrospection[],
  roots: readonly AddressedAtlasNode[],
): ClientSummary[] {
  const summaries = new Map<string, {
    view: AcnDisplayViewIntrospection | null
    pins: ClientSegmentPin[]
    pinnedBytes: number
    seenSegments: Set<string>
  }>()

  const ensure = (id: string) => {
    const existing = summaries.get(id)
    if (existing) return existing
    const created = {
      view: null,
      pins: [],
      pinnedBytes: 0,
      seenSegments: new Set<string>(),
    }
    summaries.set(id, created)
    return created
  }

  for (const view of views) {
    ensure(view.viewId).view = view
  }

  for (const segment of addressedSegments(roots)) {
    for (const pin of displayPins(segment)) {
      const id = pinClientId(pin)
      if (!id) continue
      const summary = ensure(id)
      const key = `${segment.namespace}\u0000${segment.forkId ?? 'root'}\u0000${segment.address}`
      if (summary.seenSegments.has(key)) continue
      summary.seenSegments.add(key)
      summary.pins.push({ node: segment })
      summary.pinnedBytes += segmentEstimatedBytes(segment)
    }
  }

  return [...summaries.entries()]
    .map(([id, summary]) => ({
      id,
      view: summary.view,
      shapeLabel: summary.view ? displayViewShapeSummary(summary.view) : 'pinned view',
      subscriberCount: summary.view?.subscriberCount ?? 0,
      lastActivityAt: summary.view?.lastActivityAt ?? null,
      pinnedSegments: summary.pins,
      pinnedBytes: summary.pinnedBytes,
    }))
    .sort((left, right) => left.id.localeCompare(right.id))
}

function selectedProjectionForInspector(
  selection: InspectorSelection,
  currentProjections: readonly ProjectionIntrospection[],
): ProjectionIntrospection | null {
  return selection.kind === 'projection'
    ? currentProjections.find((projection) => projection.name === selection.projectionName) ?? null
    : null
}

function selectedClientForInspector(
  selection: InspectorSelection,
  currentClients: readonly ClientSummary[],
): ClientSummary | null {
  return selection.kind === 'client'
    ? currentClients.find((client) => client.id === selection.clientId) ?? null
    : null
}

function killSummary(results: KillAllAcnResult[]): string {
  const killed = results.filter((result) => result.status === 'killed').length
  const stale = results.filter((result) => result.status === 'stale').length
  const failed = results.filter((result) => result.status === 'failed').length
  if (results.length === 0) return 'No ACN owner found'
  return `Killed ${killed} ACN${killed === 1 ? '' : 's'}${stale ? `, removed ${stale} stale` : ''}${failed ? `, ${failed} failed` : ''}`
}

const errorMessage = (caught: unknown): string =>
  caught instanceof Error ? caught.message : String(caught)

const classes = (...names: Array<string | false | null | undefined>): string =>
  names.filter(Boolean).join(' ')

export function App() {
  const [acns, setAcns] = useState<AcnInfo[]>([])
  const [sessions, setSessions] = useState<AcnSession[]>([])
  const [selectedVersion, setSelectedVersion] = useState<string | null>(null)
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null)
  const [selectedIntrospection, setSelectedIntrospection] = useState<AcnSessionIntrospection | null>(null)
  const [rpcTraces, setRpcTraces] = useState<RpcTraceSummary[]>([])
  const [activeTab, setActiveTab] = useState<WorkspaceTab>('atlas')
  const [inspectorSelection, setInspectorSelection] = useState<InspectorSelection>({ kind: 'session' })
  const [selectedProjectionName, setSelectedProjectionName] = useState<string | null>(null)
  const [hoveredClientId, setHoveredClientId] = useState<string | null>(null)
  const [selectedClientId, setSelectedClientId] = useState<string | null>(null)
  const [loadingAcns, setLoadingAcns] = useState(false)
  const [loadingSessions, setLoadingSessions] = useState(false)
  const [killingAcns, setKillingAcns] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [rpcTraceError, setRpcTraceError] = useState<string | null>(null)
  const [streamState, setStreamState] = useState<StreamState>('idle')

  const selectedAcn = acns.find((acn) => acn.version === selectedVersion) ?? null
  const selectedSession = sessions.find((session) => session.sessionId === selectedSessionId) ?? null
  const agentIntrospection = selectedIntrospection?.introspection ?? null
  const projections = agentIntrospection?.projections ?? EMPTY_PROJECTIONS
  const addressedAtlas = agentIntrospection?.addressedAtlas ?? EMPTY_ATLAS
  const displayViews = selectedIntrospection?.displayViews ?? EMPTY_VIEWS
  const clients = useMemo(() => buildClientSummaries(displayViews, addressedAtlas), [displayViews, addressedAtlas])
  const activeClientId = hoveredClientId ?? selectedClientId
  const selectedInspectorProjection = selectedProjectionForInspector(inspectorSelection, projections)
  const selectedInspectorClient = selectedClientForInspector(inspectorSelection, clients)
  const selectedAddressedNode = inspectorSelection.kind === 'addressed' ? inspectorSelection.node : null
  const selectedProjection =
    projections.find((projection) => projection.name === selectedProjectionName) ?? projections[0] ?? null
  const displayViewSubscriberCount = displayViews.reduce((total, view) => total + view.subscriberCount, 0)
  const rpcCommands = rpcTraces.filter((trace) => trace.kind === 'command')
  const rpcStreams = rpcTraces.filter((trace) => trace.kind === 'stream')
  const memoryStats = useMemo(() => buildMemoryStats(projections, addressedAtlas), [projections, addressedAtlas])

  async function fetchAcns() {
    setLoadingAcns(true)
    setError(null)
    try {
      const response = await fetch('/api/acns')
      if (!response.ok) throw new Error(`${response.status} ${response.statusText}`)
      const payload = await response.json() as { acns: AcnInfo[] }
      setAcns(payload.acns)
      setSelectedVersion((current) => {
        if (!current || !payload.acns.some((acn) => acn.version === current)) {
          return payload.acns.find((acn) => acn.introspection.ok)?.version ?? payload.acns[0]?.version ?? null
        }
        return current
      })
    } catch (caught) {
      setError(errorMessage(caught))
    } finally {
      setLoadingAcns(false)
    }
  }

  async function fetchSessions(version: string | null) {
    if (!version) {
      setSessions([])
      setSelectedSessionId(null)
      return
    }

    setLoadingSessions(true)
    setError(null)
    try {
      const response = await fetch(`/api/acns/${encodeURIComponent(version)}/sessions`)
      if (!response.ok) throw new Error(`${response.status} ${response.statusText}`)
      const payload = await response.json() as { sessions: AcnSession[] }
      setSessions(payload.sessions)
      setSelectedSessionId((current) => {
        if (!current || !payload.sessions.some((session) => session.sessionId === current)) {
          return payload.sessions[0]?.sessionId ?? null
        }
        return current
      })
    } catch (caught) {
      setSessions([])
      setSelectedSessionId(null)
      setSelectedIntrospection(null)
      setError(errorMessage(caught))
    } finally {
      setLoadingSessions(false)
    }
  }

  async function fetchRpcTraces() {
    setRpcTraceError(null)
    try {
      const response = await fetch('/api/rpc-traces')
      if (!response.ok) throw new Error(`${response.status} ${response.statusText}`)
      const payload = await response.json() as { traces: RpcTraceSummary[], error?: string }
      setRpcTraces(payload.traces)
      setRpcTraceError(payload.error ?? null)
    } catch (caught) {
      setRpcTraces([])
      setRpcTraceError(errorMessage(caught))
    }
  }

  async function killAllAcns() {
    if (killingAcns) return
    const ok = window.confirm('Kill the current ACN owner process?')
    if (!ok) return

    setKillingAcns(true)
    setError(null)
    setNotice(null)
    try {
      const response = await fetch('/api/acns/kill-all', { method: 'POST' })
      if (!response.ok) throw new Error(`${response.status} ${response.statusText}`)
      const payload = await response.json() as { results: KillAllAcnResult[] }
      setNotice(killSummary(payload.results))
      await new Promise((resolve) => setTimeout(resolve, 500))
      await fetchAcns()
      setSessions([])
      setSelectedSessionId(null)
      setSelectedIntrospection(null)
    } catch (caught) {
      setError(errorMessage(caught))
    } finally {
      setKillingAcns(false)
    }
  }

  useEffect(() => {
    void fetchAcns()
    void fetchRpcTraces()
    const interval = setInterval(() => {
      void fetchAcns()
      void fetchRpcTraces()
    }, 3000)
    return () => clearInterval(interval)
  }, [])

  useEffect(() => {
    void fetchSessions(selectedVersion)
  }, [selectedVersion])

  useEffect(() => {
    if (!selectedVersion || !selectedSessionId) {
      setStreamState('idle')
      setSelectedIntrospection(null)
      return
    }

    setStreamState('connecting')
    setInspectorSelection({ kind: 'session' })
    setSelectedProjectionName(null)
    setSelectedClientId(null)
    setHoveredClientId(null)
    const source = new EventSource(
      `/api/acns/${encodeURIComponent(selectedVersion)}/sessions/${encodeURIComponent(selectedSessionId)}/stream`,
    )

    source.onopen = () => {
      setStreamState('live')
    }
    source.onmessage = (event) => {
      setSelectedIntrospection(JSON.parse(event.data) as AcnSessionIntrospection)
    }
    source.onerror = () => {
      setStreamState('error')
      source.close()
    }

    return () => source.close()
  }, [selectedVersion, selectedSessionId])

  useEffect(() => {
    if (projections.length === 0) {
      setSelectedProjectionName(null)
      return
    }

    if (!selectedProjectionName || !projections.some((projection) => projection.name === selectedProjectionName)) {
      setSelectedProjectionName(projections[0].name)
    }
  }, [projections, selectedProjectionName])

  const traceLink = (trace: RpcTraceSummary, kind: 'command' | 'stream') => (
    <a
      key={trace.traceId}
      className={classes('call', kind, trace.isRunning && 'running', trace.errorCount > 0 && 'error')}
      href={`http://127.0.0.1:27686/api/traces/${trace.traceId}`}
      target="_blank"
      rel="noreferrer"
    >
      <strong>{trace.rpcName}</strong>
      <em>{durationLabel(trace)}</em>
      <small>{trace.spanCount} spans{trace.errorCount ? ` · ${trace.errorCount} errors` : ''}</small>
    </a>
  )

  const renderInspector = () => {
    if (selectedAddressedNode) {
      return (
        <>
          <h3>{addressedNodeTitle(selectedAddressedNode)}</h3>
          <dl>
            <dt>size</dt>
            <dd>{addressedNodeSize(selectedAddressedNode)}</dd>
            <dt>loaded</dt>
            <dd>{selectedAddressedNode.residentEntryCount}</dd>
            <dt>offloaded</dt>
            <dd>{selectedAddressedNode.offloadedEntryCount}</dd>
            <dt>pinned</dt>
            <dd>{selectedAddressedNode.pinnedEntryCount}</dd>
            <dt>dirty</dt>
            <dd>{selectedAddressedNode.dirtyEntryCount}</dd>
          </dl>
          {selectedAddressedNode.kind === 'segment' ? (
            <>
              <dl>
                <dt>fork</dt>
                <dd>{selectedAddressedNode.forkId ? shortId(selectedAddressedNode.forkId) : 'root'}</dd>
                <dt>segment</dt>
                <dd>{selectedAddressedNode.logicalSegmentId}</dd>
                <dt>range</dt>
                <dd>{segmentRange(selectedAddressedNode)}</dd>
                <dt>state</dt>
                <dd>{segmentStateLabel(selectedAddressedNode)}</dd>
                <dt>resident bytes</dt>
                <dd>{selectedAddressedNode.estimatedResidentBytes === null ? 'not resident' : formatBytes(selectedAddressedNode.estimatedResidentBytes)}</dd>
                <dt>stored bytes</dt>
                <dd>{selectedAddressedNode.estimatedStoredBytes === null ? 'unknown' : formatBytes(selectedAddressedNode.estimatedStoredBytes)}</dd>
                <dt>address</dt>
                <dd>{selectedAddressedNode.address}</dd>
              </dl>
              <section className="activity-section">
                <h3>Consumer Pins</h3>
                <div className="activity-group">
                  {displayPins(selectedAddressedNode).length === 0 ? (
                    <small>none</small>
                  ) : (
                    displayPins(selectedAddressedNode).map((pin, index) => (
                      <button
                        key={index}
                        className="pin-row consumer"
                        onMouseEnter={() => setHoveredClientId(pinClientId(pin))}
                        onMouseLeave={() => setHoveredClientId(null)}
                        onClick={() => {
                          const clientId = pinClientId(pin)
                          if (clientId) {
                            setSelectedClientId(clientId)
                            setInspectorSelection({ kind: 'client', clientId })
                          }
                        }}
                      >
                        {pinClientId(pin) ?? pin.owner}
                      </button>
                    ))
                  )}
                </div>
              </section>
              <section className="activity-section">
                <h3>Producer Pins</h3>
                <div className="activity-group">
                  {producerPins(selectedAddressedNode).length === 0 ? (
                    <small>none</small>
                  ) : (
                    producerPins(selectedAddressedNode).map((pin, index) => (
                      <span key={index} className="pin-row producer">{pin.owner}</span>
                    ))
                  )}
                </div>
              </section>
              <section className="activity-section">
                <h3>Item IDs</h3>
                <div className="item-list">
                  {selectedAddressedNode.itemIdsSample.map((itemId, index) => (
                    <span key={index}>{itemId}</span>
                  ))}
                  {segmentHiddenItemCount(selectedAddressedNode) > 0 && (
                    <span>+{segmentHiddenItemCount(selectedAddressedNode)} more</span>
                  )}
                </div>
              </section>
            </>
          ) : selectedAddressedNode.kind === 'resident' ? (
            <>
              <dl>
                <dt>resident bytes</dt>
                <dd>{formatBytes(selectedAddressedNode.estimatedResidentBytes)}</dd>
                <dt>address</dt>
                <dd>{selectedAddressedNode.address}</dd>
              </dl>
              <section className="activity-section">
                <h3>Pins</h3>
                <div className="activity-group">
                  {selectedAddressedNode.pins.length === 0 ? (
                    <small>none</small>
                  ) : (
                    selectedAddressedNode.pins.map((pin, index) => (
                      <span
                        key={index}
                        className={classes(
                          'pin-row',
                          pin.kind === 'display-view' && 'consumer',
                          pin.kind === 'display-producer' && 'producer',
                        )}
                      >
                        {pin.owner}
                      </span>
                    ))
                  )}
                </div>
              </section>
            </>
          ) : null}
        </>
      )
    }

    if (selectedInspectorClient) {
      return (
        <>
          <h3>{selectedInspectorClient.id}</h3>
          <dl>
            <dt>shape</dt>
            <dd>{selectedInspectorClient.shapeLabel}</dd>
            <dt>streams</dt>
            <dd>{selectedInspectorClient.subscriberCount}</dd>
            <dt>pinned segments</dt>
            <dd>{selectedInspectorClient.pinnedSegments.length}</dd>
            <dt>known pinned bytes</dt>
            <dd>{formatBytes(selectedInspectorClient.pinnedBytes)}</dd>
            <dt>last activity</dt>
            <dd>{formatTime(selectedInspectorClient.lastActivityAt)}</dd>
          </dl>
          <section className="activity-section">
            <h3>Consumer Pins</h3>
            <div className="activity-group">
              {selectedInspectorClient.pinnedSegments.map((pin, index) => (
                <button
                  key={index}
                  className="pin-row consumer"
                  onClick={() => setInspectorSelection({ kind: 'addressed', node: pin.node })}
                >
                  {pin.node.path.join(' / ')}
                </button>
              ))}
            </div>
          </section>
        </>
      )
    }

    if (selectedInspectorProjection) {
      const projection = selectedInspectorProjection
      return (
        <>
          <h3>{projection.name}</h3>
          <dl>
            <dt>kind</dt>
            <dd>{projection.kind}</dd>
            <dt>summary</dt>
            <dd>{projectionSummary(projection)}</dd>
            <dt>fork</dt>
            <dd>{projection.forkId ? shortId(projection.forkId) : 'global'}</dd>
          </dl>
          <button
            className="secondary-action"
            onClick={() => {
              setSelectedProjectionName(projection.name)
              setActiveTab('projections')
            }}
          >
            Inspect JSON
          </button>
        </>
      )
    }

    if (selectedIntrospection) {
      return (
        <>
          <h3>{selectedIntrospection.session.title}</h3>
          <dl>
            <dt>session</dt>
            <dd>{selectedIntrospection.session.sessionId}</dd>
            <dt>cwd</dt>
            <dd>{selectedIntrospection.session.cwd}</dd>
            <dt>updated</dt>
            <dd>{formatTime(selectedIntrospection.session.updatedAt)}</dd>
            <dt>view streams</dt>
            <dd>{displayViewSubscriberCount}</dd>
            <dt>producer pins</dt>
            <dd>{memoryStats.producerPinnedEntries}</dd>
          </dl>
        </>
      )
    }

    return <div className="empty">Select a live session</div>
  }

  const renderSessions = () => {
    if (loadingAcns) return <div className="empty">Scanning ACNs</div>
    if (!selectedAcn) return <div className="empty">No registered ACNs</div>
    if (!selectedAcn.introspection.ok) return <div className="empty">Introspection unavailable for {selectedAcn.version}</div>
    if (sessions.length === 0) return <div className="empty">No live sessions</div>
    return (
      <div className="session-list">
        {sessions.map((session) => (
          <button
            key={session.sessionId}
            className={classes(session.sessionId === selectedSessionId && 'selected')}
            onClick={() => setSelectedSessionId(session.sessionId)}
          >
            <strong>{session.title}</strong>
            <span>{shortId(session.sessionId)}</span>
            <small>{session.cwd}</small>
          </button>
        ))}
      </div>
    )
  }

  const renderClients = () => {
    if (!selectedIntrospection) return <div className="empty">Select a live session</div>
    if (clients.length === 0) return <div className="empty">No display clients</div>
    return (
      <div className="client-list">
        {clients.map((client) => (
          <button
            key={client.id}
            className={classes(activeClientId === client.id && 'active', selectedClientId === client.id && 'locked')}
            onMouseEnter={() => setHoveredClientId(client.id)}
            onMouseLeave={() => setHoveredClientId(null)}
            onClick={() => {
              setSelectedClientId(selectedClientId === client.id ? null : client.id)
              setInspectorSelection({ kind: 'client', clientId: client.id })
              setActiveTab('atlas')
            }}
          >
            <strong>{client.id}</strong>
            <span>{client.shapeLabel}</span>
            <small>{client.pinnedSegments.length} pinned · {formatBytes(client.pinnedBytes)} · {client.subscriberCount} stream{client.subscriberCount === 1 ? '' : 's'}</small>
          </button>
        ))}
      </div>
    )
  }

  return (
    <main>
      <header className="topbar">
        <div className="brand">
          <span className="mark"></span>
          <div>
            <h1>ACN Dashboard</h1>
            <p>{selectedAcn?.url ?? 'No ACN selected'}</p>
          </div>
        </div>

        <div className="controls">
          <select
            value={selectedVersion ?? ''}
            onChange={(event) => setSelectedVersion(event.target.value || null)}
            aria-label="ACN version"
          >
            {acns.map((acn) => (
              <option key={acn.version} value={acn.version}>{acn.version} · pid {acn.owner.pid}</option>
            ))}
          </select>
          <button className="icon-button" onClick={() => void fetchAcns()} aria-label="Refresh ACNs" title="Refresh ACNs">↻</button>
          <button className="danger" disabled={killingAcns} onClick={() => void killAllAcns()}>
            {killingAcns ? 'Killing' : 'Kill ACNs'}
          </button>
          <span className="status" data-state={streamState}>{streamState}</span>
        </div>
      </header>

      {error && <div className="banner">{error}</div>}
      {notice && <div className="notice">{notice}</div>}

      <section className="workspace">
        <aside className="sessions">
          <div className="pane-head">
            <h2>Sessions</h2>
            <span>{loadingSessions ? 'loading' : sessions.length}</span>
          </div>
          {renderSessions()}
        </aside>

        <aside className="clients">
          <div className="pane-head">
            <h2>Clients</h2>
            <span>{clients.length}</span>
          </div>
          {renderClients()}
        </aside>

        <section className="dashboard">
          <div className="summary-row">
            <div className="metric">
              <span>projections</span>
              <strong>{projections.length}</strong>
            </div>
            <div className="metric">
              <span>clients</span>
              <strong>{clients.length}</strong>
            </div>
            <div className="metric">
              <span>atlas bytes</span>
              <strong>{formatBytes(memoryStats.knownBytes)}</strong>
            </div>
            <div className="metric">
              <span>last updated</span>
              <strong>{formatTime(selectedIntrospection?.session.updatedAt)}</strong>
            </div>
            <div className="metric">
              <span>tokens</span>
              <strong>{agentIntrospection?.contextUsage?.currentTokens ?? 0}</strong>
            </div>
          </div>

          <nav className="tabs" aria-label="Dashboard views">
            <button className={classes(activeTab === 'atlas' && 'active')} onClick={() => setActiveTab('atlas')}>Memory Atlas</button>
            <button className={classes(activeTab === 'projections' && 'active')} onClick={() => setActiveTab('projections')}>Projections</button>
            <button className={classes(activeTab === 'rpc' && 'active')} onClick={() => setActiveTab('rpc')}>RPC / Activity</button>
          </nav>

          {activeTab === 'atlas' ? (
            <div className="atlas-layout">
              <section className="atlas-panel">
                <div className="map-head">
                  <div>
                    <h2>Memory / Pin Atlas</h2>
                    <span>{memoryStats.addressedRootCount} addressed roots · {formatBytes(memoryStats.projectionStateBytes)} state · {formatBytes(memoryStats.addressedBytes)} addressed · {memoryStats.loadedEntries} loaded · {memoryStats.offloadedEntries} offloaded</span>
                  </div>
                  <em>{activeClientId ? `highlighting ${activeClientId}` : 'all pins'}</em>
                </div>
                {projections.length === 0 ? (
                  <div className="empty">Waiting for introspection</div>
                ) : (
                  <MemoryAtlasCanvas
                    projections={projections}
                    addressedAtlas={addressedAtlas}
                    activeClientId={activeClientId}
                    onSelectNode={(node) => {
                      setInspectorSelection({ kind: 'addressed', node })
                    }}
                    onSelectProjection={(projectionName) => {
                      setInspectorSelection({ kind: 'projection', projectionName })
                    }}
                  />
                )}
              </section>

              <aside className="atlas-inspector">
                <div className="pane-head">
                  <h2>Inspector</h2>
                  <span>{selectedSession ? shortId(selectedSession.sessionId) : '-'}</span>
                </div>
                {renderInspector()}
              </aside>
            </div>
          ) : activeTab === 'projections' ? (
            <div className="projection-inspection">
              <aside className="projection-browser">
                <div className="pane-head">
                  <h2>Projections</h2>
                  <span>{projections.length}</span>
                </div>
                {projections.length === 0 ? (
                  <div className="empty">Waiting for projection state</div>
                ) : (
                  <div className="projection-list">
                    {projections.map((projection) => (
                      <button
                        key={projection.name}
                        className={classes(selectedProjection?.name === projection.name && 'selected')}
                        onClick={() => setSelectedProjectionName(projection.name)}
                      >
                        <strong>{projectionLabel(projection)}</strong>
                        <span>{projection.kind}</span>
                        <small>{projectionSummary(projection)}</small>
                      </button>
                    ))}
                  </div>
                )}
              </aside>

              <section className="json-panel">
                <div className="map-head">
                  <div>
                    <h2>Projection State</h2>
                    <span>{selectedProjection ? projectionSummary(selectedProjection) : 'none'}</span>
                  </div>
                  {selectedProjection && (
                    <em>{selectedProjection.kind}{selectedProjection.forkId ? ` · ${shortId(selectedProjection.forkId)}` : ''}</em>
                  )}
                </div>
                {selectedProjection ? (
                  <pre>{JSON.stringify(selectedProjection.state, null, 2)}</pre>
                ) : (
                  <div className="empty">Select a projection</div>
                )}
              </section>
            </div>
          ) : (
            <div className="rpc-layout">
              <section className="activity-panel">
                <div className="pane-head">
                  <h2>Commands</h2>
                  <span>{rpcCommands.length}</span>
                </div>
                <div className="activity-group padded">
                  {rpcTraceError && <div className="empty">{rpcTraceError}</div>}
                  {rpcCommands.map((trace) => traceLink(trace, 'command'))}
                </div>
              </section>
              <section className="activity-panel">
                <div className="pane-head">
                  <h2>Streams</h2>
                  <span>{rpcStreams.length}</span>
                </div>
                <div className="activity-group padded">
                  {rpcStreams.map((trace) => traceLink(trace, 'stream'))}
                </div>
              </section>
            </div>
          )}
        </section>
      </section>
    </main>
  )
}
