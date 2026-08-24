import type { FlowNode } from '@mindmap/engine'
import {
  applyNodeChanges,
  Background,
  BackgroundVariant,
  type Connection,
  Controls,
  type Edge,
  type EdgeChange,
  MiniMap,
  type Node,
  type NodeChange,
  ReactFlow,
  useReactFlow,
} from '@xyflow/react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { currentGraph, useDoc } from '../store/doc'
import { useUi } from '../store/sim'
import { edgeTypes } from './edges'
import { nodeTypes } from './nodes'

/**
 * Doc → React Flow projection. RF node objects live in local state (so RF's
 * dimension/measure bookkeeping via applyNodeChanges works — edges need
 * measured nodes); the document store stays the source of truth for
 * structure, and positions commit back to it on drag end.
 *
 * Pipes are not stored edges: they derive from each flow node's from/to
 * anchors. All handles are multi-connection (hypergraph): no limits anywhere.
 */
export function GraphCanvas() {
  const model = useDoc((s) => s.model)
  const activeGraphId = useDoc((s) => s.activeGraphId)
  const doc = useDoc()
  const select = useUi((s) => s.select)
  const { screenToFlowPosition } = useReactFlow()

  const graph = currentGraph({ model, activeGraphId } as Parameters<typeof currentGraph>[0])

  const typeOf = useMemo(() => {
    const m = new Map<string, string>()
    for (const n of graph.nodes) m.set(n.id, n.type)
    return m
  }, [graph.nodes])

  const [rfNodes, setRfNodes] = useState<Node[]>([])

  // Structure sync: rebuild RF nodes from the doc, preserving RF-internal
  // state (selection, measured size) for nodes that already exist.
  useEffect(() => {
    setRfNodes((prev) => {
      const prevById = new Map(prev.map((n) => [n.id, n]))
      return graph.nodes.map((n) => {
        const existing = prevById.get(n.id)
        const position = {
          x: (n.ui?.x as number | undefined) ?? 0,
          y: (n.ui?.y as number | undefined) ?? 0,
        }
        if (existing && existing.type === n.type) {
          return {
            ...existing,
            position: existing.dragging ? existing.position : position,
            data: { node: n },
          }
        }
        return { id: n.id, type: n.type, position, data: { node: n } }
      })
    })
  }, [graph.nodes])

  const rfEdges: Edge[] = useMemo(() => {
    const edges: Edge[] = []
    for (const n of graph.nodes) {
      if (n.type !== 'flow') continue
      const f = n as FlowNode
      if (f.from && typeOf.get(f.from) === 'stock') {
        edges.push({
          id: `pipe:${f.id}:from`,
          source: f.from,
          sourceHandle: 'pipe-out',
          target: f.id,
          targetHandle: 'pipe-in',
          type: 'pipe',
          data: { flowId: f.id },
        })
      }
      if (f.to && typeOf.get(f.to) === 'stock') {
        edges.push({
          id: `pipe:${f.id}:to`,
          source: f.id,
          sourceHandle: 'pipe-out',
          target: f.to,
          targetHandle: 'pipe-in',
          type: 'pipe',
          data: { flowId: f.id },
        })
      }
    }
    for (const e of graph.edges) {
      edges.push({
        id: e.id,
        source: e.from,
        sourceHandle: 'wire-out',
        target: e.to,
        targetHandle: 'wire-in',
        type: 'wire',
      })
    }
    return edges
  }, [graph, typeOf])

  const onNodesChange = useCallback(
    (changes: NodeChange[]) => {
      setRfNodes((nds) => applyNodeChanges(changes, nds))
      for (const ch of changes) {
        if (ch.type === 'position' && ch.dragging === false && ch.position) {
          doc.moveNode(ch.id, ch.position)
        } else if (ch.type === 'select') {
          if (ch.selected) select(ch.id)
          else if (useUi.getState().selectedNodeId === ch.id) select(null)
        } else if (ch.type === 'remove') {
          doc.deleteNodes([ch.id])
        }
      }
    },
    [doc, select],
  )

  const onEdgesChange = useCallback(
    (changes: EdgeChange[]) => {
      for (const ch of changes) {
        if (ch.type === 'remove') {
          if (ch.id.startsWith('pipe:')) {
            const [, flowId, side] = ch.id.split(':')
            doc.setFlowAnchor(flowId as string, side as 'from' | 'to', null)
          } else {
            doc.deleteEdges([ch.id])
          }
        } else if (ch.type === 'select' && ch.selected) {
          select(null, ch.id)
        }
      }
    },
    [doc, select],
  )

  const isValidConnection = useCallback(
    (conn: Connection | Edge) => {
      const sh = conn.sourceHandle ?? ''
      const th = conn.targetHandle ?? ''
      if (!conn.source || !conn.target || conn.source === conn.target) return false
      const pipeS = sh.startsWith('pipe')
      const pipeT = th.startsWith('pipe')
      if (pipeS !== pipeT) return false
      if (pipeS) {
        const s = typeOf.get(conn.source)
        const t = typeOf.get(conn.target)
        // stock↔flow joins pipes; stock→stock auto-inserts a flow on connect.
        return (s === 'stock' && (t === 'flow' || t === 'stock')) || (s === 'flow' && t === 'stock')
      }
      return true
    },
    [typeOf],
  )

  const onConnect = useCallback(
    (conn: Connection) => {
      if (!conn.source || !conn.target) return
      const sh = conn.sourceHandle ?? ''
      if (sh.startsWith('pipe')) {
        const s = typeOf.get(conn.source)
        const t = typeOf.get(conn.target)
        if (s === 'stock' && t === 'flow') {
          doc.setFlowAnchor(conn.target, 'from', conn.source)
        } else if (s === 'flow' && t === 'stock') {
          doc.setFlowAnchor(conn.source, 'to', conn.target)
        } else if (s === 'stock' && t === 'stock') {
          // Sketchability: dragging stock→stock materializes the flow between.
          const a = graph.nodes.find((n) => n.id === conn.source)
          const b = graph.nodes.find((n) => n.id === conn.target)
          const mid = {
            x: (((a?.ui?.x as number) ?? 0) + ((b?.ui?.x as number) ?? 0)) / 2,
            y: (((a?.ui?.y as number) ?? 0) + ((b?.ui?.y as number) ?? 0)) / 2 + 30,
          }
          const flowId = doc.addNode('flow', mid)
          doc.setFlowAnchor(flowId, 'from', conn.source)
          doc.setFlowAnchor(flowId, 'to', conn.target)
        }
      } else {
        doc.addLink(conn.source, conn.target)
      }
    },
    [doc, typeOf, graph.nodes],
  )

  return (
    <ReactFlow
      nodes={rfNodes}
      edges={rfEdges}
      nodeTypes={nodeTypes}
      edgeTypes={edgeTypes}
      onNodesChange={onNodesChange}
      onEdgesChange={onEdgesChange}
      onConnect={onConnect}
      isValidConnection={isValidConnection}
      onPaneClick={() => select(null)}
      deleteKeyCode={['Backspace', 'Delete']}
      minZoom={0.15}
      fitView
      proOptions={{ hideAttribution: true }}
      onDoubleClick={(e) => {
        // Sketchability: double-click empty canvas adds a variable at the cursor.
        if ((e.target as HTMLElement).classList.contains('react-flow__pane')) {
          doc.addNode('variable', screenToFlowPosition({ x: e.clientX, y: e.clientY }))
        }
      }}
    >
      <Background variant={BackgroundVariant.Dots} gap={22} size={1} color="#26262e" />
      <MiniMap
        pannable
        zoomable
        style={{ width: 140, height: 90 }}
        nodeColor="#33333e"
        maskColor="rgba(10,10,14,0.7)"
        bgColor="#101015"
      />
      <Controls showInteractive={false} />
    </ReactFlow>
  )
}
