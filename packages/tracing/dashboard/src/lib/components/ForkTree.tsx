import { traceStore, useTraceStore } from '../stores/traces'

const modeColors: Record<string, string> = {
  root: 'var(--accent-blue)',
  clone: 'var(--accent-purple)',
  spawn: 'var(--accent-green)',
}

export function ForkTree() {
  const store = useTraceStore()

  function isSelected(forkId: string | null): boolean {
    if (store.selectedForkId === undefined) return false
    return store.selectedForkId === forkId
  }

  return (
    <div className="p-3">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-[var(--text-muted)]">Forks</h3>
        {store.selectedForkId !== undefined && (
          <button
            className="text-xs text-[var(--accent-blue)] hover:underline cursor-pointer"
            onClick={() => traceStore.clearSelection()}
          >
            Show all
          </button>
        )}
      </div>

      <div className="space-y-1">
        {store.forkTree.map((node) => (
          <button
            key={node.forkId ?? 'root'}
            className={`w-full text-left px-3 py-2 rounded text-sm transition-colors cursor-pointer ${isSelected(node.forkId) ? 'bg-[var(--bg-hover)] border border-[var(--accent-blue)]/40' : 'hover:bg-[var(--bg-hover)] border border-transparent'}`}
            onClick={() => traceStore.selectFork(node.forkId)}
          >
            <div className="flex items-center gap-2">
              <span
                className="w-2 h-2 rounded-full flex-shrink-0"
                style={{ background: modeColors[node.mode] || 'var(--text-muted)' }}
              ></span>
              <span className="font-mono text-xs truncate" title={node.forkId ?? 'root'}>{node.name}</span>
              {node.forkId && (
                <span className="text-[10px] text-[var(--text-muted)] font-mono truncate max-w-[80px]" title={node.forkId}>{node.forkId.slice(0, 8)}</span>
              )}
              <span className="ml-auto text-xs text-[var(--text-muted)]">{node.traceCount}</span>
            </div>
          </button>
        ))}
      </div>
    </div>
  )
}
