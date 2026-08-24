import type { FlowNode } from '@mindmap/engine'
import { currentGraph, useDoc } from '../store/doc'

/**
 * Hover-to-trace: after a short delay, light the hovered node gold along with
 * every node and edge on paths leading INTO and OUT OF it (full transitive
 * upstream + downstream within the current graph), and dim everything else.
 * Pure DOM class application — no React re-render, consistent with the
 * bridge's imperative-motion rule.
 */

const DELAY_MS = 380

let timer: ReturnType<typeof setTimeout> | undefined
let applied = false

export function scheduleTrace(nodeId: string): void {
  clearTimeout(timer)
  timer = setTimeout(() => applyTrace(nodeId), DELAY_MS)
}

export function cancelTrace(): void {
  clearTimeout(timer)
  if (applied) {
    for (const el of document.querySelectorAll('.hl-focus, .hl-path')) {
      el.classList.remove('hl-focus', 'hl-path')
    }
    for (const el of document.querySelectorAll('.hl-edge')) {
      el.classList.remove('hl-edge')
    }
    document.querySelector('.react-flow')?.classList.remove('hl-dim')
    applied = false
  }
}

interface Adj {
  /** directed edges: from → [{to, edgeId}] and reversed */
  out: Map<string, { to: string; edgeId: string }[]>
  rev: Map<string, { to: string; edgeId: string }[]>
}

function buildAdjacency(): Adj {
  const s = useDoc.getState()
  const graph = currentGraph(s)
  const out = new Map<string, { to: string; edgeId: string }[]>()
  const rev = new Map<string, { to: string; edgeId: string }[]>()
  const add = (map: Adj['out'], from: string, to: string, edgeId: string) => {
    let list = map.get(from)
    if (!list) {
      list = []
      map.set(from, list)
    }
    list.push({ to, edgeId })
  }
  const link = (from: string, to: string, edgeId: string) => {
    add(out, from, to, edgeId)
    add(rev, to, from, edgeId)
  }
  for (const e of graph.edges) link(e.from, e.to, e.id)
  for (const n of graph.nodes) {
    if (n.type !== 'flow') continue
    const f = n as FlowNode
    if (f.from) link(f.from, f.id, `pipe:${f.id}:from`)
    if (f.to) link(f.id, f.to, `pipe:${f.id}:to`)
  }
  return { out, rev }
}

function walk(start: string, map: Adj['out'], nodes: Set<string>, edges: Set<string>): void {
  const queue = [start]
  while (queue.length > 0) {
    const cur = queue.pop() as string
    for (const { to, edgeId } of map.get(cur) ?? []) {
      edges.add(edgeId)
      if (!nodes.has(to)) {
        nodes.add(to)
        queue.push(to)
      }
    }
  }
}

function applyTrace(nodeId: string): void {
  cancelTrace()
  const { out, rev } = buildAdjacency()
  // Separate visited sets per direction: a node reached downstream must not
  // block the upstream walk from continuing through it (and vice versa).
  const down = new Set<string>([nodeId])
  const up = new Set<string>([nodeId])
  const edges = new Set<string>()
  walk(nodeId, out, down, edges) // downstream
  walk(nodeId, rev, up, edges) // upstream
  const nodes = new Set<string>([...down, ...up])

  const root = document.querySelector('.react-flow')
  if (!root) return
  for (const id of nodes) {
    const el = root.querySelector(`.react-flow__node[data-id="${CSS.escape(id)}"]`)
    el?.classList.add(id === nodeId ? 'hl-focus' : 'hl-path')
  }
  for (const id of edges) {
    const el = root.querySelector(`.react-flow__edge[data-id="${CSS.escape(id)}"]`)
    el?.classList.add('hl-edge')
  }
  root.classList.add('hl-dim')
  applied = true
}
