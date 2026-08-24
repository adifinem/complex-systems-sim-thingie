import {
  type ConstantNode,
  checkCalls,
  DEFAULT_TIME_UNITS,
  type FlowNode,
  type ModelNode,
  type ModuleMode,
  type ModuleNode,
  ParseError,
  parse,
  type StockNode,
} from '@mindmap/engine'
import { useEffect, useMemo, useState } from 'react'
import { controller } from '../engine/controller'
import { currentGraph, useDoc } from '../store/doc'
import { crumbPrefix, useSimUi, useUi } from '../store/sim'
import { analyzeTrend, TREND_LABEL, type Trend } from '../trend'

/**
 * Right panel: full settings for the selected node. Formula edits parse live
 * (250ms debounce) and auto-apply to the document when locally valid; compile
 * errors from the engine surface underneath.
 */
export function Inspector() {
  const selectedId = useUi((s) => s.selectedNodeId)
  const model = useDoc((s) => s.model)
  const activeGraphId = useDoc((s) => s.activeGraphId)
  const graph = currentGraph({ model, activeGraphId } as Parameters<typeof currentGraph>[0])
  const node = graph.nodes.find((n) => n.id === selectedId)

  // Keyed so uncontrolled defaultValue fields refresh when another model loads.
  const docKey = useDoc((s) => `${s.fileName ?? 'unsaved'}:${s.model.meta?.name ?? ''}`)
  if (!node) return <SimSettings key={docKey} />
  return <NodePanel key={`${docKey}:${node.id}`} node={node} />
}

function SimSettings() {
  const sim = useDoc((s) => s.model.sim)
  const setSim = useDoc((s) => s.setSim)
  const warnings = useSimUi((s) => s.compileWarnings)
  const runtimeWarnings = useSimUi((s) => s.runtimeWarnings)
  return (
    <div className="inspector">
      <h3>Model settings</h3>
      <div className="type-tag">nothing selected</div>
      <label>dt (ticks per step)</label>
      <input
        type="number"
        step="0.01"
        min="0.001"
        defaultValue={sim?.dt ?? 0.1}
        onBlur={(e) => setSim({ dt: Number(e.target.value) || 0.1 })}
      />
      <label>random seed</label>
      <input
        type="number"
        defaultValue={sim?.seed ?? 1}
        onBlur={(e) => setSim({ seed: Number(e.target.value) || 1 })}
      />
      <div className="hint">
        Time units available:{' '}
        {Object.keys({ ...DEFAULT_TIME_UNITS, ...(sim?.timeUnits ?? {}) }).join(', ')}
      </div>
      {warnings.length > 0 && (
        <div className="warn-strip">
          {warnings.slice(0, 6).map((w) => (
            <div key={w.message}>{w.message}</div>
          ))}
        </div>
      )}
      {runtimeWarnings.length > 0 && (
        <div className="warn-strip">
          {runtimeWarnings.slice(0, 6).map((w) => (
            <div key={w}>{w}</div>
          ))}
        </div>
      )}
    </div>
  )
}

