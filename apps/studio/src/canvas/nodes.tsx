import type { ConstantNode, ModelNode, ModuleNode, NoteNode, StockNode } from '@mindmap/engine'
import { Handle, type NodeProps, Position } from '@xyflow/react'
import { memo, useEffect, useRef, useState } from 'react'
import { bridge } from '../engine/bridge'
import { controller } from '../engine/controller'
import { useDoc } from '../store/doc'
import { crumbPrefix, useUi } from '../store/sim'

/** Instance-path prefix for the canvas currently in view. */
function usePathPrefix(): string {
  return useUi((s) => crumbPrefix(s.breadcrumb))
}

/**
 * Node widgets. Memoized and inert during simulation: per-tick values arrive
 * imperatively via the AnimationBridge (refs registered on mount), never
 * through React props.
 */

type Data = { node: ModelNode }

const ICONS: Record<string, string> = {
  stock: '▭',
  flow: '⋈',
  variable: '◯',
  constant: '◉',
  note: '✎',
}

function useBridgeRefs(id: string, fill?: { min: number; max: number }, withSpark = false) {
  const prefix = usePathPrefix()
  const path = prefix + id
  const root = useRef<HTMLDivElement>(null)
  const badge = useRef<HTMLDivElement>(null)
  const fillEl = useRef<HTMLDivElement>(null)
  const spark = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    if (!root.current) return
    bridge.registerNode(path, {
      root: root.current,
      badge: badge.current,
      fill: fill && fillEl.current ? { el: fillEl.current, ...fill } : undefined,
      spark: withSpark ? (spark.current ?? undefined) : undefined,
    })
    controller.paintOnce()
    return () => bridge.unregisterNode(path)
  }, [path, fill, withSpark])

  // Hover info: value / baseline / trend, computed once on mouseenter.
  const onMouseEnter = () => {
    const sim = controller.sim
    if (!sim || !root.current) return
    try {
      const nv = sim.getNode(path)
      root.current.title = `${path}\nvalue ${nv.value.toPrecision(4)} · baseline ${nv.baseline.toPrecision(4)}\n${nv.overridden ? '📌 pinned · ' : ''}deviation ${nv.deviation.toFixed(2)}`
    } catch {
      root.current.title = `${path} (not simulated in this view)`
    }
  }
  return { root, badge, fillEl, spark, path, onMouseEnter }
}

function Head({ node }: { node: ModelNode }) {
  const unit = node.time?.unit
  const every = node.time?.every
  return (
    <>
      <div className="head">
        <span className="icon">{ICONS[node.type] ?? '?'}</span>
        <span className="name">{node.name ?? node.id}</span>
      </div>
      {(unit || every) && (
        <span className="unit-tag">
          {unit ? `/${unit.slice(0, 3)}` : ''}
          {every ? ` ⏲${typeof every === 'string' ? every.slice(0, 3) : every}` : ''}
        </span>
      )}
    </>
  )
}

export const StockNodeView = memo(({ data, selected }: NodeProps) => {
  const node = (data as Data).node as StockNode
  const dial = (node as unknown as { dial?: { min: number; max: number } }).dial
  const fillRange = node.max
    ? { min: 0, max: node.max }
    : dial
      ? { min: dial.min, max: dial.max }
      : { min: 0, max: 200 }
  const { root, badge, fillEl, spark, onMouseEnter } = useBridgeRefs(node.id, fillRange, true)
  return (
    <div
      ref={root}
      className={`mm-node stock ${selected ? 'selected' : ''}`}
      onMouseEnter={onMouseEnter}
    >
      <Handle type="target" id="pipe-in" position={Position.Left} className="pipe" />
      <Handle type="source" id="pipe-out" position={Position.Right} className="pipe" />
      <Handle type="target" id="wire-in" position={Position.Top} className="wire" />
      <Handle type="source" id="wire-out" position={Position.Bottom} className="wire" />
      <Head node={node} />
      <div ref={badge} className="badge">
        —
      </div>
      <canvas ref={spark} className="spark" width={140} height={20} />
      <div className="fill-bar" ref={fillEl}>
        <div />
      </div>
    </div>
  )
})

export const FlowNodeView = memo(({ data, selected }: NodeProps) => {
  const node = (data as Data).node
  const { root, badge, onMouseEnter } = useBridgeRefs(node.id)
  return (
    <div
      ref={root}
      className={`mm-node flow ${selected ? 'selected' : ''}`}
      onMouseEnter={onMouseEnter}
    >
      <Handle type="target" id="pipe-in" position={Position.Left} className="pipe" />
      <Handle type="source" id="pipe-out" position={Position.Right} className="pipe" />
      <Handle type="target" id="wire-in" position={Position.Top} className="wire" />
      <Handle type="source" id="wire-out" position={Position.Bottom} className="wire" />
      <Head node={node} />
      <div ref={badge} className="badge">
        —
      </div>
    </div>
  )
})

export const VariableNodeView = memo(({ data, selected }: NodeProps) => {
  const node = (data as Data).node
  const { root, badge, onMouseEnter } = useBridgeRefs(node.id)
  return (
    <div
      ref={root}
      className={`mm-node variable ${selected ? 'selected' : ''}`}
      onMouseEnter={onMouseEnter}
    >
      <Handle type="target" id="wire-in" position={Position.Top} className="wire" />
      <Handle type="source" id="wire-out" position={Position.Bottom} className="wire" />
      <Head node={node} />
      <div ref={badge} className="badge">
        —
      </div>
    </div>
  )
})

