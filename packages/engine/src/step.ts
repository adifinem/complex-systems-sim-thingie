/**
 * Run state + the five-phase tick: eval → record → integrate → stats → advance.
 *
 * Phase order matters: the record phase (delay/smooth inputs) runs BEFORE
 * integration so history builtins sample start-of-tick stock values —
 * `delay(stock, τ)` must equal `delay(aux, τ)` where aux := stock, bit for bit.
 */

import type { Compiled, CompiledNode, RecordEntry } from './compile'
import { type EvalCtx, evalAst, type FuncState } from './interp'
import type { Ast } from './parser/ast'
import { Rng, type RngState } from './rng'

const EPS = 1e-9

export interface SimState {
  t: number
  tickIndex: number
  values: Float64Array
  baselines: Float64Array
  deviations: Float64Array
  funcState: Map<string, FuncState>
  rng: Rng
  /** slot → pinned value. */
  overrides: Map<number, number>
  /** 1 = slot is overridden; kept in sync with `overrides` for cheap UI reads. */
  overriddenMask: Uint8Array
  /** Per slot: sim time (ticks) of the next due evaluation (sample-and-hold). */
  holdNext: Float64Array
  edgeActive: Uint8Array
  /** Per-slot ring buffers, laid out history[slot*len + cursor]. */
  history: Float64Array
  historyCursor: number
  historyCount: number
  divergedSlot: number
  divergedTick: number
  /** Prime-time warnings (tau stiffness etc.), refreshed on reset/swap. */
  warnings: string[]
}

/** Per-node evaluation context, reused across calls to avoid allocation. */
function makeCtx(state: SimState): EvalCtx {
  return {
    values: state.values,
    t: 0,
    dt: 0,
    rng: state.rng,
    funcState: state.funcState,
    callSitePrefix: '',
    edgeRead: null,
  }
}

function setNodeCtx(ctx: EvalCtx, state: SimState, compiled: Compiled, cn: CompiledNode): void {
  ctx.t = state.t / cn.ratio
  ctx.dt = compiled.dt / cn.ratio
  ctx.callSitePrefix = `${cn.path}#`
}

/** Build a fully initialized state at t=0 (constants, initials, priming, baselines). */
export function initState(compiled: Compiled): SimState {
  const n = compiled.nodes.length
  const state: SimState = {
    t: 0,
    tickIndex: 0,
    values: new Float64Array(n),
    baselines: new Float64Array(n),
    deviations: new Float64Array(n),
    funcState: new Map(),
    rng: Rng.fromSeed(compiled.seed),
    overrides: new Map(),
    overriddenMask: new Uint8Array(n),
    holdNext: new Float64Array(n),
    edgeActive: new Uint8Array(compiled.edges.length),
    history: new Float64Array(n * compiled.historyLength),
    historyCursor: 0,
    historyCount: 0,
    divergedSlot: -1,
    divergedTick: -1,
    warnings: [],
  }
  const ctx = makeCtx(state)

  for (const cn of compiled.nodes) {
    if (cn.type === 'constant') state.values[cn.slot] = cn.constValue
  }

  // Group record entries by node for prime-before-first-eval ordering.
  const entriesByNode = new Map<number, RecordEntry[]>()
  for (const e of compiled.recordEntries) {
    let list = entriesByNode.get(e.nodeSlot)
    if (!list) {
      list = []
      entriesByNode.set(e.nodeSlot, list)
    }
    list.push(e)
  }

  for (const step of compiled.initOrder) {
    const cn = compiled.nodes[step.slot] as CompiledNode
    setNodeCtx(ctx, state, compiled, cn)
    const entries = entriesByNode.get(step.slot)
    if (entries) primeCallSites(entries, compiled, state, ctx)
    ctx.edgeRead = cn.type === 'stock' ? null : state.edgeActive
    if (cn.type !== 'stock') for (const idx of cn.inEdges) state.edgeActive[idx] = 0
    let v = evalAst(step.ast, ctx)
    if (cn.type === 'flow' && cn.uniflow && v < 0) v = 0
    state.values[step.slot] = v
    ctx.edgeRead = null
  }

  for (const cn of compiled.nodes) {
    state.baselines[cn.slot] =
      cn.baseline.mode === 'fixed' ? cn.baseline.fixedValue : (state.values[cn.slot] as number)
    if (cn.everyTicks > 0) state.holdNext[cn.slot] = cn.everyTicks
    if (!Number.isFinite(state.values[cn.slot] as number) && state.divergedSlot < 0) {
      state.divergedSlot = cn.slot
      state.divergedTick = 0
    }
  }
  updateStats(compiled, state, false)
  // History stays empty until the first tick pushes the t=0 row — restore of a
  // history-less snapshot must not present reset values as recorded samples.
  return state
}

