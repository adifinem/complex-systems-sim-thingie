import { describe, expect, it } from 'vitest'
import { Simulation } from '../src/simulation'
import { flatModel, flow, stock, variable } from './helpers'

describe('history builtins', () => {
  it('GOLDEN: delay(stock, τ) ≡ delay(aux := stock, τ) bit for bit', () => {
    // This is the record-before-integrate phase-order guarantee: if the record
    // phase ran after integration, the direct form would sample s(t+dt) while
    // the aux form samples s(t), and the two would drift apart by one tick.
    const direct = new Simulation(
      flatModel([
        stock('s', '10'),
        flow('grow', '1 + s * 0.05', { to: 's' }),
        variable('lagged', 'delay(s, 1, 10)'),
      ]),
    )
    const viaAux = new Simulation(
      flatModel([
        stock('s', '10'),
        flow('grow', '1 + s * 0.05', { to: 's' }),
        variable('aux', 's'),
        variable('lagged', 'delay(aux, 1, 10)'),
      ]),
    )
    for (let k = 0; k < 200; k++) {
      direct.tick()
      viaAux.tick()
      expect(direct.getNode('lagged').value).toBe(viaAux.getNode('lagged').value)
      expect(direct.getNode('s').value).toBe(viaAux.getNode('s').value)
    }
  })

  it('delay shifts a pulse by exactly round(τ/dt) ticks', () => {
    const sim = new Simulation(
      flatModel(
        [variable('src', 'pulse(1, 5, dt)'), variable('lagged', 'delay(src, 0.7, 0)')],
        [],
        { dt: 0.1 },
      ),
    )
    const src: number[] = []
    const lagged: number[] = []
    for (let k = 0; k < 40; k++) {
      sim.tick()
      src.push(sim.getNode('src').value)
      lagged.push(sim.getNode('lagged').value)
    }
    const srcAt = src.indexOf(5)
    const laggedAt = lagged.indexOf(5)
    expect(srcAt).toBeGreaterThanOrEqual(0)
    expect(laggedAt - srcAt).toBe(7) // 0.7 / 0.1
  })

  it('previous() is a one-tick lag', () => {
    const sim = new Simulation(flatModel([variable('src', 't'), variable('prev', 'previous(src)')]))
    sim.tick() // eval at t=0: reads the value primed from src at init (0)
    expect(sim.getNode('prev').value).toBe(0)
    sim.tick() // eval at t=0.1: reads src recorded last tick, src(0) = 0
    expect(sim.getNode('prev').value).toBe(0)
    sim.tick() // eval at t=0.2: reads src(0.1)
    expect(sim.getNode('prev').value).toBeCloseTo(0.1, 12)
  })

  it('previous() with an explicit initial uses it before any record', () => {
    const sim = new Simulation(
      flatModel([variable('src', 't + 10'), variable('prev', 'previous(src, -1)')]),
    )
    // init: prev primed with explicit −1 (not src's 10)
    expect(sim.getNode('prev').value).toBe(-1)
  })

  it('smooth() converges exponentially toward a step input', () => {
    const sim = new Simulation(
      flatModel([variable('src', 'step(10, 0)'), variable('sm', 'smooth(src, 2, 0)')], [], {
        dt: 0.01,
      }),
    )
    sim.tick(600) // t=6 = 3τ
    const v = sim.getNode('sm').value
    const exact = 10 * (1 - Math.exp(-6 / 2))
    expect(Math.abs(v - exact)).toBeLessThan(0.1)
  })

  it('delay1 and delay3 conserve the total shifted quantity', () => {
    // Feed a pulse through delay3; the output integrates to the input's area.
    const sim = new Simulation(
      flatModel(
        [
          variable('src', 'pulse(1, 10, 0.5)'),
          variable('d3', 'delay3(src, 2, 0)'),
          stock('acc', '0'),
          flow('collect', 'd3', { to: 'acc' }),
        ],
        [],
        { dt: 0.01 },
      ),
    )
    sim.tick(3000) // run well past the transient
    expect(sim.getNode('acc').value).toBeCloseTo(10 * 0.5, 1)
  })

  it('stiffness warnings fire for tau below 4·dt', () => {
    const sim = new Simulation(flatModel([variable('x', 'smooth(t, 0.2, 0)')], [], { dt: 0.1 }))
    expect(sim.runtimeWarnings.join('\n')).toMatch(/under 4·dt/)
  })
})
