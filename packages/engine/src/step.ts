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
  }
  updateStats(compiled, state, false)
  pushHistory(compiled, state)
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
  const inputs = recordInputs
  const entries = compiled.recordEntries
  if (inputs.length < entries.length) recordInputs.length = entries.length
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i] as RecordEntry
    const cn = compiled.nodes[e.nodeSlot] as CompiledNode
    setNodeCtx(ctx, state, compiled, cn)
    ctx.edgeRead = state.edgeActive
    inputs[i] = evalAst(e.argAst, ctx)
    ctx.edgeRead = null
  }
  const dt = compiled.dt
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i] as RecordEntry
    const st = state.funcState.get(e.callSiteId)
    if (!st) continue
    const x = inputs[i] as number
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

  // ---- phase 4/5: advance + stats + history ----
  state.tickIndex += 1
  state.t = state.tickIndex * compiled.dt
  updateStats(compiled, state, true)
  pushHistory(compiled, state)
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
  funcState: Record<string, SerializedFuncState>
  rng: RngState
  overrides: Record<string, number>
  holdNext: Record<string, number>
  edgeActive: Record<string, 0 | 1>
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
  const snap: Snapshot = {
    version: 1,
    t: state.t,
    tickIndex: state.tickIndex,
    values: byPath(state.values),
    baselines: byPath(state.baselines),
    funcState,
    rng: state.rng.getState(),
    overrides,
    holdNext,
    edgeActive,
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
export function restoreState(
  compiled: Compiled,
  snap: Snapshot,
): { state: SimState; unmatched: string[] } {
  const state = initState(compiled)
  const unmatched: string[] = []
  state.t = snap.t
  state.tickIndex = snap.tickIndex
  state.rng.setState(snap.rng)

  const assign = (rec: Record<string, number>, arr: Float64Array): void => {
    for (const [path, v] of Object.entries(rec)) {
      const slot = compiled.slotOf.get(path)
      if (slot === undefined) {
        if (!unmatched.includes(path)) unmatched.push(path)
        continue
      }
      arr[slot] = v
    }
  }
  assign(snap.values, state.values)
  assign(snap.baselines, state.baselines)
  for (const [path, v] of Object.entries(snap.overrides)) {
    const slot = compiled.slotOf.get(path)
    if (slot === undefined) {
      unmatched.push(path)
      continue
    }
    state.overrides.set(slot, v)
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
    state.historyCursor = snap.history.cursor
    state.historyCount = snap.history.count
    const len = compiled.historyLength
    for (const [path, data] of Object.entries(snap.history.data)) {
      const slot = compiled.slotOf.get(path)
      if (slot === undefined) continue
      state.history.set(data.slice(0, len), slot * len)
    }
  }
  updateStats(compiled, state, false)
  return { state, unmatched }
}