function primeCallSites(
  entries: RecordEntry[],
  compiled: Compiled,
  state: SimState,
  ctx: EvalCtx,
): void {
  for (const e of entries) {
    const id = e.callSiteId
    if (state.funcState.has(id)) continue
    const cn = compiled.nodes[e.nodeSlot] as CompiledNode
    const tauUnits = e.tauAst ? evalAst(e.tauAst, ctx) : 0
    const tauTicks = tauUnits * cn.ratio
    if (e.fn !== 'previous') {
      if (!(tauTicks > 0)) {
        state.warnings.push(
          `${id}: ${e.fn}() time constant must be positive (got ${tauUnits}) — using one tick`,
        )
      } else if (tauTicks < 4 * compiled.dt && e.fn !== 'delay') {
        state.warnings.push(
          `${id}: ${e.fn}() time constant ${tauUnits} is under 4·dt — Euler integration may be inaccurate; lower dt or raise the constant`,
        )
      }
    }
    const x0 = evalAst((e.initAst ?? e.argAst) as Ast, ctx)
    state.funcState.set(id, freshFuncState(e.fn, x0, tauTicks, compiled.dt))
  }
}

export function freshFuncState(
  fn: RecordEntry['fn'],
  x0: number,
  tauTicks: number,
  dt: number,
): FuncState {
  switch (fn) {
    case 'delay': {
      const len = Math.max(1, Math.round(tauTicks / dt))
      const buf = new Float64Array(len)
      buf.fill(x0)
      return { kind: 'ring', buf, cursor: 0 }
    }
    case 'smooth': {
      const safeTau = Math.max(tauTicks, EPS)
      return { kind: 'smooth', s: x0, k: Math.min(dt / safeTau, 1) }
    }
    case 'previous':
      return { kind: 'prev', last: x0 }
    case 'delay1': {
      const safeTau = Math.max(tauTicks, dt)
      return { kind: 'd1', level: x0 * safeTau, tauTicks: safeTau }
    }
    case 'delay3': {
      const tau3 = Math.max(tauTicks / 3, dt)
      return { kind: 'd3', l1: x0 * tau3, l2: x0 * tau3, l3: x0 * tau3, tau3 }
    }
  }
}

/** Advance the simulation by exactly one dt. */
export function tick(compiled: Compiled, state: SimState): void {
  const ctx = makeCtx(state)
  const values = state.values
  const t = state.tickIndex * compiled.dt
  state.t = t

  // ---- phase 1: eval ----
  for (const [slot, v] of state.overrides) values[slot] = v
  for (const slot of compiled.evalOrder) {
    if (state.overrides.has(slot)) {
      const cn = compiled.nodes[slot] as CompiledNode
      for (const idx of cn.inEdges) state.edgeActive[idx] = 0
      continue
    }
    const cn = compiled.nodes[slot] as CompiledNode
    if (cn.everyTicks > 0 && t + EPS < (state.holdNext[slot] as number)) continue
    setNodeCtx(ctx, state, compiled, cn)
    ctx.edgeRead = state.edgeActive
    for (const idx of cn.inEdges) state.edgeActive[idx] = 0
    let v = evalAst(cn.ast as Ast, ctx)
    if (cn.uniflow && v < 0) v = 0
    values[slot] = v
    ctx.edgeRead = null
    if (!Number.isFinite(v) && state.divergedSlot < 0) {
      state.divergedSlot = slot
      state.divergedTick = state.tickIndex
    }
    if (cn.everyTicks > 0) {
      let next = state.holdNext[slot] as number
      while (next <= t + EPS) next += cn.everyTicks
      state.holdNext[slot] = next
    }
  }

  // ---- phase 2: record (before integration: start-of-tick stock values) ----
  // Overridden nodes are fully frozen: they read nothing (their inbound edges
  // stay dormant) and their delay/smooth histories stop advancing until the
  // override is released.
  const inputs = recordInputs
  const entries = compiled.recordEntries
  if (inputs.length < entries.length) recordInputs.length = entries.length
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i] as RecordEntry
    if (state.overrides.has(e.nodeSlot)) continue
    const cn = compiled.nodes[e.nodeSlot] as CompiledNode
    setNodeCtx(ctx, state, compiled, cn)
    ctx.edgeRead = state.edgeActive
    inputs[i] = evalAst(e.argAst, ctx)
    ctx.edgeRead = null
  }
  const dt = compiled.dt
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i] as RecordEntry
    if (state.overrides.has(e.nodeSlot)) continue
    const st = state.funcState.get(e.callSiteId)
    if (!st) continue
    const x = inputs[i] as number
    if (!Number.isFinite(x) && state.divergedSlot < 0) {
      state.divergedSlot = e.nodeSlot
      state.divergedTick = state.tickIndex
    }
    switch (st.kind) {
      case 'ring':
        st.buf[st.cursor] = x
        st.cursor = (st.cursor + 1) % st.buf.length
        break
      case 'smooth':
        st.s += st.k * (x - st.s)
        break
      case 'prev':
        st.last = x
        break
      case 'd1': {
        const out = st.level / st.tauTicks
        st.level += dt * (x - out)
        break
      }
      case 'd3': {
        const o1 = st.l1 / st.tau3
        const o2 = st.l2 / st.tau3
        const o3 = st.l3 / st.tau3
        st.l1 += dt * (x - o1)
        st.l2 += dt * (o1 - o2)
        st.l3 += dt * (o2 - o3)
        break
      }
    }
  }

  // History records the coherent report row BEFORE integration: (t_eval,
  // stocks(t_eval), aux(t_eval)) — the standard SD output row. The live frame
  // afterwards shows post-integration stocks for animation.
  pushHistory(compiled, state)

  // ---- phase 3: integrate ----
  for (const stock of compiled.stocks) {
    if (state.overrides.has(stock.slot)) continue
    let delta = 0
    for (const f of stock.inflows) delta += (values[f.slot] as number) * f.scale
    for (const f of stock.outflows) delta -= (values[f.slot] as number) * f.scale
    let v = (values[stock.slot] as number) + delta
    if (stock.nonNegative && v < 0) v = 0
    values[stock.slot] = v
    if (!Number.isFinite(v) && state.divergedSlot < 0) {
      state.divergedSlot = stock.slot
      state.divergedTick = state.tickIndex
    }
  }

  // ---- phase 4/5: advance + stats ----
  state.tickIndex += 1
  state.t = state.tickIndex * compiled.dt
  updateStats(compiled, state, true)
}

