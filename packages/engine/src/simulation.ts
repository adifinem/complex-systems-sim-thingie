/**
 * Public engine facade. Clockless and synchronous: the UI owns the animation
 * loop and calls tick(n) then getFrame(). Everything in/out of the perturbation
 * and snapshot APIs is JSON-serializable; the Frame is reused typed arrays.
 */

import {
  type Compiled,
  type CompiledNode,
  type CompileIssue,
  type CompileResult,
  compile,
} from './compile'
import type { Model, ModuleMode } from './model'
import { validateModel } from './model'
import { initState, restoreState, type SimState, type Snapshot, snapshotState, tick } from './step'

export interface Frame {
  t: number
  tickIndex: number
  /** Current value per slot (see info.paths for slot→path). Reused buffer. */
  values: Float64Array
  /** Signed deviation vs baseline in (−1, 1) per slot. Reused buffer. */
  deviations: Float64Array
  /** Baseline per slot. Reused buffer. */
  baselines: Float64Array
  /** 1 = the link's alias was read on its target's last evaluation. Reused buffer. */
  edgeActive: Uint8Array
  diverged: { path: string; tickIndex: number } | null
}

export interface NodeView {
  path: string
  type: string
  value: number
  baseline: number
  deviation: number
  overridden: boolean
  held: boolean
}

/** Compile-time lookup tables the UI/animation bridge needs. Stable per compile. */
export interface CompiledInfo {
  paths: string[]
  slotOf: Map<string, number>
  edges: {
    id: string
    idx: number
    from: string
    to: string
    alias: string
    sourceSlot: number
    targetSlot: number
  }[]
  edgeIndexOf: Map<string, number>
  /** Per slot: node type. */
  types: string[]
  /** Per slot: ticks per node time unit (flows: divide value by this for per-tick rate). */
  ratios: number[]
  warnings: CompileIssue[]
}

/** Deep-clone via JSON — models are JSON documents by contract. */
function cloneJson<T>(x: T): T {
  return JSON.parse(JSON.stringify(x)) as T
}

export class CompileFailure extends Error {
  constructor(readonly issues: CompileIssue[]) {
    super(`model failed to compile:\n${issues.map((i) => `  - ${i.message}`).join('\n')}`)
    this.name = 'CompileFailure'
  }
}

export class Simulation {
  private compiled: Compiled
  private state: SimState
  private frame: Frame

  constructor(model: Model, opts?: { seed?: number }) {
    const { model: valid, issues } = validateModel(model)
    if (!valid) throw new CompileFailure(issues)
    const doc = cloneJson(valid)
    if (opts?.seed !== undefined) {
      doc.sim = { ...(doc.sim ?? {}), seed: opts.seed }
    }
    const result = compile(doc)
    if (!result.ok) throw new CompileFailure(result.errors)
    this.compiled = result.compiled
    this.state = initState(this.compiled)
    this.frame = this.makeFrame()
  }

  // ---- run control -------------------------------------------------------

  get time(): number {
    return this.state.t
  }

  get tickIndex(): number {
    return this.state.tickIndex
  }

  /** Step-size in ticks. */
  get dt(): number {
    return this.compiled.dt
  }

  tick(n = 1): void {
    for (let i = 0; i < n; i++) tick(this.compiled, this.state)
  }

  /** Re-initialize from the model: t=0, fresh state, PRNG reseeded. Model edits persist. */
  reset(): void {
    this.state = initState(this.compiled)
    this.syncFrameBuffers()
  }

  /** Prime-time warnings (stiffness etc.) from the last reset/swap. */
  get runtimeWarnings(): string[] {
    return this.state.warnings
  }

  // ---- output ------------------------------------------------------------

  getFrame(): Frame {
    const f = this.frame
    f.t = this.state.t
    f.tickIndex = this.state.tickIndex
    f.diverged =
      this.state.divergedSlot >= 0
        ? {
            path: (this.compiled.nodes[this.state.divergedSlot] as CompiledNode).path,
            tickIndex: this.state.divergedTick,
          }
        : null
    return f
  }

  get info(): CompiledInfo {
    return {
      paths: this.compiled.paths,
      slotOf: this.compiled.slotOf,
      edges: this.compiled.edges.map((e) => ({ ...e })),
      edgeIndexOf: this.compiled.edgeIndexOf,
      types: this.compiled.nodes.map((n) => n.type),
      ratios: this.compiled.nodes.map((n) => n.ratio),
      warnings: this.compiled.warnings,
    }
  }

  getNode(path: string): NodeView {
    const slot = this.slot(path)
    const cn = this.compiled.nodes[slot] as CompiledNode
    return {
      path,
      type: cn.type,
      value: this.state.values[slot] as number,
      baseline: this.state.baselines[slot] as number,
      deviation: this.state.deviations[slot] as number,
      overridden: this.state.overrides.has(slot),
      held: cn.everyTicks > 0,
    }
  }

