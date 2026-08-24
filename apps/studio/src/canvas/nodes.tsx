import type { ConstantNode, ModelNode, NoteNode, StockNode } from '@mindmap/engine'
import { Handle, type NodeProps, Position } from '@xyflow/react'
import { memo, useEffect, useRef, useState } from 'react'
import { bridge } from '../engine/bridge'
import { controller } from '../engine/controller'
import { useDoc } from '../store/doc'

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

function useBridgeRefs(id: string, fill?: { min: number; max: number }) {
  const root = useRef<HTMLDivElement>(null)
  const badge = useRef<HTMLDivElement>(null)
  const fillEl = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!root.current) return
    bridge.registerNode(id, {
      root: root.current,
      badge: badge.current,
      fill: fill && fillEl.current ? { el: fillEl.current, ...fill } : undefined,
    })
    controller.paintOnce()
    return () => bridge.unregisterNode(id)
  }, [id, fill])
  return { root, badge, fillEl }
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
  const { root, badge, fillEl } = useBridgeRefs(
    node.id,
    dial ? { min: dial.min, max: dial.max } : { min: 0, max: 200 },
  )
  return (
    <div ref={root} className={`mm-node stock ${selected ? 'selected' : ''}`}>
      <Handle type="target" id="pipe-in" position={Position.Left} className="pipe" />
      <Handle type="source" id="pipe-out" position={Position.Right} className="pipe" />
      <Handle type="target" id="wire-in" position={Position.Top} className="wire" />
      <Handle type="source" id="wire-out" position={Position.Bottom} className="wire" />
      <Head node={node} />
      <div ref={badge} className="badge">
        —
      </div>
      <div className="fill-bar" ref={fillEl}>
        <div />
      </div>
    </div>
  )
})

export const FlowNodeView = memo(({ data, selected }: NodeProps) => {
  const node = (data as Data).node
  const { root, badge } = useBridgeRefs(node.id)
  return (
    <div ref={root} className={`mm-node flow ${selected ? 'selected' : ''}`}>
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
  const { root, badge } = useBridgeRefs(node.id)
  return (
    <div ref={root} className={`mm-node variable ${selected ? 'selected' : ''}`}>
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
  const { root, badge } = useBridgeRefs(node.id)
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
          controller.setConstant(node.id, v) // live, no recompile
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
}
