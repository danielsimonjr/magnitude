import type { DashboardExperiment, DashboardRun, DashboardRunDetail } from "@magnitudedev/inference-benchmark"
import { useEffect, useRef, useState } from "react"

interface AnalysisView {
  trialId: string
  measuredRequests: number
  validRequests: number
  responsivenessMs?: { median?: number }
  prefillTokensPerSecond?: { median?: number }
  decodeTokensPerSecond?: { median?: number }
  memory?: { peakBytes?: number; peakDeviceBytes?: Record<string, number> }
}
interface EvaluationView { block: number; target: string; analyses: AnalysisView[] }

function evaluations(result: unknown): EvaluationView[] {
  const value = result as { blocks?: Array<{ index?: number; comparison?: { results?: Array<{ target?: { id?: string }; analyses?: AnalysisView[] }> } }> } | null
  return value?.blocks?.flatMap(block => block.comparison?.results?.map(evaluation => ({
    block: block.index ?? 0,
    target: evaluation.target?.id ?? "unknown",
    analyses: evaluation.analyses ?? [],
  })) ?? []) ?? []
}

const metric = (value: number | undefined) => value === undefined ? "—" : value.toFixed(2)
const memory = (analysis: AnalysisView) => {
  const bytes = analysis.memory?.peakDeviceBytes
    ? Object.values(analysis.memory.peakDeviceBytes).reduce((sum, value) => sum + value, 0)
    : analysis.memory?.peakBytes
  return bytes === undefined ? "—" : `${(bytes / 1024 ** 3).toFixed(2)} GiB`
}

async function json<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init)
  if (!response.ok) throw new Error(await response.text())
  return response.json()
}

const message = (cause: unknown) => cause instanceof Error ? cause.message : String(cause)

