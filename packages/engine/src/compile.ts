/**
 * Compile a Model into a flat, topologically-ordered program.
 *
 * - Stocks and constants are sources: reads see start-of-tick values, so edges
 *   out of them never constrain evaluation order — feedback loops through
 *   stocks work by construction.
 * - Cycles among computed nodes (variables/flows/outputs) are a compile error
 *   unless broken by a history builtin (delay/smooth/previous/…), whose first
 *   argument's refs are `historyRefs` and excluded from ordering.
 * - Compilation never touches run state: a bad edit is rejected atomically.
 */

import { type FlatNode, flatten } from './flatten'
import { checkCalls } from './interp'
import {
  type BaselineConfig,
  DEFAULT_SIM,
  DEFAULT_TIME_UNITS,
  type FlowNode,
  type Model,
  type ModelNode,
} from './model'
import { type Ast, collectRefs, collectStatefulCalls, ParseError } from './parser/ast'
import { parse } from './parser/parser'

export interface CompileIssue {
  severity: 'error' | 'warning'
  message: string
  /** Node path the issue is anchored to, if any. */
  path?: string
  edgeId?: string
  /** Character offset into the offending formula, if any. */
  pos?: number
  /** Which formula field the pos refers to. */
  field?: 'formula' | 'initial' | 'default'
  /** Structured payload for "sibling referenced without a link edge" warnings, so a UI can auto-create the edge. */
  missingLink?: { from: string; to: string }
  /** Structured payload for unknown-name errors, so a UI can offer a quick-fix ("create variable X"). */
  unknownName?: string
}

export interface ResolvedBaseline {
  mode: 'initial' | 'fixed' | 'ewma'
  fixedValue: number
  /** EWMA coefficient per tick, pre-clamped to [0,1]. */
  ewmaK: number
  band: number
  absFloor: number
}

export interface CompiledNode {
  slot: number
  path: string
  type: ModelNode['type']
  name: string
  /** Runtime formula AST (flow/variable/input/output). */
  ast: Ast | null
  /** Initial-value AST (stocks). */
  initAst: Ast | null
  /** Ticks per one of this node's time units. */
  ratio: number
  /** Sample-and-hold interval in ticks; 0 = evaluate every tick. */
  everyTicks: number
  baseline: ResolvedBaseline
  uniflow: boolean
  nonNegative: boolean
  /** Constant value (type 'constant'). */
  constValue: number
  /** Inbound link-edge indices (for readSet → edgeActive resets). */
  inEdges: number[]
  /**
   * Verbatim source of the runtime formula (or stock initial). Snapshots carry
   * it per stateful call site so restore can tell "same formula → keep state
   * verbatim" from "edited formula → re-sample taus".
   */
  formulaSrc: string
  /** Instance prefix ("", "econ/") — sibling references resolve inside it. */
  instancePrefix: string
  /** Frozen module member: initialized but excluded from evaluation. */
  frozen: boolean
  /** `${graphId}:${nodeId}` of the underlying document node (shared across instances). */
  sourceKey: string
}

export interface CompiledEdge {
  idx: number
  id: string
  from: string
  to: string
  alias: string
  sourceSlot: number
  targetSlot: number
}

export interface StockFlowRef {
  /** Flow node slot. */
  slot: number
  /** Multiply the flow's value by this to get stock-units per tick (dt/ratio). */
  scale: number
}

export interface CompiledStock {
  slot: number
  nonNegative: boolean
  frozen: boolean
  inflows: StockFlowRef[]
  outflows: StockFlowRef[]
}

export type RecordKind = 'delay' | 'delay1' | 'delay3' | 'smooth' | 'previous'

export interface RecordEntry {
  callSiteId: string
  fn: RecordKind
  /** Input expression (recorded against start-of-tick values). */
  argAst: Ast
  /** Tau expression (delay-family/smooth); evaluated at prime time. */
  tauAst: Ast | null
  /** Optional explicit initial-value expression. */
  initAst: Ast | null
  /** Slot of the node owning the formula (supplies time unit + call-site prefix). */
  nodeSlot: number
  /** Frozen nodes stop recording (their delay/smooth histories hold). */
  frozen: boolean
}

