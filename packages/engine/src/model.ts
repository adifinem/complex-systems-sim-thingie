/**
 * Model document types — the persistent, hand-editable JSON schema (version 1).
 * Everything the engine needs lives here; `ui` blocks are opaque layout data.
 */

export type NodeType =
  | 'stock'
  | 'flow'
  | 'variable'
  | 'constant'
  | 'module'
  | 'input'
  | 'output'
  | 'note'

export interface BaselineConfig {
  mode?: 'initial' | 'fixed' | 'ewma'
  /** Baseline value for mode 'fixed'. */
  value?: number
  /** EWMA time constant, in the node's own time unit. */
  tau?: number
  /** Relative deviation treated as full saturation (default 0.15 = 15%). */
  band?: number
  /** Denominator floor so a zero baseline doesn't divide by zero. */
  absFloor?: number
}

export interface TimeConfig {
  /** Named unit from sim.timeUnits — scopes rates, taus and time builtins of this node. */
  unit?: string
  /**
   * Sample-and-hold cadence: re-evaluate only this often, hold the value between.
   * A number is measured in the node's own unit; a string names one whole unit
   * (e.g. "hour" = every hour). Omit = evaluate every tick.
   */
  every?: number | string
}

export interface NodeBase {
  id: string
  type: NodeType
  /** Display label; `id` is the formula-visible name. */
  name?: string
  notes?: string
  time?: TimeConfig
  baseline?: BaselineConfig
  /** Opaque layout/appearance data owned by the UI. */
  ui?: Record<string, unknown>
}

export interface StockNode extends NodeBase {
  type: 'stock'
  /** Formula evaluated at reset. */
  initial: string
  nonNegative?: boolean
  /**
   * Capacity: post-integration clamp (the tub stops at the rim). Like
   * nonNegative, inflow rates can report more than actually entered while
   * the clamp engages.
   */
  max?: number
}

export interface FlowNode extends NodeBase {
  type: 'flow'
  formula: string
  /** Stock id (same graph) or null/absent = cloud (boundary). */
  from?: string | null
  to?: string | null
  /** Clamp negative rates to zero. */
  uniflow?: boolean
}

export interface VariableNode extends NodeBase {
  type: 'variable'
  formula: string
}

export interface ConstantNode extends NodeBase {
  type: 'constant'
  value: number
  /** Reset-to-default target for the widget's ⟲ control. */
  default?: number
  dial?: { min: number; max: number; step?: number }
}

export type ModuleMode = 'full' | 'frozen' | 'summary'

export interface ModuleNode extends NodeBase {
  type: 'module'
  /** Graph id this module instantiates. */
  ref: string
  mode?: ModuleMode
  /** Per-output-port summary formulas (mode 'summary'). */
  summary?: Record<string, string>
}

export interface InputNode extends NodeBase {
  type: 'input'
  /** Value when the graph runs standalone (unbound). */
  default?: string
}

export interface OutputNode extends NodeBase {
  type: 'output'
  formula: string
}

export interface NoteNode extends NodeBase {
  type: 'note'
}

export type ModelNode =
  | StockNode
  | FlowNode
  | VariableNode
  | ConstantNode
  | ModuleNode
  | InputNode
  | OutputNode
  | NoteNode

export interface LinkEdge {
  id: string
  type: 'link'
  /** Source node id, or (post-MVP) instance path. */
  from: string
  /** Target node id, or (post-MVP) instance path. */
  to: string
  /** Name the source is visible under in the target's formula (default: source id). */
  alias?: string
  /** When the target is a module: bind to this input port. */
  toPort?: string
  /** When the source is a module: read this output port. */
  fromPort?: string
  ui?: Record<string, unknown>
}

export type ModelEdge = LinkEdge

export interface Graph {
  name?: string
  nodes: ModelNode[]
  edges: ModelEdge[]
}

export interface SimConfig {
  /** Step size, in ticks. */
  dt?: number
  seed?: number
  /** Named time units as ratios to one tick. "tick" (=1) is always available. */
  timeUnits?: Record<string, number>
  baselineDefault?: BaselineConfig
  /** Ring-buffer length for per-node history (ticks). */
  historyLength?: number
}

export interface Model {
  version: 1
  meta?: { name?: string; notes?: string }
  sim?: SimConfig
  mainGraph: string
  graphs: Record<string, Graph>
}