function updateStats(compiled: Compiled, state: SimState, advanceEwma: boolean): void {
  const { values, baselines, deviations } = state
  for (const cn of compiled.nodes) {
    const v = values[cn.slot] as number
    let b = baselines[cn.slot] as number
    if (advanceEwma && cn.baseline.mode === 'ewma') {
      b += cn.baseline.ewmaK * (v - b)
      baselines[cn.slot] = b
    }
    const denom = Math.max(Math.abs(b) * cn.baseline.band, cn.baseline.absFloor)
    deviations[cn.slot] = Math.tanh((v - b) / denom)
  }
}

function pushHistory(compiled: Compiled, state: SimState): void {
  const len = compiled.historyLength
  const cursor = state.historyCursor
  const values = state.values
  const history = state.history
  for (let slot = 0; slot < compiled.nodes.length; slot++) {
    history[slot * len + cursor] = values[slot] as number
  }
  state.historyCursor = (cursor + 1) % len
  state.historyCount = Math.min(state.historyCount + 1, len)
}

/** Reused scratch buffer for the record-phase gather pass. */
const recordInputs: number[] = []

// ---------------------------------------------------------------------------
// Serialization
// ---------------------------------------------------------------------------

export interface Snapshot {
  version: 1
  t: number
  tickIndex: number
  values: Record<string, number>
  baselines: Record<string, number>
  /** Node type per path — restore skips values whose node changed kind. */
  types: Record<string, string>
  funcState: Record<string, SerializedFuncState>
  /**
   * Per stateful call site: the owning node's formula source at snapshot time.
   * Restore keeps state verbatim when unchanged (bit-identical restore even
   * with time-varying taus) and re-samples taus only after a formula edit.
   */
  statefulSrc: Record<string, string>
  rng: RngState
  overrides: Record<string, number>
  holdNext: Record<string, number>
  edgeActive: Record<string, 0 | 1>
  diverged: { path: string; tickIndex: number } | null
  history?: {
    cursor: number
    count: number
    data: Record<string, number[]>
  }
}

export type SerializedFuncState =
  | { kind: 'ring'; buf: number[]; cursor: number }
  | { kind: 'smooth'; s: number; k: number }
  | { kind: 'prev'; last: number }
  | { kind: 'd1'; level: number; tauTicks: number }
  | { kind: 'd3'; l1: number; l2: number; l3: number; tau3: number }