export interface InitStep {
  slot: number
  /** Evaluate this AST and store into values[slot]. */
  ast: Ast
}

export interface Compiled {
  model: Model
  dt: number
  seed: number
  historyLength: number
  timeUnits: Record<string, number>
  paths: string[]
  slotOf: Map<string, number>
  nodes: CompiledNode[]
  /** Slots of computed nodes (flows/variables/inputs/outputs) in evaluation order. */
  evalOrder: number[]
  /** Steps that produce all values at t=0, in dependency order. */
  initOrder: InitStep[]
  stocks: CompiledStock[]
  recordEntries: RecordEntry[]
  edges: CompiledEdge[]
  edgeIndexOf: Map<string, number>
  warnings: CompileIssue[]
}

export type CompileResult =
  | { ok: true; compiled: Compiled; warnings: CompileIssue[] }
  | { ok: false; errors: CompileIssue[]; warnings: CompileIssue[] }

const COMPUTED_TYPES = new Set(['flow', 'variable', 'input', 'output'])

export function compile(model: Model): CompileResult {
  const errors: CompileIssue[] = []
  const warnings: CompileIssue[] = []

  const sim = model.sim ?? {}
  const dt = sim.dt ?? DEFAULT_SIM.dt
  if (!(dt > 0) || !Number.isFinite(dt)) {
    errors.push({ severity: 'error', message: `sim.dt must be a positive number (got ${dt})` })
    return { ok: false, errors, warnings }
  }
  const historyLength = sim.historyLength ?? DEFAULT_SIM.historyLength
  if (!Number.isInteger(historyLength) || historyLength < 2) {
    errors.push({
      severity: 'error',
      message: `sim.historyLength must be an integer ≥ 2 (got ${historyLength})`,
    })
    return { ok: false, errors, warnings }
  }
  const timeUnits: Record<string, number> = {
    ...DEFAULT_TIME_UNITS,
    ...(sim.timeUnits ?? {}),
    tick: 1,
  }
  for (const [name, ratio] of Object.entries(timeUnits)) {
    if (!(ratio > 0) || !Number.isFinite(ratio)) {
      errors.push({ severity: 'error', message: `time unit "${name}" must be a positive ratio` })
    }
  }

  if (!model.graphs[model.mainGraph]) {
    errors.push({ severity: 'error', message: `mainGraph "${model.mainGraph}" not found` })
    return { ok: false, errors, warnings }
  }

  // ---- flatten modules, then assign slots ----
  const { nodes: flatNodes, edges: flatEdges } = flatten(model, errors)
  if (errors.length > 0) return { ok: false, errors, warnings }

  const nodes: CompiledNode[] = []
  const slotOf = new Map<string, number>()
  const paths: string[] = []
  const flatBySlot: FlatNode[] = []
  const baselineDefault = { ...DEFAULT_SIM.baselineDefault, ...(sim.baselineDefault ?? {}) }

  for (const fn of flatNodes) {
    const n = fn.raw
    if (slotOf.has(fn.path)) continue // duplicate ids reported by validateModel
    const slot = nodes.length
    slotOf.set(fn.path, slot)
    paths.push(fn.path)
    flatBySlot.push(fn)

    const unitName = n.time?.unit ?? fn.unitDefault ?? 'tick'
    const ratio = timeUnits[unitName]
    if (ratio === undefined) {
      errors.push({
        severity: 'error',
        message: `node "${fn.path}": unknown time unit "${unitName}"`,
        path: fn.path,
      })
    }
    let everyTicks = 0
    if (n.time?.every !== undefined) {
      const every = n.time.every
      if (typeof every === 'string') {
        const r = timeUnits[every]
        if (r === undefined) {
          errors.push({
            severity: 'error',
            message: `node "${fn.path}": unknown time unit "${every}" in time.every`,
            path: fn.path,
          })
        } else everyTicks = r
      } else if (typeof every === 'number' && every > 0) {
        everyTicks = every * (ratio ?? 1)
      } else {
        errors.push({
          severity: 'error',
          message: `node "${fn.path}": time.every must be a positive number or unit name`,
          path: fn.path,
        })
      }
      if (everyTicks > 0 && everyTicks < dt) {
        warnings.push({
          severity: 'warning',
          message: `node "${fn.path}": time.every (${everyTicks} ticks) is shorter than dt (${dt}) — treating it as every-tick`,
          path: fn.path,
        })
        everyTicks = 0 // behavior matches the message exactly
      }
    }

    nodes.push({
      slot,
      path: fn.path,
      type: n.type,
      name: n.name ?? n.id,
      ast: null,
      initAst: null,
      ratio: ratio ?? 1,
      everyTicks,
      baseline: resolveBaseline(n.baseline, baselineDefault, ratio ?? 1, dt),
      uniflow: n.type === 'flow' ? (n.uniflow ?? false) : false,
      nonNegative: n.type === 'stock' ? (n.nonNegative ?? false) : false,
      constValue: n.type === 'constant' ? n.value : 0,
      inEdges: [],
      formulaSrc: '',
      instancePrefix: fn.prefix,
      frozen: fn.frozen,
      sourceKey: fn.sourceKey,
    })
  }

  // ---- parse formulas ----
  const parseInto = (
    slot: number,
    src: string,
    field: 'formula' | 'initial' | 'default',
  ): Ast | null => {
    const node = nodes[slot] as CompiledNode
    node.formulaSrc = src
    try {
      const ast = parse(src)
      checkCalls(ast)
      return ast
    } catch (e) {
      if (e instanceof ParseError) {
        errors.push({
          severity: 'error',
          message: `node "${node.path}" ${field}: ${e.message}`,
          path: node.path,
          pos: e.pos,
          field,
        })
        return null
      }
      throw e
    }
  }

  for (const fn of flatBySlot) {
    const slot = slotOf.get(fn.path)
    if (slot === undefined) continue
    const cn = nodes[slot] as CompiledNode
    const n = fn.raw
    switch (n.type) {
      case 'stock':
        cn.initAst = parseInto(slot, n.initial, 'initial')
        if (cn.initAst && collectStatefulCalls(cn.initAst).length > 0) {
          errors.push({
            severity: 'error',
            message: `node "${fn.path}": stateful builtins (delay/smooth/…) are not allowed in initial values`,
            path: fn.path,
            field: 'initial',
          })
        }
        break
      case 'flow':
      case 'variable':
        cn.ast = parseInto(slot, fn.formulaOverride ?? n.formula, 'formula')
        break
      case 'output':
        cn.ast = parseInto(slot, fn.formulaOverride ?? n.formula, 'formula')
        break
      case 'input':
        cn.ast = parseInto(slot, fn.formulaOverride ?? n.default ?? '0', 'default')
        break
      case 'constant':
        break
      default:
        break
    }
  }

  // ---- edges ----
  const edges: CompiledEdge[] = []

  /** targetSlot → alias → edge idx */
  const aliasMaps = new Map<number, Map<string, number>>()

  for (const e of flatEdges) {
    const sourceSlot = slotOf.get(e.from)
    const targetSlot = slotOf.get(e.to)
    if (sourceSlot === undefined || targetSlot === undefined) {
      errors.push({
        severity: 'error',
        message: `edge "${e.id}": ${sourceSlot === undefined ? `unknown source "${e.from}"` : `unknown target "${e.to}"`}`,
        edgeId: e.id,
      })
      continue
    }
    const alias = e.alias ?? (e.from.split('/').pop() as string)
    let aliasMap = aliasMaps.get(targetSlot)
    if (!aliasMap) {
      aliasMap = new Map()
      aliasMaps.set(targetSlot, aliasMap)
    }
    if (aliasMap.has(alias)) {
      errors.push({
        severity: 'error',
        message: `edge "${e.id}": duplicate alias "${alias}" on node "${e.to}" — rename one link's alias`,
        edgeId: e.id,
      })
      continue
    }
    if (alias === e.to) {
      warnings.push({
        severity: 'warning',
        message: `edge "${e.id}": alias "${alias}" equals the target's own id — inside "${e.to}" that name now refers to "${e.from}", which is confusing; rename the alias`,
        edgeId: e.id,
      })
    }
    const idx = edges.length
    aliasMap.set(alias, idx)
    edges.push({ idx, id: e.id, from: e.from, to: e.to, alias, sourceSlot, targetSlot })
    ;(nodes[targetSlot] as CompiledNode).inEdges.push(idx)
  }

  // ---- flow anchors ----
  const stocks: CompiledStock[] = []
  const stockBySlot = new Map<number, CompiledStock>()
  for (const cn of nodes) {
    if (cn.type !== 'stock') continue
    const s: CompiledStock = {
      slot: cn.slot,
      nonNegative: cn.nonNegative,
      frozen: cn.frozen,
      inflows: [],
      outflows: [],
    }
    stocks.push(s)
    stockBySlot.set(cn.slot, s)
  }
  for (const fn of flatBySlot) {
    if (fn.raw.type !== 'flow') continue
    const f = fn.raw as FlowNode
    const slot = slotOf.get(fn.path)
    if (slot === undefined) continue
    const scale = dt / (nodes[slot] as CompiledNode).ratio
    for (const [anchor, list] of [
      [f.from, 'outflows'],
      [f.to, 'inflows'],
    ] as const) {
      if (anchor === undefined || anchor === null) continue
      const stockSlot = slotOf.get(`${fn.prefix}${anchor}`)
      const stock = stockSlot !== undefined ? stockBySlot.get(stockSlot) : undefined
      if (!stock) {
        errors.push({
          severity: 'error',
          message: `flow "${fn.path}": ${list === 'outflows' ? 'from' : 'to'} must reference a stock (got "${anchor}")`,
          path: fn.path,
        })
        continue
      }
      stock[list].push({ slot, scale })
    }
  }
  for (const s of stocks) {
    if (s.nonNegative && s.outflows.length >= 2) {
      warnings.push({
        severity: 'warning',
        message: `stock "${(nodes[s.slot] as CompiledNode).path}": nonNegative with ${s.outflows.length} outflows — when the clamp engages, reported outflow rates can exceed what actually left the stock`,
        path: (nodes[s.slot] as CompiledNode).path,
      })
    }
  }

  // ---- reference resolution ----
  // Scope per target node: link alias → sibling id → specials (t, dt, pi, e).
  const missingLinkSeen = new Set<string>()
  const resolveAst = (
    cn: CompiledNode,
    ast: Ast,
    field: 'formula' | 'initial' | 'default',
  ): void => {
    const aliasMap = aliasMaps.get(cn.slot)
    const walk = (a: Ast): void => {
      switch (a.kind) {
        case 'num':
          return
        case 'ref': {
          const edgeIdx = aliasMap?.get(a.name)
          if (edgeIdx !== undefined) {
            a.slot = (edges[edgeIdx] as CompiledEdge).sourceSlot
            a.edgeIdx = edgeIdx
            return
          }
          const sibling = slotOf.get(cn.instancePrefix + a.name)
          if (sibling !== undefined) {
            a.slot = sibling
            a.edgeIdx = -1
            const key = `${a.name}→${cn.path}`
            if (cn.instancePrefix + a.name !== cn.path && !missingLinkSeen.has(key)) {
              missingLinkSeen.add(key)
              warnings.push({
                severity: 'warning',
                message: `node "${cn.path}" references "${a.name}" without a link edge — the UI should create one`,
                path: cn.path,
                pos: a.pos,
                // Structured auto-create payload only for the root scope; the
                // UI edits the active (root) graph's edge list.
                ...(cn.instancePrefix === '' ? { missingLink: { from: a.name, to: cn.path } } : {}),
              })
            }
            return
          }
          if (a.name === 't') {
            a.slot = -2
            return
          }
          if (a.name === 'dt') {
            a.slot = -3
            return
          }
          if (a.name === 'pi') {
            a.slot = -4
            return
          }
          if (a.name === 'e') {
            a.slot = -5
            return
          }
          // Suggest scope-local names: aliases + siblings in this instance.
          const prefixLen = cn.instancePrefix.length
          const known = [
            ...(aliasMap?.keys() ?? []),
            ...[...slotOf.keys()]
              .filter((p) => p.startsWith(cn.instancePrefix) && !p.includes('/', prefixLen))
              .map((p) => p.slice(prefixLen)),
          ]
          const suggestion = suggest(a.name, known)
          errors.push({
            severity: 'error',
            message: `node "${cn.path}" ${field}: unknown name "${a.name}"${suggestion ? ` — did you mean "${suggestion}"?` : ''}`,
            path: cn.path,
            pos: a.pos,
            field,
            unknownName: a.name,
          })
          a.slot = -1
          return
        }
        case 'un':
          walk(a.e)
          return
        case 'bin':
          walk(a.l)
          walk(a.r)
          return
        case 'if':
          walk(a.cond)
          walk(a.then)
          walk(a.else)
          return
        case 'call':
          for (const arg of a.args) walk(arg)
          return
      }
    }
    walk(ast)
  }

  for (const cn of nodes) {
    if (cn.ast) resolveAst(cn, cn.ast, 'formula')
    if (cn.initAst) resolveAst(cn, cn.initAst, 'initial')
  }

  if (errors.length > 0) return { ok: false, errors, warnings }

  // ---- dependency graphs ----
  const isComputed = (slot: number) => COMPUTED_TYPES.has((nodes[slot] as CompiledNode).type)

  /** For each computed node: computed slots it must run after (this tick). */
  const orderDeps = new Map<number, Set<number>>()
  /** For init: slot → slots (computed or stock) it must run after. */
  const initDeps = new Map<number, Set<number>>()

  const refsBySlot = new Map<number, { orderRefs: Set<string>; historyRefs: Set<string> }>()
  for (const cn of nodes) {
    if (cn.ast) refsBySlot.set(cn.slot, collectRefs(cn.ast))
  }

  const slotOfName = (cn: CompiledNode, name: string): number | undefined => {
    const aliasMap = aliasMaps.get(cn.slot)
    const edgeIdx = aliasMap?.get(name)
    if (edgeIdx !== undefined) return (edges[edgeIdx] as CompiledEdge).sourceSlot
    return slotOf.get(cn.instancePrefix + name)
  }

  for (const cn of nodes) {
    if (!cn.ast || !isComputed(cn.slot)) continue
    const deps = new Set<number>()
    const initD = new Set<number>()
    const addInitDep = (name: string) => {
      const s = slotOfName(cn, name)
      if (s === undefined) return
      const t = (nodes[s] as CompiledNode).type
      if (COMPUTED_TYPES.has(t) || t === 'stock') initD.add(s)
    }
    const refs = refsBySlot.get(cn.slot) as { orderRefs: Set<string>; historyRefs: Set<string> }
    for (const name of refs.orderRefs) {
      const s = slotOfName(cn, name)
      if (s === undefined) continue
      const t = (nodes[s] as CompiledNode).type
      if (COMPUTED_TYPES.has(t)) deps.add(s)
      addInitDep(name)
    }
    // Priming a stateful call site at reset evaluates its explicit initial (if
    // given) or its input expression — those refs must be initialized first.
    // With an explicit initial the input imposes NO init dependency, which is
    // what lets `delay(x, τ, x0)` break otherwise-circular initial values.
    for (const call of collectStatefulCalls(cn.ast)) {
      const primeSrc = (call.name === 'previous' ? call.args[1] : call.args[2]) ?? call.args[0]
      const tauSrc = call.name === 'previous' ? undefined : call.args[1]
      for (const src of [primeSrc, tauSrc]) {
        if (!src) continue
        const { orderRefs, historyRefs } = collectRefs(src)
        for (const name of orderRefs) addInitDep(name)
        for (const name of historyRefs) addInitDep(name)
      }
    }
    orderDeps.set(cn.slot, deps)
    initDeps.set(cn.slot, initD)
  }
  for (const cn of nodes) {
    if (cn.type !== 'stock' || !cn.initAst) continue
    const initD = new Set<number>()
    const { orderRefs } = collectRefs(cn.initAst)
    for (const name of orderRefs) {
      const s = slotOfName(cn, name)
      if (s === undefined) continue
      const t = (nodes[s] as CompiledNode).type
      if (COMPUTED_TYPES.has(t) || t === 'stock') initD.add(s)
    }
    initDeps.set(cn.slot, initD)
  }

  // ---- topo sorts ----
  // Frozen module members are excluded from evaluation entirely: their held
  // values act as sources for everyone who reads them.
  const evalOrder = topoSort(
    nodes.filter((n) => isComputed(n.slot) && !n.frozen).map((n) => n.slot),
    orderDeps,
    paths,
  )
  if ('cycle' in evalOrder) {
    errors.push({
      severity: 'error',
      message: `circular dependency: ${evalOrder.cycle.map((s) => paths[s]).join(' → ')} → ${paths[evalOrder.cycle[0] as number]} — break the loop with a stock, previous(), or delay()`,
      path: paths[evalOrder.cycle[0] as number],
    })
    return { ok: false, errors, warnings }
  }

  const initSlots = nodes
    .filter((n) => isComputed(n.slot) || (n.type === 'stock' && n.initAst))
    .map((n) => n.slot)
  const initOrderSorted = topoSort(initSlots, initDeps, paths)
  if ('cycle' in initOrderSorted) {
    errors.push({
      severity: 'error',
      message: `circular initial values: ${initOrderSorted.cycle.map((s) => paths[s]).join(' → ')} → ${paths[initOrderSorted.cycle[0] as number]} — initial values cannot depend on each other in a loop`,
      path: paths[initOrderSorted.cycle[0] as number],
    })
    return { ok: false, errors, warnings }
  }
  const initOrder: InitStep[] = initOrderSorted.order.map((slot) => {
    const cn = nodes[slot] as CompiledNode
    return { slot, ast: (cn.type === 'stock' ? cn.initAst : cn.ast) as Ast }
  })

  // ---- record entries (stateful call sites) ----
  // Live nodes in eval order, then frozen nodes by path: frozen call sites
  // keep their state (skipped at runtime) so a freeze→unfreeze cycle resumes
  // delay/smooth histories where they stopped.
  const recordEntries: RecordEntry[] = []
  const recordSlots = [
    ...evalOrder.order,
    ...nodes
      .filter((n) => isComputed(n.slot) && n.frozen)
      .map((n) => n.slot)
      .sort((a, b) => ((paths[a] as string) < (paths[b] as string) ? -1 : 1)),
  ]
  for (const slot of recordSlots) {
    const cn = nodes[slot] as CompiledNode
    if (!cn.ast) continue
    for (const call of collectStatefulCalls(cn.ast)) {
      recordEntries.push({
        callSiteId: `${cn.path}#${call.ordinal}`,
        fn: call.name as RecordKind,
        argAst: call.args[0] as Ast,
        tauAst: call.name === 'previous' ? null : ((call.args[1] ?? null) as Ast | null),
        initAst:
          call.name === 'previous'
            ? ((call.args[1] ?? null) as Ast | null)
            : ((call.args[2] ?? null) as Ast | null),
        nodeSlot: slot,
        frozen: cn.frozen,
      })
    }
  }

  return {
    ok: true,
    warnings,
    compiled: {
      model,
      dt,
      seed: sim.seed ?? DEFAULT_SIM.seed,
      historyLength,
      timeUnits,
      paths,
      slotOf,
      nodes,
      evalOrder: evalOrder.order,
      initOrder,
      stocks,
      recordEntries,
      edges,
      edgeIndexOf: new Map(edges.map((e) => [e.id, e.idx])),
      warnings,
    },
  }
}