export const DEFAULT_TIME_UNITS: Record<string, number> = {
  tick: 1,
  second: 1,
  minute: 60,
  hour: 3600,
  day: 86400,
  week: 604800,
}

export const DEFAULT_SIM: Required<Omit<SimConfig, 'timeUnits' | 'baselineDefault'>> & {
  timeUnits: Record<string, number>
  baselineDefault: Required<Pick<BaselineConfig, 'mode' | 'band' | 'absFloor'>> & BaselineConfig
} = {
  dt: 0.1,
  seed: 1,
  historyLength: 2048,
  timeUnits: DEFAULT_TIME_UNITS,
  baselineDefault: { mode: 'initial', band: 0.15, absFloor: 1e-3 },
}

export interface ModelIssue {
  severity: 'error' | 'warning'
  message: string
  graphId?: string
  nodeId?: string
  edgeId?: string
}

/** Structural validation of a parsed JSON document. Formula errors surface at compile. */
export function validateModel(doc: unknown): { model?: Model; issues: ModelIssue[] } {
  const issues: ModelIssue[] = []
  const err = (message: string, where: Partial<ModelIssue> = {}) =>
    issues.push({ severity: 'error', message, ...where })

  if (typeof doc !== 'object' || doc === null) {
    err('model must be a JSON object')
    return { issues }
  }
  const m = doc as Record<string, unknown>
  if (m.version !== 1) err(`unsupported model version: ${String(m.version)} (expected 1)`)
  if (typeof m.mainGraph !== 'string') err('missing "mainGraph" (graph id string)')
  if (typeof m.graphs !== 'object' || m.graphs === null) {
    err('missing "graphs" object')
    return { issues }
  }
  const graphs = m.graphs as Record<string, unknown>
  if (typeof m.mainGraph === 'string' && !(m.mainGraph in graphs)) {
    err(`mainGraph "${m.mainGraph}" not found in graphs`)
  }

  const identRe = /^[A-Za-z_][A-Za-z0-9_]*$/
  for (const [graphId, g0] of Object.entries(graphs)) {
    if (typeof g0 !== 'object' || g0 === null) {
      err('graph must be an object', { graphId })
      continue
    }
    const g = g0 as Record<string, unknown>
    const nodes = Array.isArray(g.nodes) ? (g.nodes as Record<string, unknown>[]) : undefined
    const edges = Array.isArray(g.edges) ? (g.edges as Record<string, unknown>[]) : []
    if (!nodes) {
      err('graph.nodes must be an array', { graphId })
      continue
    }
    const seen = new Set<string>()
    for (const n of nodes) {
      const nodeId = typeof n.id === 'string' ? n.id : undefined
      if (!nodeId) {
        err('node missing string "id"', { graphId })
        continue
      }
      if (!identRe.test(nodeId)) {
        err(`node id "${nodeId}" must be a valid identifier (letters, digits, _)`, {
          graphId,
          nodeId,
        })
      }
      if (seen.has(nodeId)) err(`duplicate node id "${nodeId}"`, { graphId, nodeId })
      seen.add(nodeId)
      const type = n.type as string
      const need = (field: string, kind: 'string' | 'number') => {
        if (typeof n[field] !== kind) {
          err(`${type} node requires ${kind} "${field}"`, { graphId, nodeId })
        }
      }
      switch (type) {
        case 'stock':
          need('initial', 'string')
          break
        case 'flow':
        case 'variable':
        case 'output':
          need('formula', 'string')
          break
        case 'constant':
          need('value', 'number')
          break
        case 'module':
          need('ref', 'string')
          break
        case 'input':
        case 'note':
          break
        default:
          err(`unknown node type "${String(type)}"`, { graphId, nodeId })
      }
    }
    const seenEdges = new Set<string>()
    for (const e of edges) {
      const edgeId = typeof e.id === 'string' ? e.id : undefined
      if (!edgeId || typeof e.from !== 'string' || typeof e.to !== 'string') {
        err('edge requires string "id", "from", "to"', { graphId, edgeId })
        continue
      }
      if (seenEdges.has(edgeId)) err(`duplicate edge id "${edgeId}"`, { graphId, edgeId })
      seenEdges.add(edgeId)
    }
  }

  if (issues.some((i) => i.severity === 'error')) return { issues }
  return { model: doc as unknown as Model, issues }
}
