import type { Graph, Model, ModelEdge, ModelNode, NodeType, SimConfig } from '@mindmap/engine'
import { temporal } from 'zundo'
import { create } from 'zustand'
import { thermostatDemo } from '../demo'

/**
 * The persistent document. Single source of truth; serializes 1:1 to the JSON
 * file format. `semanticVersion` bumps only on engine-relevant changes so the
 * controller can skip recompiles for pure layout edits.
 */
export interface DocState {
  model: Model
  activeGraphId: string
  /** Bumped on any change that affects simulation semantics. */
  semanticVersion: number
  /** models/<fileName>.json this document belongs to; null = unsaved. */
  fileName: string | null

  setFileName: (name: string | null) => void
  replaceModel: (model: Model, fileName?: string | null) => void
  addNode: (type: NodeType, pos: { x: number; y: number }, patch?: Partial<ModelNode>) => string
  /** Add a node with a caller-chosen id (quick-fix "create variable X"). */
  addNamedNode: (type: NodeType, id: string, pos: { x: number; y: number }) => boolean
  updateNode: (id: string, patch: Partial<ModelNode>) => void
  moveNode: (id: string, pos: { x: number; y: number }) => void
  deleteNodes: (ids: string[]) => void
  addLink: (from: string, to: string, ports?: { toPort?: string; fromPort?: string }) => void
  addLinks: (pairs: { from: string; to: string; toPort?: string; fromPort?: string }[]) => void
  /** Create a new empty graph (tab) and return its id. */
  addGraph: (withPorts?: boolean) => string
  setActiveGraph: (id: string) => void
  /** Add a module node; references `refGraph` or a freshly created graph. */
  addModuleNode: (pos: { x: number; y: number }, refGraph?: string) => string
  /** Paste a copied node into the active graph with a fresh id. Works across tabs. */
  pasteNode: (node: ModelNode, offset?: { x: number; y: number }) => string
  deleteEdges: (edgeIds: string[]) => void
  setFlowAnchor: (flowId: string, side: 'from' | 'to', stockId: string | null) => void
  setSim: (patch: Partial<SimConfig>) => void
}

const RUNNABLE_DEFAULTS: Record<string, Partial<ModelNode>> = {
  stock: { initial: '100' },
  flow: { formula: '1' },
  variable: { formula: '0' },
  constant: { value: 1, dial: { min: 0, max: 10, step: 0.1 } },
  note: { notes: 'note' },
  input: { default: '0' },
  output: { formula: '0' },
}

function activeGraph(model: Model, id: string): Graph {
  const g = model.graphs[id]
  if (!g) throw new Error(`no graph ${id}`)
  return g
}

/** Immutable update helpers keep the model JSON-shaped (no classes, no Maps). */
function withGraph(model: Model, graphId: string, fn: (g: Graph) => Graph): Model {
  return {
    ...model,
    graphs: { ...model.graphs, [graphId]: fn(activeGraph(model, graphId)) },
  }
}