export const ConstantNodeView = memo(({ data, selected }: NodeProps) => {
  const node = (data as Data).node as ConstantNode
  const { root, badge, path } = useBridgeRefs(node.id)
  const updateNode = useDoc((s) => s.updateNode)
  const [live, setLive] = useState<number | null>(null)
  const dial = node.dial ?? { min: 0, max: Math.max(node.value * 2, 10), step: 0.1 }
  const shown = live ?? node.value
  return (
    <div ref={root} className={`mm-node constant ${selected ? 'selected' : ''}`}>
      <Handle type="source" id="wire-out" position={Position.Bottom} className="wire" />
      <Head node={node} />
      <div ref={badge} className="badge">
        {shown}
      </div>
      <input
        type="range"
        className="nodrag"
        min={dial.min}
        max={dial.max}
        step={dial.step ?? 0.1}
        value={shown}
        onChange={(e) => {
          const v = Number(e.target.value)
          setLive(v)
          controller.setConstant(path, v) // live, no recompile
        }}
        onPointerUp={() => {
          if (live !== null) {
            updateNode(node.id, { value: live } as Partial<ModelNode>)
            setLive(null)
          }
        }}
      />
    </div>
  )
})

/** Input/Output port pills, shown when editing a graph used as a module. */
export const InputNodeView = memo(({ data, selected }: NodeProps) => {
  const node = (data as Data).node
  const { root, badge } = useBridgeRefs(node.id)
  return (
    <div ref={root} className={`mm-node port-node ${selected ? 'selected' : ''}`}>
      <Handle type="source" id="wire-out" position={Position.Right} className="wire" />
      <div className="head">
        <span className="icon">⮕</span>
        <span className="name">{node.name ?? node.id}</span>
      </div>
      <div ref={badge} className="badge">
        —
      </div>
    </div>
  )
})

export const OutputNodeView = memo(({ data, selected }: NodeProps) => {
  const node = (data as Data).node
  const { root, badge } = useBridgeRefs(node.id)
  return (
    <div ref={root} className={`mm-node port-node out ${selected ? 'selected' : ''}`}>
      <Handle type="target" id="wire-in" position={Position.Left} className="wire" />
      <div className="head">
        <span className="name">{node.name ?? node.id}</span>
        <span className="icon">⮕</span>
      </div>
      <div ref={badge} className="badge">
        —
      </div>
    </div>
  )
})

/** The "IC" chip: pins from the referenced graph's input/output nodes. */
export const ModuleNodeView = memo(({ data, selected }: NodeProps) => {
  const node = (data as Data).node as ModuleNode
  const refGraph = useDoc((s) => s.model.graphs[node.ref])
  const prefix = usePathPrefix()
  const inputs = refGraph?.nodes.filter((n) => n.type === 'input') ?? []
  const outputs = refGraph?.nodes.filter((n) => n.type === 'output') ?? []
  const rows = Math.max(inputs.length, outputs.length, 1)

  // Port value badges are painted by the bridge, keyed by inner paths.
  const portRefs = useRef(new Map<string, HTMLElement>())
  useEffect(() => {
    for (const [path, el] of portRefs.current) {
      bridge.registerNode(path, { root: el, badge: el })
    }
    controller.paintOnce()
    const refs = portRefs.current
    return () => {
      for (const path of refs.keys()) bridge.unregisterNode(path)
    }
  }, [])

  return (
    <div className={`mm-node module ${selected ? 'selected' : ''}`}>
      <div className="head">
        <span className="icon">▣</span>
        <span className="name">{node.name ?? node.id}</span>
        <span className={`mode-badge ${node.mode ?? 'full'}`}>{node.mode ?? 'full'}</span>
      </div>
      <div className="pins" style={{ minHeight: rows * 20 }}>
        <div className="pin-col in">
          {inputs.map((p, i) => (
            <div key={p.id} className="pin" style={{ top: i * 20 }}>
              <Handle
                type="target"
                id={`port-in:${p.id}`}
                position={Position.Left}
                className="wire"
                style={{ top: 10 + i * 20 }}
              />
              <span className="pin-name">{p.id}</span>
              <span
                className="pin-val"
                ref={(el) => {
                  if (el) portRefs.current.set(`${prefix}${node.id}/${p.id}`, el)
                }}
              />
            </div>
          ))}
        </div>
        <div className="pin-col out">
          {outputs.map((p, i) => (
            <div key={p.id} className="pin" style={{ top: i * 20 }}>
              <span
                className="pin-val"
                ref={(el) => {
                  if (el) portRefs.current.set(`${prefix}${node.id}/${p.id}`, el)
                }}
              />
              <span className="pin-name">{p.id}</span>
              <Handle
                type="source"
                id={`port-out:${p.id}`}
                position={Position.Right}
                className="wire"
                style={{ top: 10 + i * 20 }}
              />
            </div>
          ))}
        </div>
      </div>
      <div className="hint-line">double-click to enter</div>
    </div>
  )
})

export const NoteNodeView = memo(({ data, selected }: NodeProps) => {
  const node = (data as Data).node as NoteNode
  return (
    <div className={`mm-node note ${selected ? 'selected' : ''}`}>
      <div className="head">
        <span className="icon">✎</span>
        <span className="name">{node.name ?? ''}</span>
      </div>
      <div className="body">{node.notes ?? ''}</div>
    </div>
  )
})

export const nodeTypes = {
  stock: StockNodeView,
  flow: FlowNodeView,
  variable: VariableNodeView,
  constant: ConstantNodeView,
  note: NoteNodeView,
  module: ModuleNodeView,
  input: InputNodeView,
  output: OutputNodeView,
}