export function snapshotState(
  compiled: Compiled,
  state: SimState,
  opts?: { includeHistory?: boolean },
): Snapshot {
  const byPath = (arr: Float64Array): Record<string, number> => {
    const out: Record<string, number> = {}
    for (const cn of compiled.nodes) out[cn.path] = arr[cn.slot] as number
    return out
  }
  const funcState: Record<string, SerializedFuncState> = {}
  for (const [id, st] of state.funcState) {
    funcState[id] =
      st.kind === 'ring' ? { kind: 'ring', buf: Array.from(st.buf), cursor: st.cursor } : { ...st }
  }
  const overrides: Record<string, number> = {}
  for (const [slot, v] of state.overrides) {
    overrides[(compiled.nodes[slot] as CompiledNode).path] = v
  }
  const holdNext: Record<string, number> = {}
  for (const cn of compiled.nodes) {
    if (cn.everyTicks > 0) holdNext[cn.path] = state.holdNext[cn.slot] as number
  }
  const edgeActive: Record<string, 0 | 1> = {}
  for (const e of compiled.edges) edgeActive[e.id] = (state.edgeActive[e.idx] ?? 0) as 0 | 1
  const types: Record<string, string> = {}
  for (const cn of compiled.nodes) types[cn.path] = cn.type
  const statefulSrc: Record<string, string> = {}
  for (const e of compiled.recordEntries) {
    statefulSrc[e.callSiteId] = (compiled.nodes[e.nodeSlot] as CompiledNode).formulaSrc
  }
  const snap: Snapshot = {
    version: 1,
    t: state.t,
    tickIndex: state.tickIndex,
    values: byPath(state.values),
    baselines: byPath(state.baselines),
    types,
    funcState,
    statefulSrc,
    rng: state.rng.getState(),
    overrides,
    holdNext,
    edgeActive,
    diverged:
      state.divergedSlot >= 0
        ? {
            path: (compiled.nodes[state.divergedSlot] as CompiledNode).path,
            tickIndex: state.divergedTick,
          }
        : null,
  }
  if (opts?.includeHistory) {
    const len = compiled.historyLength
    const data: Record<string, number[]> = {}
    for (const cn of compiled.nodes) {
      data[cn.path] = Array.from(state.history.subarray(cn.slot * len, (cn.slot + 1) * len))
    }
    snap.history = { cursor: state.historyCursor, count: state.historyCount, data }
  }
  return snap
}

/**
 * Restore a snapshot into a fresh state. Entries whose path/call-site no longer
 * exists are dropped; nodes missing from the snapshot keep their reset values.
 * Returns the paths that could not be matched (for a UI warning).
 */
export interface RestoreOpts {
  /**
   * applyModel passes true: the incoming document is the source of truth for
   * constants, so their snapshot values are NOT overlaid (a dial edit in the
   * document survives the hot-swap). Plain restore leaves it false: constants
   * revert to their snapshot values and the model is synced to match.
   */
  constantsFromModel?: boolean
}