function NodePanel({ node }: { node: ModelNode }) {
  const updateNode = useDoc((s) => s.updateNode)
  const compileErrors = useSimUi((s) => s.compileErrors)
  const prefix = useUi((s) => crumbPrefix(s.breadcrumb))
  const path = prefix + node.id
  const myErrors = compileErrors.filter(
    (e) => e.path === path || e.path === node.id || e.path?.endsWith(`/${node.id}`),
  )

  const formulaField =
    node.type === 'stock'
      ? 'initial'
      : node.type === 'flow' || node.type === 'variable' || node.type === 'output'
        ? 'formula'
        : node.type === 'input'
          ? 'default'
          : null
  const formulaValue = formulaField
    ? ((node as unknown as Record<string, string | undefined>)[formulaField] ?? '')
    : ''

  return (
    <div className="inspector">
      <h3>{node.name ?? node.id}</h3>
      <div className="type-tag">
        {node.type} · id: {node.id}
      </div>

      <label>display name</label>
      <input
        type="text"
        defaultValue={node.name ?? node.id}
        onBlur={(e) => updateNode(node.id, { name: e.target.value })}
      />

      {formulaField && (
        <FormulaEditor
          key={`${node.id}:${formulaField}`}
          label={node.type === 'stock' ? 'initial value' : 'formula'}
          value={formulaValue}
          neighbors={useNeighborNames(node.id)}
          onApply={(src) => {
            updateNode(node.id, { [formulaField]: src } as Partial<ModelNode>)
            controller.markPerturbed(node.id)
          }}
        />
      )}

      {node.type === 'constant' && <ConstantFields node={node as ConstantNode} />}
      {node.type === 'stock' && (
        <>
          <label>capacity (max, blank = none)</label>
          <input
            type="number"
            step="any"
            defaultValue={(node as StockNode).max ?? ''}
            onBlur={(e) => {
              const v = Number(e.target.value)
              updateNode(node.id, {
                max: e.target.value === '' || !Number.isFinite(v) ? undefined : v,
              } as Partial<ModelNode>)
            }}
          />
        </>
      )}
      {node.type === 'stock' && (
        <div className="checkbox-row">
          <input
            id="nonneg"
            type="checkbox"
            checked={(node as StockNode).nonNegative ?? false}
            onChange={(e) => updateNode(node.id, { nonNegative: e.target.checked })}
          />
          <label htmlFor="nonneg" style={{ margin: 0 }}>
            non-negative (clamp at 0)
          </label>
        </div>
      )}
      {node.type === 'flow' && (
        <div className="checkbox-row">
          <input
            id="uniflow"
            type="checkbox"
            checked={(node as FlowNode).uniflow ?? false}
            onChange={(e) => updateNode(node.id, { uniflow: e.target.checked })}
          />
          <label htmlFor="uniflow" style={{ margin: 0 }}>
            uniflow (no negative rates)
          </label>
        </div>
      )}
      {node.type === 'note' && (
        <>
          <label>text</label>
          <textarea
            defaultValue={node.notes ?? ''}
            onBlur={(e) => updateNode(node.id, { notes: e.target.value })}
          />
        </>
      )}

      {node.type !== 'note' && <TimeFields node={node} />}
      {node.type !== 'note' && node.type !== 'constant' && <BaselineFields node={node} />}
      {node.type === 'stock' && <SetValueRow node={node} path={path} />}
      {(node.type === 'flow' || node.type === 'variable' || node.type === 'output') && (
        <PinRow node={node} path={path} />
      )}
      {node.type === 'module' && <ModulePanel node={node as ModuleNode} />}
      {node.type !== 'note' && node.type !== 'module' && <TrendChip path={path} />}

      {myErrors.length > 0 && (
        <div className="error-strip">
          {myErrors.map((e) => (
            <div key={e.message}>
              {e.message}
              {e.unknownName && <QuickFix name={e.unknownName} near={node} />}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

/** One-click fix for unknown identifiers: create the variable and wire it up. */
function QuickFix({ name, near }: { name: string; near: ModelNode }) {
  const addNamedNode = useDoc((s) => s.addNamedNode)
  return (
    <button
      type="button"
      className="quickfix"
      onClick={() =>
        addNamedNode('variable', name, {
          x: ((near.ui?.x as number) ?? 0) - 40,
          y: ((near.ui?.y as number) ?? 0) - 90,
        })
      }
    >
      + create variable "{name}"
    </button>
  )
}

/** Pin a computed node to a fixed value (engine override; formula preserved). */
function PinRow({ node, path }: { node: ModelNode; path: string }) {
  const [v, setV] = useState('')
  const [, forceRender] = useState(0)
  const pinned = controller.sim
    ? (() => {
        try {
          return controller.sim.getNode(path).overridden
        } catch {
          return false
        }
      })()
    : false
  return (
    <>
      <label>pin (override formula with a value)</label>
      <div className="row">
        <input
          type="number"
          step="any"
          placeholder={pinned ? 'pinned' : 'pin to value'}
          value={v}
          onChange={(e) => setV(e.target.value)}
        />
        <div style={{ flex: 0, display: 'flex', gap: 4 }}>
          <button
            type="button"
            className="mini"
            onClick={() => {
              const num = Number(v)
              if (Number.isFinite(num)) {
                controller.pinNode(path, num)
                forceRender((x) => x + 1)
              }
            }}
          >
            📌 pin
          </button>
          {pinned && (
            <button
              type="button"
              className="mini"
              onClick={() => {
                controller.unpinNode(path)
                forceRender((x) => x + 1)
              }}
            >
              release
            </button>
          )}
        </div>
      </div>
      <div className="hint">
        {pinned
          ? 'Pinned: formula suspended, inputs dormant. Release to watch the system respond.'
          : 'Pinning holds this node at a value while everything else keeps running.'}
      </div>
    </>
  )
}

/** Module settings: referenced graph, mode, and summary formulas per output. */
function ModulePanel({ node }: { node: ModuleNode }) {
  const model = useDoc((s) => s.model)
  const updateNode = useDoc((s) => s.updateNode)
  const refGraph = model.graphs[node.ref]
  const outputs = refGraph?.nodes.filter((n) => n.type === 'output') ?? []
  const graphIds = Object.keys(model.graphs)
  return (
    <>
      <label>references graph (tab)</label>
      <select
        value={node.ref}
        onChange={(e) => updateNode(node.id, { ref: e.target.value } as Partial<ModelNode>)}
      >
        {graphIds.map((gid) => (
          <option key={gid} value={gid}>
            {model.graphs[gid]?.name ?? gid}
          </option>
        ))}
      </select>
      <label>mode</label>
      <select
        value={node.mode ?? 'full'}
        onChange={(e) =>
          updateNode(node.id, { mode: e.target.value as ModuleMode } as Partial<ModelNode>)
        }
      >
        <option value="full">full — co-simulate the inner network</option>
        <option value="frozen">frozen — hold all values (pause this IC)</option>
        <option value="summary">summary — cheap formulas over inputs</option>
      </select>
      {(node.mode ?? 'full') === 'summary' &&
        outputs.map((o) => (
          <div key={o.id}>
            <label>summary for output "{o.id}" (in terms of input ports)</label>
            <textarea
              defaultValue={node.summary?.[o.id] ?? ''}
              spellCheck={false}
              onBlur={(e) =>
                updateNode(node.id, {
                  summary: { ...(node.summary ?? {}), [o.id]: e.target.value },
                } as Partial<ModelNode>)
              }
            />
          </div>
        ))}
      <div className="hint">Double-click the node to open its graph with live instance values.</div>
    </>
  )
}

/** Names the recent behavior: settling / steady / oscillating / runaway. */
function TrendChip({ path }: { path: string }) {
  const [trend, setTrend] = useState<Trend>('—')
  useEffect(() => {
    const update = () => {
      const sim = controller.sim
      if (!sim) return
      try {
        setTrend(analyzeTrend(sim.history(path, 512)))
      } catch {
        setTrend('—')
      }
    }
    update()
    const timer = setInterval(update, 1000)
    return () => clearInterval(timer)
  }, [path])
  return (
    <div className="trend-chip" title="Recent behavior, from the value history">
      {TREND_LABEL[trend]}
    </div>
  )
}

function useNeighborNames(nodeId: string): string[] {
  const model = useDoc((s) => s.model)
  const activeGraphId = useDoc((s) => s.activeGraphId)
  return useMemo(() => {
    const g = model.graphs[activeGraphId]
    if (!g) return []
    const names = new Set<string>()
    for (const e of g.edges) {
      if (e.to === nodeId) names.add(e.alias ?? e.from)
    }
    for (const n of g.nodes) {
      if (n.id !== nodeId && n.type !== 'note') names.add(n.id)
    }
    return [...names].slice(0, 14)
  }, [model, activeGraphId, nodeId])
}

function FormulaEditor({
  label,
  value,
  neighbors,
  onApply,
}: {
  label: string
  value: string
  neighbors: string[]
  onApply: (src: string) => void
}) {
  const [text, setText] = useState(value)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const timer = setTimeout(() => {
      if (text === value) return
      try {
        const ast = parse(text)
        checkCalls(ast)
        setError(null)
        onApply(text)
      } catch (e) {
        if (e instanceof ParseError) {
          setError(`${e.message} (at position ${e.pos})`)
        } else {
          setError(String(e))
        }
      }
    }, 300)
    return () => clearTimeout(timer)
  }, [text, value, onApply])

  return (
    <>
      <label>{label}</label>
      <textarea value={text} onChange={(e) => setText(e.target.value)} spellCheck={false} />
      {error && <div className="error-strip">{error}</div>}
      {neighbors.length > 0 && (
        <div className="chips">
          {neighbors.map((n) => (
            <button
              key={n}
              type="button"
              onClick={() => setText((t) => (t.trim() ? `${t} ${n}` : n))}
            >
              {n}
            </button>
          ))}
        </div>
      )}
    </>
  )
}

function ConstantFields({ node }: { node: ConstantNode }) {
  const updateNode = useDoc((s) => s.updateNode)
  const dial = node.dial ?? { min: 0, max: 10, step: 0.1 }
  return (
    <>
      <label>value</label>
      <input
        type="number"
        step="any"
        value={node.value}
        onChange={(e) => {
          const v = Number(e.target.value)
          if (Number.isFinite(v)) {
            updateNode(node.id, { value: v } as Partial<ModelNode>)
            controller.setConstant(node.id, v)
          }
        }}
      />
      <div className="row">
        <div>
          <label>dial min</label>
          <input
            type="number"
            step="any"
            defaultValue={dial.min}
            onBlur={(e) =>
              updateNode(node.id, {
                dial: { ...dial, min: Number(e.target.value) },
              } as Partial<ModelNode>)
            }
          />
        </div>
        <div>
          <label>dial max</label>
          <input
            type="number"
            step="any"
            defaultValue={dial.max}
            onBlur={(e) =>
              updateNode(node.id, {
                dial: { ...dial, max: Number(e.target.value) },
              } as Partial<ModelNode>)
            }
          />
        </div>
      </div>
    </>
  )
}

function TimeFields({ node }: { node: ModelNode }) {
  const updateNode = useDoc((s) => s.updateNode)
  const sim = useDoc((s) => s.model.sim)
  const units = Object.keys({ ...DEFAULT_TIME_UNITS, ...(sim?.timeUnits ?? {}) })
  const t = node.time ?? {}
  return (
    <div className="row">
      <div>
        <label>time unit</label>
        <select
          value={t.unit ?? 'tick'}
          onChange={(e) =>
            updateNode(node.id, {
              time: { ...t, unit: e.target.value === 'tick' ? undefined : e.target.value },
            })
          }
        >
          {units.map((u) => (
            <option key={u} value={u}>
              {u}
            </option>
          ))}
        </select>
      </div>
      <div>
        <label>update every (unit)</label>
        <input
          type="number"
          step="any"
          min="0"
          placeholder="every tick"
          defaultValue={typeof t.every === 'number' ? t.every : ''}
          onBlur={(e) => {
            const v = Number(e.target.value)
            updateNode(node.id, {
              time: { ...t, every: v > 0 ? v : undefined },
            })
          }}
        />
      </div>
    </div>
  )
}

function BaselineFields({ node }: { node: ModelNode }) {
  const updateNode = useDoc((s) => s.updateNode)
  const b = node.baseline ?? {}
  return (
    <>
      <div className="row">
        <div>
          <label>baseline mode</label>
          <select
            value={b.mode ?? 'initial'}
            onChange={(e) =>
              updateNode(node.id, {
                baseline: { ...b, mode: e.target.value as 'initial' | 'fixed' | 'ewma' },
              })
            }
          >
            <option value="initial">initial (stuck vs re-balanced)</option>
            <option value="ewma">running avg (still moving?)</option>
            <option value="fixed">fixed target</option>
          </select>
        </div>
        <div>
          <label>band (±% = full color)</label>
          <input
            type="number"
            step="0.05"
            min="0.01"
            defaultValue={b.band ?? 0.15}
            onBlur={(e) =>
              updateNode(node.id, {
                baseline: { ...b, band: Number(e.target.value) || 0.15 },
              })
            }
          />
        </div>
      </div>
      {b.mode === 'fixed' && (
        <>
          <label>fixed baseline value</label>
          <input
            type="number"
            step="any"
            defaultValue={b.value ?? 0}
            onBlur={(e) =>
              updateNode(node.id, { baseline: { ...b, value: Number(e.target.value) } })
            }
          />
        </>
      )}
      {b.mode === 'ewma' && (
        <>
          <label>averaging window τ (node units)</label>
          <input
            type="number"
            step="any"
            min="0.1"
            defaultValue={b.tau ?? 20}
            onBlur={(e) =>
              updateNode(node.id, { baseline: { ...b, tau: Number(e.target.value) || 20 } })
            }
          />
        </>
      )}
    </>
  )
}

function SetValueRow({ node, path }: { node: ModelNode; path: string }) {
  void node
  const [v, setV] = useState('')
  return (
    <>
      <label>set current value (perturb)</label>
      <div className="row">
        <input
          type="number"
          step="any"
          placeholder="new value"
          value={v}
          onChange={(e) => setV(e.target.value)}
        />
        <div style={{ flex: 0 }}>
          <button
            type="button"
            className="chips-apply"
            style={{
              background: '#22222c',
              color: 'var(--text)',
              border: '1px solid #2f2f3b',
              borderRadius: 6,
              padding: '6px 10px',
              cursor: 'pointer',
            }}
            onClick={() => {
              const num = Number(v)
              if (Number.isFinite(num)) controller.setStockValue(path, num)
            }}
          >
            set
          </button>
        </div>
      </div>
      <div className="hint">Writes into the running state — not the initial value.</div>
    </>
  )
}