  /** Last `lastN` recorded values for a node (oldest first). */
  history(path: string, lastN?: number): Float64Array {
    const slot = this.slot(path)
    const len = this.compiled.historyLength
    const count = Math.min(this.state.historyCount, lastN ?? len)
    const out = new Float64Array(count)
    const base = slot * len
    for (let i = 0; i < count; i++) {
      const idx = (this.state.historyCursor - count + i + len) % len
      out[i] = this.state.history[base + idx] as number
    }
    return out
  }

  // ---- perturbation ------------------------------------------------------

  /** Overwrite a stock's current value or a constant's model value. */
  setValue(path: string, v: number): void {
    const slot = this.slot(path)
    const cn = this.compiled.nodes[slot] as CompiledNode
    if (cn.type === 'stock') {
      this.state.values[slot] = v
      return
    }
    if (cn.type === 'constant') {
      cn.constValue = v
      const raw = this.findModelNode(path)
      if (raw && raw.type === 'constant') raw.value = v
      if (!this.state.overrides.has(slot)) this.state.values[slot] = v
      return
    }
    throw new Error(`setValue: "${path}" is a ${cn.type} — pin computed nodes with setOverride`)
  }

  /** Pin any node to a constant; its formula is preserved. Lives in run state. */
  setOverride(path: string, v: number): void {
    const slot = this.slot(path)
    this.state.overrides.set(slot, v)
    this.state.values[slot] = v
  }

  clearOverride(path: string): void {
    const slot = this.slot(path)
    this.state.overrides.delete(slot)
    const cn = this.compiled.nodes[slot] as CompiledNode
    if (cn.type === 'constant') this.state.values[slot] = cn.constValue
  }

  get overrides(): Record<string, number> {
    const out: Record<string, number> = {}
    for (const [slot, v] of this.state.overrides) {
      out[(this.compiled.nodes[slot] as CompiledNode).path] = v
    }
    return out
  }

  /**
   * Replace one node's formula (or a stock's initial), recompile, continue from
   * the current state. Atomic: on compile error nothing changes.
   */
  setFormula(path: string, src: string): CompileResult {
    const model = cloneJson(this.compiled.model)
    const raw = this.findModelNode(path, model)
    if (!raw) {
      return {
        ok: false,
        errors: [{ severity: 'error', message: `unknown node "${path}"` }],
        warnings: [],
      }
    }
    if (raw.type === 'stock') (raw as { initial: string }).initial = src
    else if ('formula' in raw) (raw as { formula: string }).formula = src
    else if (raw.type === 'input') (raw as { default?: string }).default = src
    else {
      return {
        ok: false,
        errors: [{ severity: 'error', message: `node "${path}" (${raw.type}) has no formula` }],
        warnings: [],
      }
    }
    return this.applyModel(model)
  }

  /**
   * Swap in an edited model document, preserving run state keyed by node path
   * and stateful call-site id. The universal hot-swap for structural edits.
   * Atomic: on compile error the running program is untouched.
   */
  applyModel(model: Model): CompileResult {
    const { model: valid, issues } = validateModel(model)
    if (!valid) return { ok: false, errors: issues, warnings: [] }
    const result = compile(cloneJson(valid))
    if (!result.ok) return result
    const snap = snapshotState(this.compiled, this.state, { includeHistory: true })
    this.compiled = result.compiled
    const { state } = restoreState(this.compiled, snap)
    this.state = state
    this.syncFrameBuffers()
    return result
  }

  setModuleMode(_path: string, _mode: ModuleMode): void {
    throw new Error('modules land in milestone M5')
  }

  // ---- state -------------------------------------------------------------

  snapshot(opts?: { includeHistory?: boolean }): Snapshot {
    return snapshotState(this.compiled, this.state, opts)
  }

  /** Exact resume from a snapshot. Unmatched paths are reported, not fatal. */
  restore(snap: Snapshot): { unmatched: string[] } {
    const { state, unmatched } = restoreState(this.compiled, snap)
    this.state = state
    this.syncFrameBuffers()
    return { unmatched }
  }

  /** Current model document including live edits (constants, formulas). */
  exportModel(): Model {
    return cloneJson(this.compiled.model)
  }

  // ---- internals ---------------------------------------------------------

  private slot(path: string): number {
    const slot = this.compiled.slotOf.get(path)
    if (slot === undefined) throw new Error(`unknown node "${path}"`)
    return slot
  }

  private findModelNode(path: string, model?: Model) {
    const m = model ?? this.compiled.model
    const graph = m.graphs[m.mainGraph]
    return graph?.nodes.find((n) => n.id === path)
  }

  private makeFrame(): Frame {
    return {
      t: this.state.t,
      tickIndex: this.state.tickIndex,
      values: this.state.values,
      deviations: this.state.deviations,
      baselines: this.state.baselines,
      edgeActive: this.state.edgeActive,
      diverged: null,
    }
  }

  private syncFrameBuffers(): void {
    this.frame = this.makeFrame()
  }
}
