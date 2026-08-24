import type { ModuleNode } from '@mindmap/engine'
import { useReactFlow } from '@xyflow/react'
import { useEffect, useState } from 'react'
import { devColor } from '../color'
import { controller } from '../engine/controller'
import { useDoc } from '../store/doc'
import { type Crumb, useUi } from '../store/sim'

interface Row {
  path: string
  value: number
  baseline: number
  /** Percent displacement from baseline. */
  pct: number
  /** Engine tanh deviation, for coloring. */
  dev: number
}

/**
 * The symptom list: every stock/flow/variable across ALL module instances
 * whose value sits more than `threshold` percent away from its baseline,
 * sorted by displacement — the whole system's dysfunction at a glance
 * without opening each chip. Click a row to jump to the node.
 */
export function DeviationsPanel() {
  const show = useUi((s) => s.showDeviations)
  const [threshold, setThreshold] = useState(5)
  const [rows, setRows] = useState<Row[]>([])
  const [total, setTotal] = useState(0)

  useEffect(() => {
    if (!show) return
    const refresh = () => {
      const sim = controller.sim
      if (!sim) return
      const frame = sim.getFrame()
      const info = sim.info
      const out: Row[] = []
      for (let i = 0; i < info.paths.length; i++) {
        const type = info.types[i]
        // constants are causes (your dials), ports mirror inner nodes — skip both
        if (type === 'constant' || type === 'input' || type === 'output') continue
        const v = frame.values[i] as number
        const b = frame.baselines[i] as number
        const pct = ((v - b) / Math.max(Math.abs(b), 1)) * 100
        if (Math.abs(pct) >= threshold) {
          out.push({
            path: info.paths[i] as string,
            value: v,
            baseline: b,
            pct,
            dev: frame.deviations[i] as number,
          })
        }
      }
      out.sort((a, b) => Math.abs(b.pct) - Math.abs(a.pct))
      setTotal(out.length)
      setRows(out.slice(0, 60))
    }
    refresh()
    const timer = setInterval(refresh, 500)
    return () => clearInterval(timer)
  }, [show, threshold])

  if (!show) return null
  return (
    <div className="dev-panel">
      <div className="dev-head">
        <span className="title">Δ from baseline</span>
        <input
          type="number"
          min={0}
          step={1}
          value={threshold}
          onChange={(e) => setThreshold(Math.max(0, Number(e.target.value) || 0))}
          title="Show nodes at least this % away from their baseline"
        />
        <span className="pct-label">%</span>
        <button type="button" title="Close" onClick={() => useUi.getState().toggleDeviations()}>
          ×
        </button>
      </div>
      {rows.length === 0 ? (
        <div className="dev-empty">nothing beyond ±{threshold}% — system at baseline</div>
      ) : (
        <div className="dev-rows">
          {rows.map((r) => (
            <DevRow key={r.path} row={r} />
          ))}
          {total > rows.length && <div className="dev-more">…and {total - rows.length} more</div>}
        </div>
      )}
    </div>
  )
}

function DevRow({ row }: { row: Row }) {
  const jump = useJumpToPath()
  const segs = row.path.split('/')
  const nodeId = segs[segs.length - 1] as string
  const where = segs.slice(0, -1).join('/')
  return (
    <button type="button" className="dev-row" onClick={() => jump(row.path)} title={row.path}>
      <span className="dev-pct" style={{ color: devColor(row.dev) }}>
        {fmtDisplacement(row)}
      </span>
      <span className="dev-name">
        {nodeId}
        {where && <span className="dev-where"> · {where}</span>}
      </span>
      <span className="dev-vals">
        {fmtShort(row.value)} <span className="dev-base">vs {fmtShort(row.baseline)}</span>
      </span>
    </button>
  )
}

/** Near-zero baselines make percentages absurd — show absolute Δ instead. */
function fmtDisplacement(row: Row): string {
  const sign = row.pct > 0 ? '+' : '−'
  if (Math.abs(row.baseline) < 1) return `Δ${sign}${fmtShort(Math.abs(row.value - row.baseline))}`
  const a = Math.abs(row.pct)
  if (a > 999) return `${sign}999%+`
  return `${sign}${a >= 100 ? a.toFixed(0) : a.toFixed(1)}%`
}

function fmtShort(v: number): string {
  const a = Math.abs(v)
  if (a >= 1000) return v.toFixed(0)
  if (a >= 10) return v.toFixed(1)
  return v.toFixed(2)
}

/** Navigate to a flattened instance path: set breadcrumb, select, center. */
function useJumpToPath() {
  const { setCenter } = useReactFlow()
  return (path: string) => {
    const doc = useDoc.getState()
    const ui = useUi.getState()
    const segs = path.split('/')
    const nodeId = segs.pop() as string
    const crumbs: Crumb[] = []
    let graphId = doc.model.mainGraph
    for (const moduleId of segs) {
      const m = doc.model.graphs[graphId]?.nodes.find(
        (n) => n.id === moduleId && n.type === 'module',
      ) as ModuleNode | undefined
      if (!m) break
      crumbs.push({ moduleId, graphId: m.ref })
      graphId = m.ref
    }
    ui.setCrumbs(crumbs)
    doc.setActiveGraph(graphId)
    ui.select(nodeId)
    const node = doc.model.graphs[graphId]?.nodes.find((n) => n.id === nodeId)
    if (node?.ui) {
      setTimeout(() => {
        setCenter(((node.ui?.x as number) ?? 0) + 80, ((node.ui?.y as number) ?? 0) + 30, {
          zoom: 1.1,
          duration: 400,
        })
      }, 60)
    }
  }
}