export function restoreState(
  compiled: Compiled,
  snap: Snapshot,
  opts?: RestoreOpts,
): { state: SimState; unmatched: string[] } {
  const state = initState(compiled)
  const unmatched: string[] = []
  state.t = snap.t
  state.tickIndex = snap.tickIndex
  state.rng.setState(snap.rng)

  /** Paths whose node kind changed since the snapshot keep their reset values. */
  const matches = (path: string, slot: number): boolean => {
    const snapType = snap.types?.[path]
    return snapType === undefined || snapType === (compiled.nodes[slot] as CompiledNode).type
  }

  const assign = (rec: Record<string, number>, arr: Float64Array, skipConstants: boolean): void => {
    for (const [path, v] of Object.entries(rec)) {
      const slot = compiled.slotOf.get(path)
      if (slot === undefined || !matches(path, slot)) {
        if (!unmatched.includes(path)) unmatched.push(path)
        continue
      }
      if (skipConstants && (compiled.nodes[slot] as CompiledNode).type === 'constant') continue
      arr[slot] = v
    }
  }
  assign(snap.values, state.values, opts?.constantsFromModel ?? false)
  assign(snap.baselines, state.baselines, false)

  if (!opts?.constantsFromModel) {
    // Keep the engine self-consistent: restored constant values become the
    // model's values too (otherwise clearOverride/reset would resurrect them).
    for (const cn of compiled.nodes) {
      if (cn.type !== 'constant') continue
      const v = snap.values[cn.path]
      if (v === undefined || !matches(cn.path, cn.slot)) continue
      cn.constValue = v
      const graph = compiled.model.graphs[compiled.model.mainGraph]
      const raw = graph?.nodes.find((n) => n.id === cn.path)
      if (raw && raw.type === 'constant') raw.value = v
    }
  }

  for (const [path, v] of Object.entries(snap.overrides)) {
    const slot = compiled.slotOf.get(path)
    if (slot === undefined || !matches(path, slot)) {
      unmatched.push(path)
      continue
    }
    state.overrides.set(slot, v)
    state.overriddenMask[slot] = 1
    state.values[slot] = v
  }
  for (const [path, v] of Object.entries(snap.holdNext)) {
    const slot = compiled.slotOf.get(path)
    if (slot !== undefined) state.holdNext[slot] = v
  }
  const validIds = new Set(compiled.recordEntries.map((e) => e.callSiteId))
  for (const [id, st] of Object.entries(snap.funcState)) {
    if (!validIds.has(id)) {
      unmatched.push(id)
      continue
    }
    const existing = state.funcState.get(id)
    if (!existing || existing.kind !== st.kind) {
      unmatched.push(id)
      continue
    }
    state.funcState.set(
      id,
      st.kind === 'ring'
        ? { kind: 'ring', buf: Float64Array.from(st.buf), cursor: st.cursor }
        : { ...st },
    )
  }
  for (const [edgeId, bit] of Object.entries(snap.edgeActive)) {
    const idx = compiled.edgeIndexOf.get(edgeId)
    if (idx !== undefined) state.edgeActive[idx] = bit
  }
  if (snap.history) {
    const len = compiled.historyLength
    state.historyCount = Math.min(snap.history.count, len)
    state.historyCursor = ((snap.history.cursor % len) + len) % len
    for (const [path, data] of Object.entries(snap.history.data)) {
      const slot = compiled.slotOf.get(path)
      if (slot === undefined) continue
      state.history.set(data.slice(0, len), slot * len)
    }
  } else {
    state.historyCursor = 0
    state.historyCount = 0
  }
  if (snap.diverged) {
    const slot = compiled.slotOf.get(snap.diverged.path)
    if (slot !== undefined) {
      state.divergedSlot = slot
      state.divergedTick = snap.diverged.tickIndex
    }
  }
  resampleTaus(compiled, state, snap.statefulSrc ?? {})
  updateStats(compiled, state, false)
  return { state, unmatched }
}

/**
 * Reconcile stateful call sites whose OWNING FORMULA changed since the
 * snapshot: re-evaluate the tau against restored values and re-seed/rescale
 * the carried state. Call sites with an unchanged formula are left strictly
 * verbatim, which is what keeps plain snapshot→restore bit-identical even
 * when a tau expression is time-varying or stochastic.
 */
function resampleTaus(
  compiled: Compiled,
  state: SimState,
  statefulSrc: Record<string, string>,
): void {
  const ctx = makeCtx(state)
  for (const e of compiled.recordEntries) {
    if (!e.tauAst) continue
    const st = state.funcState.get(e.callSiteId)
    if (!st) continue
    const srcNow = (compiled.nodes[e.nodeSlot] as CompiledNode).formulaSrc
    if (statefulSrc[e.callSiteId] === srcNow) continue
    const cn = compiled.nodes[e.nodeSlot] as CompiledNode
    setNodeCtx(ctx, state, compiled, cn)
    const tauTicks = evalAst(e.tauAst, ctx) * cn.ratio
    if (!Number.isFinite(tauTicks)) continue
    const dt = compiled.dt
    switch (st.kind) {
      case 'ring': {
        const len = Math.max(1, Math.round(tauTicks / dt))
        if (len !== st.buf.length) {
          // Length changed: re-seed with the current input value.
          const x = evalAst(e.argAst, ctx)
          const buf = new Float64Array(len)
          buf.fill(x)
          state.funcState.set(e.callSiteId, { kind: 'ring', buf, cursor: 0 })
        }
        break
      }
      case 'smooth':
        st.k = Math.min(dt / Math.max(tauTicks, EPS), 1)
        break
      case 'd1': {
        const newTau = Math.max(tauTicks, dt)
        if (newTau !== st.tauTicks) {
          // Preserve the visible output (level/tau) across the change.
          st.level = (st.level / st.tauTicks) * newTau
          st.tauTicks = newTau
        }
        break
      }
      case 'd3': {
        const newTau3 = Math.max(tauTicks / 3, dt)
        if (newTau3 !== st.tau3) {
          st.l1 = (st.l1 / st.tau3) * newTau3
          st.l2 = (st.l2 / st.tau3) * newTau3
          st.l3 = (st.l3 / st.tau3) * newTau3
          st.tau3 = newTau3
        }
        break
      }
      default:
        break
    }
  }
}