function resolveBaseline(
  cfg: BaselineConfig | undefined,
  def: BaselineConfig,
  ratio: number,
  dt: number,
): ResolvedBaseline {
  const mode = cfg?.mode ?? def.mode ?? 'initial'
  const tau = cfg?.tau ?? def.tau ?? 20
  const tauTicks = Math.max(tau * ratio, 1e-9)
  return {
    mode,
    fixedValue: cfg?.value ?? def.value ?? 0,
    ewmaK: Math.min(dt / tauTicks, 1),
    band: cfg?.band ?? def.band ?? 0.15,
    absFloor: cfg?.absFloor ?? def.absFloor ?? 1e-3,
  }
}

/** Kahn topo sort with lexicographic tie-break for stable, deterministic order. */
function topoSort(
  slots: number[],
  deps: Map<number, Set<number>>,
  paths: string[],
): { order: number[] } | { cycle: number[] } {
  const inSet = new Set(slots)
  const indegree = new Map<number, number>()
  const dependents = new Map<number, number[]>()
  for (const s of slots) indegree.set(s, 0)
  for (const s of slots) {
    for (const d of deps.get(s) ?? []) {
      if (!inSet.has(d) || d === s) {
        if (d === s) return { cycle: [s] }
        continue
      }
      indegree.set(s, (indegree.get(s) as number) + 1)
      let list = dependents.get(d)
      if (!list) {
        list = []
        dependents.set(d, list)
      }
      list.push(s)
    }
  }
  const byPath = (a: number, b: number) => ((paths[a] as string) < (paths[b] as string) ? -1 : 1)
  const ready = slots.filter((s) => indegree.get(s) === 0).sort(byPath)
  const order: number[] = []
  while (ready.length > 0) {
    const s = ready.shift() as number
    order.push(s)
    const deps2 = (dependents.get(s) ?? []).sort(byPath)
    for (const d of deps2) {
      const n = (indegree.get(d) as number) - 1
      indegree.set(d, n)
      if (n === 0) {
        // insert keeping ready sorted (small lists; simplicity over heap)
        let i = 0
        while (i < ready.length && byPath(ready[i] as number, d) < 0) i++
        ready.splice(i, 0, d)
      }
    }
  }
  if (order.length < slots.length) {
    // find a cycle among the leftovers for the error message
    const leftover = slots.filter((s) => !order.includes(s))
    const left = new Set(leftover)
    const start = leftover.sort(byPath)[0] as number
    const seen = new Map<number, number>()
    let cur = start
    const chain: number[] = []
    for (;;) {
      if (seen.has(cur)) {
        return { cycle: chain.slice(seen.get(cur) as number) }
      }
      seen.set(cur, chain.length)
      chain.push(cur)
      const nexts = [...(deps.get(cur) ?? [])].filter((d) => left.has(d)).sort(byPath)
      cur = nexts[0] as number
    }
  }
  return { order }
}

/** Cheap fuzzy suggestion for unknown identifiers. */
function suggest(name: string, candidates: string[]): string | undefined {
  const lower = name.toLowerCase()
  let best: string | undefined
  let bestScore = 3
  for (const c of candidates) {
    const d = editDistance(lower, c.toLowerCase(), bestScore)
    if (d < bestScore) {
      bestScore = d
      best = c
    }
  }
  return best
}

function editDistance(a: string, b: string, cap: number): number {
  if (Math.abs(a.length - b.length) >= cap) return cap
  const prev = new Array<number>(b.length + 1)
  for (let j = 0; j <= b.length; j++) prev[j] = j
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0] as number
    prev[0] = i
    for (let j = 1; j <= b.length; j++) {
      const tmp = prev[j] as number
      prev[j] = Math.min(
        tmp + 1,
        (prev[j - 1] as number) + 1,
        diag + (a[i - 1] === b[j - 1] ? 0 : 1),
      )
      diag = tmp
    }
  }
  return prev[b.length] as number
}
