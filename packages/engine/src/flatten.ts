/**
 * Compile-time flattening: instantiate module ("IC") nodes into one flat
 * node/edge list with per-instance namespaced paths ("m1/m2/node").
 *
 * - A tab is just a graph; a module node references a graph — cross-tab calls
 *   and IC-zoom are the same mechanism. Each module NODE is an independent
 *   instance with its own state.
 * - Ports: `input` nodes bind to outer link edges with toPort; `output` nodes
 *   are readable via outer edges with fromPort. Feedback THROUGH a module
 *   obeys the same cycle rules as flat graphs (everything is one topo sort).
 * - Modes: full (co-simulated) · frozen (instantiated but excluded from
 *   evaluation — the whole value table holds; nested modules inherit) ·
 *   summary (only input ports instantiated; each output becomes a variable
 *   evaluating the module's per-output summary formula).
 * - A module's own time.unit becomes its subtree's default unit (innermost
 *   override wins).
 */

import type { CompileIssue } from './compile'
import type { Graph, Model, ModelNode, ModuleNode } from './model'

export interface FlatNode {
  /** Full instance path, e.g. "price" or "econ/labor/wages". */
  path: string
  /** Instance prefix ("", "econ/", "econ/labor/") — sibling resolution scope. */
  prefix: string
  raw: ModelNode
  /** Inherited default time unit from enclosing modules. */
  unitDefault?: string
  frozen: boolean
  /** Synthetic formula replacing the node's own (bound inputs, summary outputs). */
  formulaOverride?: string
  /** `${graphId}:${nodeId}` — identifies the underlying document node. */
  sourceKey: string
}

export interface FlatEdge {
  id: string
  /** Source node path. */
  from: string
  /** Target node path. */
  to: string
  alias?: string
}

/** Alias used for the synthetic edge that binds an input port to its source. */
export const PORT_ALIAS = '__in'

