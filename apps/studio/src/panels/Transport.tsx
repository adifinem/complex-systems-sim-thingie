import { useEffect, useRef } from 'react'
import { bridge } from '../engine/bridge'
import { controller } from '../engine/controller'
import { useSimUi, useUi } from '../store/sim'

export function Transport() {
  const status = useSimUi((s) => s.status)
  const speed = useSimUi((s) => s.speed)
  const setUi = useSimUi((s) => s.set)
  const diverged = useSimUi((s) => s.diverged)
  const showDeviations = useUi((s) => s.showDeviations)
  const timeRef = useRef<HTMLSpanElement>(null)

  useEffect(() => {
    bridge.registerTime(timeRef.current)
    return () => bridge.registerTime(null)
  }, [])

  const running = status === 'running'
  return (
    <div className="transport">
      <button type="button" title="Reset (R)" onClick={() => controller.reset()}>
        ⟲
      </button>
      <button type="button" title="Step one tick (.)" onClick={() => controller.stepOnce()}>
        ⏭
      </button>
      <button
        type="button"
        className={running ? 'playing' : ''}
        title="Play/Pause (Space)"
        onClick={() => controller.toggle()}
      >
        {running ? '⏸' : '▶'}
      </button>
      <input
        type="range"
        min={-1}
        max={3}
        step={0.05}
        value={Math.log10(speed)}
        title="Simulation speed (ticks per second)"
        onChange={(e) => setUi({ speed: 10 ** Number(e.target.value) })}
      />
      <span className="speed-label">{fmtSpeed(speed)}/s</span>
      <span ref={timeRef} className="time">
        t = 0.0
      </span>
      <button
        type="button"
        className={showDeviations ? 'playing' : ''}
        title="Toggle the Δ-from-baseline panel (what is high/low right now)"
        onClick={() => useUi.getState().toggleDeviations()}
      >
        Δ
      </button>
      {diverged && (
        <span className="diverged" title="Simulation produced a non-finite value">
          ⚠ {diverged.path} diverged @t{(diverged.tickIndex * (controller.sim?.dt ?? 1)).toFixed(1)}
        </span>
      )}
    </div>
  )
}

function fmtSpeed(s: number): string {
  if (s >= 100) return s.toFixed(0)
  if (s >= 10) return s.toFixed(1)
  return s.toFixed(2)
}
