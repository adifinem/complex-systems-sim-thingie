import type { Simulation } from '@mindmap/engine'
import { devColor, fmtValue } from '../color'

/**
 * AnimationBridge: the only path from per-tick simulation values to the DOM.
 * React owns structure; this owns motion. Per frame it writes ONLY cheap
 * properties: CSS variables, textContent, stroke-dashoffset/width/color,
 * class toggles. Missing refs are normal (node offscreen/unmounted).
 */

export interface NodeRefs {
  root: HTMLElement
  badge: HTMLElement | null
  /** Stocks: fill-bar element plus its configured [min,max] range. */
  fill?: { el: HTMLElement; min: number; max: number }
  /** Sparkline canvas (stocks by default). Painted ~10Hz, zoom-gated. */
  spark?: HTMLCanvasElement
}

export interface EdgeRefs {
  kind: 'pipe' | 'wire'
  el: SVGPathElement
  /** Pipes: path of the flow node the pipe animates. */
  flowPath?: string
  /** Wires: engine edge id (link) — drives active/dormant + tint. */
  linkId?: string
  sourcePath?: string
}

interface PipeAnim {
  offset: number
  scale: number
}

export class AnimationBridge {
  private nodes = new Map<string, NodeRefs>()
  private edges = new Map<string, EdgeRefs>()
  private pipeAnim = new Map<string, PipeAnim>()
  private timeEl: HTMLElement | null = null
  private frameCount = 0

  registerNode(id: string, refs: NodeRefs): void {
    this.nodes.set(id, refs)
  }

  unregisterNode(id: string): void {
    this.nodes.delete(id)
  }

  registerEdge(id: string, refs: EdgeRefs): void {
    this.edges.set(id, refs)
  }

  unregisterEdge(id: string): void {
    this.edges.delete(id)
    this.pipeAnim.delete(id)
  }

  registerTime(el: HTMLElement | null): void {
    this.timeEl = el
  }

  /** Toggle a class on a node's root element (perturbed markers etc.). */
  setNodeClass(id: string, cls: string, on: boolean): void {
    this.nodes.get(id)?.root.classList.toggle(cls, on)
  }

  private zoom = 1

  /** Canvas zoom, fed by the graph view — sparklines pause below 0.5. */
  setZoom(zoom: number): void {
    this.zoom = zoom
  }

  /** Paint the current engine frame into the DOM. dtSeconds = real elapsed time. */
  paint(sim: Simulation, dtSeconds: number, force = false): void {
    const frame = sim.getFrame()
    const info = sim.info
    this.frameCount++
    const paintBadges = force || this.frameCount % 4 === 0 // ~15Hz at 60fps

    for (const [id, refs] of this.nodes) {
      const slot = info.slotOf.get(id)
      if (slot === undefined) continue
      const dev = frame.deviations[slot] as number
      const style = refs.root.style
      style.setProperty('--dev-color', devColor(dev))
      style.setProperty('--dev-abs', Math.abs(dev).toFixed(3))
      refs.root.classList.toggle('pinned', frame.overridden[slot] === 1)
      if (refs.badge && paintBadges) {
        refs.badge.textContent = fmtValue(frame.values[slot] as number)
      }
      if (refs.fill) {
        const v = frame.values[slot] as number
        const { min, max } = refs.fill
        const f = max > min ? Math.min(Math.max((v - min) / (max - min), 0), 1) : 0
        refs.fill.el.style.setProperty('--fill', f.toFixed(3))
      }
    }

    for (const [id, refs] of this.edges) {
      if (refs.kind === 'pipe') {
        const slot = refs.flowPath !== undefined ? info.slotOf.get(refs.flowPath) : undefined
        if (slot === undefined) continue
        // Per-tick rate so mixed time units animate comparably.
        const rate = (frame.values[slot] as number) / (info.ratios[slot] as number)
        let anim = this.pipeAnim.get(id)
        if (!anim) {
          anim = { offset: 0, scale: 1e-6 }
          this.pipeAnim.set(id, anim)
        }
        const mag = Math.abs(rate)
        // Decaying running max keeps thickness meaningful as the system evolves.
        anim.scale = Math.max(anim.scale * 0.995, mag, 1e-6)
        anim.offset -= (rate / anim.scale) * dtSeconds * 26
        const el = refs.el
        el.style.strokeDashoffset = anim.offset.toFixed(2)
        el.style.strokeWidth = `${Math.min(2 + 2.5 * Math.sqrt(mag / anim.scale), 8).toFixed(2)}`
        el.style.opacity = mag < anim.scale * 0.01 ? '0.3' : '1'
        const devSlot = frame.deviations[slot] as number
        el.style.stroke = devColor(devSlot)
      } else {
        const idx = refs.linkId !== undefined ? info.edgeIndexOf.get(refs.linkId) : undefined
        if (idx === undefined) continue
        const active = (frame.edgeActive[idx] as number) === 1
        refs.el.classList.toggle('dormant', !active)
        if (active && refs.sourcePath) {
          const srcSlot = info.slotOf.get(refs.sourcePath)
          if (srcSlot !== undefined) {
            refs.el.style.stroke = devColor(frame.deviations[srcSlot] as number)
          }
        }
      }
    }

    if (this.timeEl && (force || this.frameCount % 6 === 0)) {
      this.timeEl.textContent = `t = ${frame.t.toFixed(1)}`
    }

    // Sparklines: ~10Hz, only when zoomed in enough to read them.
    if ((force || this.frameCount % 6 === 0) && this.zoom >= 0.5) {
      for (const [id, refs] of this.nodes) {
        if (!refs.spark) continue
        const slot = info.slotOf.get(id)
        if (slot === undefined) continue
        drawSparkline(
          refs.spark,
          sim.history(id, 140),
          frame.baselines[slot] as number,
          devColor(frame.deviations[slot] as number),
        )
      }
    }
  }
}

function drawSparkline(
  canvas: HTMLCanvasElement,
  h: Float64Array,
  baseline: number,
  color: string,
): void {
  const ctx = canvas.getContext('2d')
  if (!ctx || h.length < 2) return
  const w = canvas.width
  const height = canvas.height
  ctx.clearRect(0, 0, w, height)
  let lo = Number.POSITIVE_INFINITY
  let hi = Number.NEGATIVE_INFINITY
  for (const v of h) {
    if (v < lo) lo = v
    if (v > hi) hi = v
  }
  if (baseline < lo) lo = baseline
  if (baseline > hi) hi = baseline
  const span = hi - lo || 1
  const y = (v: number) => height - 2 - ((v - lo) / span) * (height - 4)
  // baseline as a faint dashed midline
  ctx.strokeStyle = 'rgba(139,143,152,0.35)'
  ctx.setLineDash([3, 3])
  ctx.beginPath()
  ctx.moveTo(0, y(baseline))
  ctx.lineTo(w, y(baseline))
  ctx.stroke()
  ctx.setLineDash([])
  // trace, tinted by current deviation
  ctx.strokeStyle = color
  ctx.lineWidth = 1.2
  ctx.beginPath()
  for (let i = 0; i < h.length; i++) {
    const x = (i / (h.length - 1)) * w
    if (i === 0) ctx.moveTo(x, y(h[i] as number))
    else ctx.lineTo(x, y(h[i] as number))
  }
  ctx.stroke()
}

export const bridge = new AnimationBridge()
