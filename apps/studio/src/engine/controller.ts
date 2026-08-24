import { type CompileIssue, type Model, Simulation } from '@mindmap/engine'
import { useDoc } from '../store/doc'
import { useSimUi } from '../store/sim'
import { bridge } from './bridge'

/**
 * Owns the Simulation instance and the requestAnimationFrame loop. The engine
 * is clockless; this converts wall time × speed into tick() calls and hands
 * each frame to the AnimationBridge. Pause = stop calling tick.
 */
class Controller {
  sim: Simulation | null = null
  private raf = 0
  private fallbackTimer: ReturnType<typeof setTimeout> | undefined
  private lastMs = 0
  private accumTicks = 0
  private running = false

  /** (Re)build or hot-swap the simulation from a document. */
  syncModel(model: Model): { ok: boolean; errors: CompileIssue[]; warnings: CompileIssue[] } {
    const ui = useSimUi.getState()
    if (this.sim) {
      const result = this.sim.applyModel(model)
      if (result.ok) {
        ui.set({
          compileErrors: [],
          compileWarnings: result.warnings,
          runtimeWarnings: this.sim.runtimeWarnings,
        })
        this.paintOnce()
        return { ok: true, errors: [], warnings: result.warnings }
      }
      ui.set({ compileErrors: result.errors, compileWarnings: result.warnings })
      return { ok: false, errors: result.errors, warnings: result.warnings }
    }
    try {
      this.sim = new Simulation(model)
      ui.set({
        compileErrors: [],
        compileWarnings: this.sim.info.warnings,
        runtimeWarnings: this.sim.runtimeWarnings,
        status: 'paused',
      })
      this.paintOnce()
      return { ok: true, errors: [], warnings: this.sim.info.warnings }
    } catch (e) {
      const issues =
        e instanceof Error && 'issues' in e
          ? ((e as { issues: CompileIssue[] }).issues ?? [])
          : [{ severity: 'error' as const, message: String(e) }]
      ui.set({ compileErrors: issues })
      return { ok: false, errors: issues, warnings: [] }
    }
  }

  play(): void {
    if (!this.sim || this.running) return
    this.running = true
    useSimUi.getState().set({ status: 'running' })
    this.lastMs = performance.now()
    this.accumTicks = 0
    this.schedule()
  }

  pause(): void {
    this.running = false
    cancelAnimationFrame(this.raf)
    clearTimeout(this.fallbackTimer)
    useSimUi.getState().set({ status: 'paused' })
  }

  /**
   * Drive frames off requestAnimationFrame with a setTimeout fallback:
   * rAF stalls in background tabs (and headless panes); the timer keeps the
   * simulation advancing at ~15fps there, and rAF wins when compositing.
   */
  private schedule(): void {
    this.raf = requestAnimationFrame(this.frame)
    this.fallbackTimer = setTimeout(() => {
      cancelAnimationFrame(this.raf)
      this.frame(performance.now())
    }, 66)
  }

  toggle(): void {
    if (this.running) this.pause()
    else this.play()
  }

  stepOnce(): void {
    if (!this.sim) return
    if (this.running) this.pause()
    this.sim.tick(1)
    this.afterTicks()
    this.paintOnce()
  }

  reset(): void {
    if (!this.sim) return
    this.pause()
    this.sim.reset()
    useSimUi.getState().set({ diverged: null, runtimeWarnings: this.sim.runtimeWarnings })
    this.paintOnce()
  }

  /** Live dial writes during a run — no recompile. */
  setConstant(path: string, v: number): void {
    this.sim?.setValue(path, v)
    if (!this.running) this.paintOnce()
  }

  setStockValue(path: string, v: number): void {
    this.sim?.setValue(path, v)
    if (!this.running) this.paintOnce()
  }

  paintOnce(): void {
    if (this.sim) bridge.paint(this.sim, 1 / 60, true)
  }

  private frame = (nowMs: number): void => {
    clearTimeout(this.fallbackTimer)
    if (!this.running || !this.sim) return
    const dtSec = Math.min((nowMs - this.lastMs) / 1000, 0.25)
    this.lastMs = nowMs
    const speed = useSimUi.getState().speed
    this.accumTicks += dtSec * speed
    const dt = this.sim.dt
    let steps = Math.floor(this.accumTicks / dt)
    if (steps > 0) {
      if (steps > 200) {
        steps = 200 // can't keep up: drop the backlog instead of freezing
        this.accumTicks = 0
      } else {
        this.accumTicks -= steps * dt
      }
      this.sim.tick(steps)
      this.afterTicks()
    }
    bridge.paint(this.sim, dtSec)
    if (this.running) this.schedule()
  }

  private afterTicks(): void {
    const sim = this.sim
    if (!sim) return
    const diverged = sim.getFrame().diverged
    if (diverged) {
      const ui = useSimUi.getState()
      if (!ui.diverged) {
        ui.set({ diverged })
        this.pause()
      }
    }
  }
}

export const controller = new Controller()

/**
 * Wire the controller to the document store: recompile (hot-swap) on semantic
 * changes, debounced; auto-create link edges the compiler reports as missing.
 */
let lastSemantic = -1
let syncTimer: ReturnType<typeof setTimeout> | undefined

export function startEngineSync(): void {
  const syncNow = () => {
    const doc = useDoc.getState()
    lastSemantic = doc.semanticVersion
    const result = controller.syncModel(doc.model)
    if (result.ok) {
      const missing = result.warnings
        .map((w) => w.missingLink)
        .filter((m): m is { from: string; to: string } => !!m)
      if (missing.length > 0) doc.addLinks(missing)
    }
  }
  syncNow()
  useDoc.subscribe((s) => {
    if (s.semanticVersion === lastSemantic) return
    clearTimeout(syncTimer)
    syncTimer = setTimeout(syncNow, 150)
  })
}
