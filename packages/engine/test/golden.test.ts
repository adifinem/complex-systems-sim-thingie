import { describe, expect, it } from 'vitest'
import { Simulation } from '../src/simulation'
import {
  constant,
  directionChanges,
  flatModel,
  flow,
  predatorPreyModel,
  showerModel,
  stock,
  thermostatModel,
} from './helpers'

describe('golden models', () => {
  it('thermostat settles at its analytic equilibrium and re-balances after a perturbation', () => {
    const sim = new Simulation(thermostatModel())
    sim.tick(2000) // t=200, timescale 1/0.6 ≈ 1.7 → fully converged
    // heating = loss ⇒ 0.5(20−T) = 0.1(T−5) ⇒ T = 10.5/0.6 = 17.5
    expect(sim.getNode('room_temp').value).toBeCloseTo(17.5, 3)

    sim.setValue('outdoor', 15)
    sim.tick(2000)
    // 0.5(20−T) = 0.1(T−15) ⇒ T = 11.5/0.6
    expect(sim.getNode('room_temp').value).toBeCloseTo(11.5 / 0.6, 3)
  })

  it('thermostat deviation: initial-mode saturates when stuck, ewma-mode fades to gray', () => {
    const initialMode = new Simulation(thermostatModel())
    initialMode.tick(4000)
    // Settled at 17.5 vs initial baseline 18 → below baseline, slightly blue,
    // and it STAYS there (that's the "stuck vs re-balanced" signal).
    const devInitial = initialMode.getNode('room_temp').deviation
    expect(devInitial).toBeLessThan(-0.05)

    const m = thermostatModel()
    const rt = m.graphs.main?.nodes.find((n) => n.id === 'room_temp')
    if (rt) rt.baseline = { mode: 'ewma', tau: 5 }
    const ewmaMode = new Simulation(m)
    ewmaMode.tick(4000)
    // EWMA baseline caught up with the settled value → gray.
    expect(Math.abs(ewmaMode.getNode('room_temp').deviation)).toBeLessThan(0.01)
  })

  it('predator-prey oscillates and stays bounded', () => {
    const sim = new Simulation(predatorPreyModel())
    const prey: number[] = []
    for (let k = 0; k < 8000; k++) {
      sim.tick()
      if (k % 10 === 0) prey.push(sim.getNode('prey').value)
    }
    expect(directionChanges(prey, 1e-6)).toBeGreaterThanOrEqual(4)
    expect(Math.max(...prey)).toBeLessThan(4000)
    expect(Math.min(...prey)).toBeGreaterThan(0)
    expect(sim.getFrame().diverged).toBeNull()
  })

  it('shower delay: low gain damps, high gain oscillates with growing amplitude', () => {
    const low = new Simulation(showerModel(0.2))
    low.tick(6000) // t=60
    expect(Math.abs(low.getNode('temp').value - 40)).toBeLessThan(0.5)

    const high = new Simulation(showerModel(4))
    const temps: number[] = []
    for (let k = 0; k < 3000; k++) {
      high.tick()
      temps.push(high.getNode('temp').value)
    }
    const firstThird = temps.slice(0, 1000)
    const lastThird = temps.slice(2000)
    const amp = (xs: number[]) => Math.max(...xs) - Math.min(...xs)
    expect(
      directionChanges(Float64Array.from(temps.filter((_, i) => i % 5 === 0))),
    ).toBeGreaterThan(4)
    expect(amp(lastThird)).toBeGreaterThan(amp(firstThird) * 1.5)
  })

  it('divergence watchdog names the first offender', () => {
    const sim = new Simulation(
      flatModel([stock('s', '1'), flow('boom', 's * s * 10', { to: 's' }), constant('k', 1)]),
    )
    sim.tick(500)
    const frame = sim.getFrame()
    expect(frame.diverged).not.toBeNull()
    expect(['s', 'boom']).toContain(frame.diverged?.path)
  })

  it('history() returns coherent eval-time rows, oldest-first', () => {
    const sim = new Simulation(flatModel([stock('s', '0'), flow('f', '1', { to: 's' })]))
    sim.tick(10)
    // Each tick records the report row at its eval time (pre-integration), so
    // after 10 ticks the rows are s(0)…s(0.9). The live frame shows s=1.0.
    const h = sim.history('s', 5)
    expect(h.length).toBe(5)
    expect(h[0]).toBeCloseTo(0.5, 9)
    expect(h[4]).toBeCloseTo(0.9, 9)
    expect(sim.getNode('s').value).toBeCloseTo(1.0, 9)
    for (let i = 1; i < h.length; i++) {
      expect((h[i] as number) > (h[i - 1] as number)).toBe(true)
    }
  })
})