export function App() {
  const [experiments, setExperiments] = useState<DashboardExperiment[]>([])
  const [runs, setRuns] = useState<DashboardRun[]>([])
  const [selected, setSelected] = useState<DashboardRunDetail | null>(null)
  const [busy, setBusy] = useState("")
  const [error, setError] = useState("")
  // Mirrors `selected` so the polling loop can re-fetch the current run without re-arming the interval.
  const selectedRef = useRef<DashboardRunDetail | null>(null)
  selectedRef.current = selected

  useEffect(() => { document.title = "Inference Benchmarks" }, [])

  async function refresh() {
    try {
      const [nextExperiments, nextRuns] = await Promise.all([
        json<DashboardExperiment[]>("/api/experiments"),
        json<DashboardRun[]>("/api/runs"),
      ])
      setExperiments(nextExperiments)
      setRuns(nextRuns)
      const current = selectedRef.current
      if (current) setSelected(await json<DashboardRunDetail>(`/api/runs/${current.run.runId}`))
      setError("")
    } catch (cause) { setError(message(cause)) }
  }

  async function action(id: string, action: "prepare" | "runs") {
    setBusy(`${id}-${action}`)
    try { await json(`/api/experiments/${id}/${action}`, { method: "POST" }); await refresh() }
    catch (cause) { setError(message(cause)) }
    finally { setBusy("") }
  }

  async function selectRun(run: DashboardRun) {
    setSelected(await json<DashboardRunDetail>(`/api/runs/${run.runId}`))
  }

  async function cancel(run: DashboardRun) {
    await json(`/api/runs/${run.runId}/cancel`, { method: "POST" })
    await refresh()
  }

  useEffect(() => {
    void refresh()
    const interval = setInterval(() => void refresh(), 1500)
    return () => clearInterval(interval)
  }, [])

  return (
    <main className="min-h-screen p-8">
      <header className="mb-8 flex items-end justify-between border-b border-zinc-800 pb-5">
        <div><div className="text-xs uppercase tracking-[.28em] text-emerald-400">Magnitude</div><h1 className="mt-1 text-3xl font-semibold">Inference Benchmarks</h1></div>
        <div className="text-sm text-zinc-500">Filesystem-backed · local machine</div>
      </header>
      {error && <div className="mb-5 rounded border border-red-800 bg-red-950/40 p-3 text-sm text-red-300">{error}</div>}

      <section className="mb-10">
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wider text-zinc-400">Experiments</h2>
        <div className="grid grid-cols-2 gap-4">
          {experiments.map(experiment => (
            <article key={experiment.id} className="rounded-lg border border-zinc-800 bg-zinc-900/60 p-5">
              <div className="flex justify-between gap-4"><div><h3 className="font-medium">{experiment.title}</h3><div className="mt-1 font-mono text-xs text-zinc-500">{experiment.id}</div></div><span className={`text-xs text-amber-400${experiment.prepared ? " !text-emerald-400" : ""}`}>{experiment.prepared ? "prepared" : "not prepared"}</span></div>
              <div className="mt-4 grid grid-cols-4 gap-2 text-xs text-zinc-400">
                <div><span className="block text-zinc-600">Profile</span>{experiment.profile}</div>
                <div><span className="block text-zinc-600">Context</span>{experiment.requestPolicy.contextTokensPerSequence.toLocaleString()}</div>
                <div><span className="block text-zinc-600">Sequences</span>{experiment.requestPolicy.parallelSequences}</div>
                <div><span className="block text-zinc-600">Blocks</span>{experiment.execution.blocks} · {experiment.execution.variantOrder}</div>
              </div>
              <div className="my-4 space-y-2">{experiment.variants.map(variant => <div key={variant.id} className="rounded bg-zinc-800 px-3 py-2 text-xs"><div>{variant.id} · {variant.engine} · {variant.artifact.quantization}</div><div className="mt-1 truncate font-mono text-zinc-500" title={`${variant.artifact.repository}@${variant.artifact.revision}`}>{variant.artifact.repository}@{variant.artifact.revision.slice(0, 12)}</div></div>)}</div>
              <div className="flex gap-2"><button className="rounded border border-zinc-700 px-3 py-2 text-sm hover:bg-zinc-800" onClick={() => void action(experiment.id, "prepare")} disabled={!!busy}>Prepare</button><button className="rounded bg-emerald-500 px-3 py-2 text-sm font-medium text-black disabled:opacity-40" onClick={() => void action(experiment.id, "runs")} disabled={!experiment.prepared || !!busy}>Start run</button></div>
            </article>
          ))}
        </div>
      </section>

      <section className="grid grid-cols-[420px_1fr] gap-5">
        <div><h2 className="mb-3 text-sm font-semibold uppercase tracking-wider text-zinc-400">Runs</h2><div className="overflow-hidden rounded-lg border border-zinc-800">{runs.map(run => <button key={run.runId} className="block w-full border-b border-zinc-800 p-4 text-left hover:bg-zinc-900" onClick={() => void selectRun(run)}><div className="flex justify-between"><span className="font-mono text-xs">{run.runId}</span><span className={`text-xs${run.state === "completed" ? " text-emerald-400" : ""}${run.state === "running" ? " text-amber-400" : ""}`}>{run.state}</span></div><div className="mt-2 text-sm text-zinc-400">{run.experimentId}</div></button>)}</div></div>
        <div><h2 className="mb-3 text-sm font-semibold uppercase tracking-wider text-zinc-400">Run detail</h2>{selected ? <article className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-5"><div className="mb-4 flex items-center justify-between"><div><div className="font-mono text-sm">{selected.run.runId}</div><div className="text-xs text-zinc-500">{selected.run.startedAt}</div></div>{selected.run.state === "running" && <button className="rounded border border-red-800 px-3 py-2 text-sm text-red-300" onClick={() => void cancel(selected.run)}>Cancel</button>}</div>
          {selected.result ? (
            <>
              <h3 className="mb-2 text-xs uppercase tracking-wider text-zinc-500">Measurements</h3>
              {evaluations(selected.result).map((evaluation, index) => (
                <div key={index} className="mb-4 overflow-hidden rounded border border-zinc-800"><div className="bg-zinc-800/60 px-3 py-2 text-xs font-medium">Block {evaluation.block} · {evaluation.target}</div><table className="w-full text-xs"><thead className="text-zinc-500"><tr><th className="p-2 text-left">Trial</th><th>Measured</th><th>Valid</th><th>TTFT ms</th><th>Prefill tok/s</th><th>Decode tok/s</th><th>Peak</th></tr></thead><tbody>{evaluation.analyses.map(analysis => <tr key={analysis.trialId} className="border-t border-zinc-800"><td className="p-2 font-mono">{analysis.trialId}</td><td className="text-center">{analysis.measuredRequests}</td><td className="text-center">{analysis.validRequests}</td><td className="text-center">{metric(analysis.responsivenessMs?.median)}</td><td className="text-center">{metric(analysis.prefillTokensPerSecond?.median)}</td><td className="text-center">{metric(analysis.decodeTokensPerSecond?.median)}</td><td className="text-center">{memory(analysis)}</td></tr>)}</tbody></table></div>
              ))}
            </>
          ) : null}
          <h3 className="mb-2 mt-5 text-xs uppercase tracking-wider text-zinc-500">Live events</h3><pre className="max-h-72 overflow-auto rounded bg-black/40 p-3 text-xs text-zinc-300">{selected.events.map(event => JSON.stringify(event)).join("\n")}</pre>
          <details className="mt-4"><summary className="text-xs uppercase tracking-wider text-zinc-500">Resolved manifest</summary><pre className="mt-2 max-h-96 overflow-auto rounded bg-black/40 p-3 text-xs text-zinc-300">{JSON.stringify(selected.manifest, null, 2)}</pre></details>
          {selected.result ? <details className="mt-4"><summary className="text-xs uppercase tracking-wider text-zinc-500">Raw result</summary><pre className="mt-2 max-h-96 overflow-auto rounded bg-black/40 p-3 text-xs text-zinc-300">{JSON.stringify(selected.result, null, 2)}</pre></details> : null}
        </article> : <div className="rounded-lg border border-dashed border-zinc-800 p-12 text-center text-zinc-600">Select a run</div>}</div>
      </section>
    </main>
  )
}