export const useDoc = create<DocState>()(
  temporal(
    (set, get) => ({
      model: thermostatDemo,
      activeGraphId: thermostatDemo.mainGraph,
      semanticVersion: 0,
      fileName: null,

      setFileName: (name) => set({ fileName: name }),

      replaceModel: (model, fileName) =>
        set((s) => ({
          model,
          activeGraphId: model.mainGraph,
          semanticVersion: s.semanticVersion + 1,
          fileName: fileName === undefined ? s.fileName : fileName,
        })),

      addNode: (type, pos, patch) => {
        const { model, activeGraphId } = get()
        const g = activeGraph(model, activeGraphId)
        const base = type === 'stock' ? 'stock' : type === 'flow' ? 'flow' : type
        let n = 1
        let id = `${base}_${n}`
        const taken = new Set(g.nodes.map((x) => x.id))
        while (taken.has(id)) id = `${base}_${++n}`
        const node = {
          id,
          type,
          name: id.replace('_', ' '),
          ...RUNNABLE_DEFAULTS[type],
          ...(patch ?? {}),
          ui: { x: Math.round(pos.x), y: Math.round(pos.y) },
        } as unknown as ModelNode
        set((s) => ({
          model: withGraph(s.model, activeGraphId, (gr) => ({ ...gr, nodes: [...gr.nodes, node] })),
          semanticVersion: s.semanticVersion + 1,
        }))
        return id
      },

      addNamedNode: (type, id, pos) => {
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(id)) return false
        const { model, activeGraphId } = get()
        const g = activeGraph(model, activeGraphId)
        if (g.nodes.some((x) => x.id === id)) return false
        const node = {
          id,
          type,
          name: id.replace(/_/g, ' '),
          ...RUNNABLE_DEFAULTS[type],
          ui: { x: Math.round(pos.x), y: Math.round(pos.y) },
        } as unknown as ModelNode
        set((s) => ({
          model: withGraph(s.model, activeGraphId, (gr) => ({ ...gr, nodes: [...gr.nodes, node] })),
          semanticVersion: s.semanticVersion + 1,
        }))
        return true
      },

      updateNode: (id, patch) =>
        set((s) => ({
          model: withGraph(s.model, s.activeGraphId, (g) => ({
            ...g,
            nodes: g.nodes.map((n) => (n.id === id ? ({ ...n, ...patch } as ModelNode) : n)),
          })),
          semanticVersion: s.semanticVersion + 1,
        })),

      moveNode: (id, pos) =>
        set((s) => ({
          // layout-only: no semanticVersion bump
          model: withGraph(s.model, s.activeGraphId, (g) => ({
            ...g,
            nodes: g.nodes.map((n) =>
              n.id === id ? { ...n, ui: { ...(n.ui ?? {}), x: pos.x, y: pos.y } } : n,
            ),
          })),
        })),

      deleteNodes: (ids) => {
        const gone = new Set(ids)
        set((s) => ({
          model: withGraph(s.model, s.activeGraphId, (g) => ({
            ...g,
            nodes: g.nodes
              .filter((n) => !gone.has(n.id))
              .map((n) => {
                if (n.type !== 'flow') return n
                const from = n.from && gone.has(n.from) ? null : n.from
                const to = n.to && gone.has(n.to) ? null : n.to
                return from !== n.from || to !== n.to ? { ...n, from, to } : n
              }),
            edges: g.edges.filter((e) => !gone.has(e.from) && !gone.has(e.to)),
          })),
          semanticVersion: s.semanticVersion + 1,
        }))
      },

      addLink: (from, to, ports) => get().addLinks([{ from, to, ...ports }]),

      addLinks: (pairs) => {
        if (pairs.length === 0) return
        set((s) => ({
          model: withGraph(s.model, s.activeGraphId, (g) => {
            const keyOf = (e: { from: string; to: string; toPort?: string; fromPort?: string }) =>
              `${e.from}${e.fromPort ? `.${e.fromPort}` : ''}→${e.to}${e.toPort ? `.${e.toPort}` : ''}`
            const existing = new Set(g.edges.map(keyOf))
            const fresh: ModelEdge[] = []
            for (const pair of pairs) {
              const key = keyOf(pair)
              if (existing.has(key)) continue
              existing.add(key)
              let n = 1
              let id = `l_${pair.from}_${pair.to}`
              const ids = new Set([...g.edges.map((e) => e.id), ...fresh.map((e) => e.id)])
              while (ids.has(id)) id = `l_${pair.from}_${pair.to}_${++n}`
              fresh.push({
                id,
                type: 'link',
                from: pair.from,
                to: pair.to,
                ...(pair.toPort ? { toPort: pair.toPort } : {}),
                ...(pair.fromPort ? { fromPort: pair.fromPort } : {}),
              })
            }
            return fresh.length > 0 ? { ...g, edges: [...g.edges, ...fresh] } : g
          }),
          semanticVersion: s.semanticVersion + 1,
        }))
      },

      addGraph: (withPorts = true) => {
        const { model } = get()
        let n = 2
        let id = `graph_${n}`
        while (model.graphs[id]) id = `graph_${++n}`
        const nodes: ModelNode[] = withPorts
          ? [
              { id: 'in_1', type: 'input', name: 'in 1', default: '0', ui: { x: 60, y: 160 } },
              {
                id: 'out_1',
                type: 'output',
                name: 'out 1',
                formula: 'in_1',
                ui: { x: 420, y: 160 },
              },
            ]
          : []
        set((s) => ({
          model: {
            ...s.model,
            graphs: {
              ...s.model.graphs,
              [id]: {
                name: id,
                nodes,
                edges: withPorts
                  ? [{ id: 'l_in_out', type: 'link', from: 'in_1', to: 'out_1' }]
                  : [],
              },
            },
          },
          semanticVersion: s.semanticVersion + 1,
        }))
        return id
      },

      setActiveGraph: (id) => set({ activeGraphId: id }),

      addModuleNode: (pos, refGraph) => {
        const state = get()
        const ref =
          refGraph ??
          Object.keys(state.model.graphs).find((gid) => gid !== state.activeGraphId) ??
          state.addGraph(true)
        const { model, activeGraphId } = get()
        const g = activeGraph(model, activeGraphId)
        let n = 1
        let id = `module_${n}`
        const taken = new Set(g.nodes.map((x) => x.id))
        while (taken.has(id)) id = `module_${++n}`
        const node = {
          id,
          type: 'module',
          name: id.replace('_', ' '),
          ref,
          mode: 'full',
          ui: { x: Math.round(pos.x), y: Math.round(pos.y) },
        } as unknown as ModelNode
        set((s) => ({
          model: withGraph(s.model, activeGraphId, (gr) => ({
            ...gr,
            nodes: [...gr.nodes, node],
          })),
          semanticVersion: s.semanticVersion + 1,
        }))
        return id
      },

      deleteEdges: (edgeIds) => {
        const gone = new Set(edgeIds)
        set((s) => ({
          model: withGraph(s.model, s.activeGraphId, (g) => ({
            ...g,
            edges: g.edges.filter((e) => !gone.has(e.id)),
          })),
          semanticVersion: s.semanticVersion + 1,
        }))
      },

      setFlowAnchor: (flowId, side, stockId) =>
        set((s) => ({
          model: withGraph(s.model, s.activeGraphId, (g) => ({
            ...g,
            nodes: g.nodes.map((n) =>
              n.id === flowId && n.type === 'flow' ? { ...n, [side]: stockId } : n,
            ),
          })),
          semanticVersion: s.semanticVersion + 1,
        })),

      setSim: (patch) =>
        set((s) => ({
          model: { ...s.model, sim: { ...(s.model.sim ?? {}), ...patch } },
          semanticVersion: s.semanticVersion + 1,
        })),

      pasteNode: (source, offset = { x: 40, y: 40 }) => {
        const { model, activeGraphId } = get()
        const g = activeGraph(model, activeGraphId)
        const taken = new Set(g.nodes.map((x) => x.id))
        let n = 1
        let id = `${source.id}_copy`
        while (taken.has(id)) id = `${source.id}_copy${++n}`
        const clone = JSON.parse(JSON.stringify(source)) as ModelNode
        clone.id = id
        clone.name = `${source.name ?? source.id} copy`
        clone.ui = {
          ...(clone.ui ?? {}),
          x: (((source.ui?.x as number) ?? 0) + offset.x) | 0,
          y: (((source.ui?.y as number) ?? 0) + offset.y) | 0,
        }
        // Flow anchors only survive if the target graph has those stocks.
        if (clone.type === 'flow') {
          const has = (sid: string | null | undefined) =>
            sid != null && g.nodes.some((x) => x.id === sid && x.type === 'stock')
          clone.from = has(clone.from) ? clone.from : null
          clone.to = has(clone.to) ? clone.to : null
        }
        set((s) => ({
          model: withGraph(s.model, activeGraphId, (gr) => ({
            ...gr,
            nodes: [...gr.nodes, clone],
          })),
          semanticVersion: s.semanticVersion + 1,
        }))
        return id
      },
    }),
    {
      // Undo/redo covers the document only (model + which graph is open).
      // semanticVersion travels with it so the engine resyncs after undo;
      // transient sim/UI state never enters history.
      partialize: (s) => ({
        model: s.model,
        activeGraphId: s.activeGraphId,
        semanticVersion: s.semanticVersion,
        fileName: s.fileName,
      }),
      limit: 200,
    },
  ),
)

export function undoDoc(): void {
  useDoc.temporal.getState().undo()
}

export function redoDoc(): void {
  useDoc.temporal.getState().redo()
}

export function currentGraph(s: Pick<DocState, 'model' | 'activeGraphId'>): Graph {
  return activeGraph(s.model, s.activeGraphId)
}