export function flatten(
  model: Model,
  errors: CompileIssue[],
): { nodes: FlatNode[]; edges: FlatEdge[] } {
  const outNodes: FlatNode[] = []
  const outEdges: FlatEdge[] = []

  const err = (message: string, path?: string, edgeId?: string): void => {
    errors.push({ severity: 'error', message, path, edgeId })
  }

  const findNode = (g: Graph, id: string): ModelNode | undefined => g.nodes.find((n) => n.id === id)

  interface InstanceOpts {
    graphId: string
    prefix: string
    unitDefault?: string
    frozen: boolean
    trail: string[]
    /** input node id → source path (outer binding; edge already emitted). */
    bindings: Map<string, string>
    /** Non-null: summary mode — instantiate ports only. */
    summaryOf: ModuleNode | null
  }

  const instantiate = (opts: InstanceOpts): void => {
    const { graphId, prefix, unitDefault, frozen, trail, bindings, summaryOf } = opts
    const graph = model.graphs[graphId]
    if (!graph) {
      err(`module references unknown graph "${graphId}"`, prefix.replace(/\/$/, ''))
      return
    }
    if (trail.includes(graphId)) {
      err(
        `recursive module reference: ${[...trail, graphId].join(' → ')} — a graph cannot contain itself`,
        prefix.replace(/\/$/, ''),
      )
      return
    }
    const nextTrail = [...trail, graphId]

    if (summaryOf) {
      // Summary mode: inputs (so outer wiring still lights up) + one synthetic
      // output variable per output node, evaluating the user's summary formula.
      for (const n of graph.nodes) {
        if (n.type === 'input') {
          outNodes.push({
            path: `${prefix}${n.id}`,
            prefix,
            raw: n,
            unitDefault,
            frozen,
            formulaOverride: bindings.has(n.id) ? PORT_ALIAS : undefined,
            sourceKey: `${graphId}:${n.id}`,
          })
        } else if (n.type === 'output') {
          const formula = summaryOf.summary?.[n.id]
          if (formula === undefined) {
            err(
              `module "${prefix.replace(/\/$/, '')}" is in summary mode but has no summary formula for output "${n.id}"`,
              prefix.replace(/\/$/, ''),
            )
            continue
          }
          outNodes.push({
            path: `${prefix}${n.id}`,
            prefix,
            raw: n,
            unitDefault,
            frozen,
            formulaOverride: formula,
            sourceKey: `${graphId}:${n.id}`,
          })
        }
      }
      return
    }

    // Collect port bindings for each module in this graph from this graph's edges.
    const childBindings = new Map<string, Map<string, string>>()
    for (const n of graph.nodes) {
      if (n.type === 'module') childBindings.set(n.id, new Map())
    }

    interface PlainEdge {
      id: string
      from: string
      to: string
      alias?: string
    }
    const plainEdges: PlainEdge[] = []

    for (const e of graph.edges) {
      const fromNode = findNode(graph, e.from)
      const toNode = findNode(graph, e.to)
      if (!fromNode || !toNode) {
        err(
          `edge "${e.id}": ${!fromNode ? `unknown source "${e.from}"` : `unknown target "${e.to}"`}`,
          undefined,
          `${prefix}${e.id}`,
        )
        continue
      }
      // Resolve the value-source side of the edge to a path.
      let sourcePath: string
      if (fromNode.type === 'module') {
        if (!e.fromPort) {
          err(
            `edge "${e.id}": links from module "${e.from}" must name a fromPort (an output of its graph)`,
            e.from,
            `${prefix}${e.id}`,
          )
          continue
        }
        const refGraph = model.graphs[(fromNode as ModuleNode).ref]
        const port = refGraph ? findNode(refGraph, e.fromPort) : undefined
        if (!port || port.type !== 'output') {
          err(
            `edge "${e.id}": module "${e.from}" has no output port "${e.fromPort}"`,
            e.from,
            `${prefix}${e.id}`,
          )
          continue
        }
        sourcePath = `${prefix}${e.from}/${e.fromPort}`
      } else {
        sourcePath = `${prefix}${e.from}`
      }

      if (toNode.type === 'module') {
        if (!e.toPort) {
          err(
            `edge "${e.id}": links into module "${e.to}" must name a toPort (an input of its graph)`,
            e.to,
            `${prefix}${e.id}`,
          )
          continue
        }
        const refGraph = model.graphs[(toNode as ModuleNode).ref]
        const port = refGraph ? findNode(refGraph, e.toPort) : undefined
        if (!port || port.type !== 'input') {
          err(
            `edge "${e.id}": module "${e.to}" has no input port "${e.toPort}"`,
            e.to,
            `${prefix}${e.id}`,
          )
          continue
        }
        const binds = childBindings.get(e.to) as Map<string, string>
        if (binds.has(e.toPort)) {
          err(
            `edge "${e.id}": input port "${e.toPort}" of module "${e.to}" is bound twice — combine sources in a variable first`,
            e.to,
            `${prefix}${e.id}`,
          )
          continue
        }
        binds.set(e.toPort, sourcePath)
        outEdges.push({
          id: `${prefix}${e.id}`,
          from: sourcePath,
          to: `${prefix}${e.to}/${e.toPort}`,
          alias: PORT_ALIAS,
        })
      } else {
        plainEdges.push({
          id: `${prefix}${e.id}`,
          from: sourcePath,
          to: `${prefix}${e.to}`,
          // Module-sourced edges default their alias to the port name; plain
          // edges to the source id (may be shadowed by an explicit alias).
          alias: e.alias ?? (fromNode.type === 'module' ? e.fromPort : undefined),
        })
      }
    }

    for (const n of graph.nodes) {
      if (n.type === 'note') continue
      if (n.type === 'module') {
        const m = n as ModuleNode
        instantiate({
          graphId: m.ref,
          prefix: `${prefix}${m.id}/`,
          unitDefault: m.time?.unit ?? unitDefault,
          frozen: frozen || m.mode === 'frozen',
          trail: nextTrail,
          bindings: childBindings.get(m.id) as Map<string, string>,
          summaryOf: m.mode === 'summary' ? m : null,
        })
        continue
      }
      outNodes.push({
        path: `${prefix}${n.id}`,
        prefix,
        raw: n,
        unitDefault,
        frozen,
        formulaOverride: n.type === 'input' && bindings.has(n.id) ? PORT_ALIAS : undefined,
        sourceKey: `${graphId}:${n.id}`,
      })
    }

    for (const e of plainEdges) outEdges.push(e)
  }

  instantiate({
    graphId: model.mainGraph,
    prefix: '',
    unitDefault: undefined,
    frozen: false,
    trail: [],
    bindings: new Map(),
    summaryOf: null,
  })

  return { nodes: outNodes, edges: outEdges }
}
