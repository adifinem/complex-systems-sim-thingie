import { describe, expect, it } from 'vitest'
import { Simulation } from '../src/simulation'
import { constant, flatModel, flow, stock, variable } from './helpers'

describe('tick semantics', () => {
  it('bathtub: constant net flow integrates exactly (Euler is exact here)', () => {
    const sim = new Simulation(
      flatModel([
        stock('level', '100'),
        flow('inflow', '2', { to: 'level' }),
        flow('outflow', '1', { from: 'level' }),
      ]),
    )
    sim.tick(50) // dt=0.1 → t=5, level = 100 + 5·(2−1)
    expect(sim.getNode('level').value).toBeCloseTo(105, 9)
    expect(sim.time).toBeCloseTo(5, 12)
  })

  it('exponential decay tracks the closed form and error shrinks with dt', () => {
    const run = (dt: number) => {
      const sim = new Simulation(
        flatModel([stock('s', '100'), flow('decay', 's * 0.5', { from: 's' })], [], { dt }),
      )
      sim.tick(Math.round(4 / dt)) // to t=4
      return sim.getNode('s').value
    }
    const exact = 100 * Math.exp(-0.5 * 4)
    const errBig = Math.abs(run(0.1) - exact)
    const errSmall = Math.abs(run(0.01) - exact)
    expect(errBig).toBeLessThan(2)
    expect(errSmall).toBeLessThan(errBig / 5) // ~linear in dt
  })

  it('uniflow clamps negative rates to zero', () => {
    const sim = new Simulation(
      flatModel([stock('s', '10'), flow('f', '-5', { to: 's' }, { uniflow: true })]),
    )
    sim.tick(10)
    expect(sim.getNode('s').value).toBe(10)
  })

  it('nonNegative stocks clamp at zero', () => {
    const sim = new Simulation(
      flatModel([stock('s', '1', { nonNegative: true }), flow('drain', '10', { from: 's' })]),
    )
    sim.tick(20)
    expect(sim.getNode('s').value).toBe(0)
  })

  it('overrides pin computed nodes and release cleanly', () => {
    const sim = new Simulation(flatModel([stock('s', '0'), flow('f', '2', { to: 's' })]))
    sim.tick(10) // s = 2
    expect(sim.getNode('s').value).toBeCloseTo(2, 9)
    sim.setOverride('f', 0)
    sim.tick(10) // pinned: no growth
    expect(sim.getNode('s').value).toBeCloseTo(2, 9)
    expect(sim.getNode('f').overridden).toBe(true)
    sim.clearOverride('f')
    sim.tick(10)
    expect(sim.getNode('s').value).toBeCloseTo(4, 9)
  })

  it('setValue overwrites stock state and constant model values', () => {
    const sim = new Simulation(
      flatModel([stock('s', '0'), constant('rate', 1), flow('f', 'rate', { to: 's' })]),
    )
    sim.tick(10)
    expect(sim.getNode('s').value).toBeCloseTo(1, 9)
    sim.setValue('s', 100)
    sim.setValue('rate', 10)
    sim.tick(10)
    expect(sim.getNode('s').value).toBeCloseTo(110, 9)
    const rate = sim.exportModel().graphs.main?.nodes.find((n) => n.id === 'rate')
    expect((rate as { value: number }).value).toBe(10)
  })

  it('time builtins: step/pulse/ramp fire at the right times', () => {
    const sim = new Simulation(
      flatModel(
        [
          variable('st', 'step(5, 1)'),
          variable('pu', 'pulse(1, 3, dt)'),
          variable('ra', 'ramp(2, 1, 2)'),
        ],
        [],
        { dt: 0.5 },
      ),
    )
    const rows: number[][] = []
    for (let k = 0; k < 7; k++) {
      rows.push([sim.getNode('st').value, sim.getNode('pu').value, sim.getNode('ra').value])
      sim.tick()
    }
    // rows[0] is the init eval at t=0; tick k evaluates at t=(k−1)·dt, so
    // rows[k] (k≥1) shows the eval at t = (k−1)·0.5.
    expect(rows.map((r) => r[0])).toEqual([0, 0, 0, 5, 5, 5, 5])
    expect(rows.map((r) => r[1])).toEqual([0, 0, 0, 3, 0, 0, 0])
    expect(rows.map((r) => r[2])).toEqual([0, 0, 0, 0, 1, 2, 2])
  })
})

describe('time units', () => {
  it('an hour-unit flow of 1/hr fills exactly 1 after one simulated hour of second-ticks', () => {
    const sim = new Simulation(
      flatModel(
        [stock('tank', '0'), flow('fill', '1', { to: 'tank' }, { time: { unit: 'hour' } })],
        [],
        { dt: 60 }, // one step = 60 ticks (seconds) = 1 minute
      ),
    )
    sim.tick(60) // 60 minutes
    expect(sim.getNode('tank').value).toBeCloseTo(1, 9)
  })

  it('t reads in the node own unit', () => {
    const sim = new Simulation(
      flatModel(
        [variable('hours', 't', { time: { unit: 'hour' } }), variable('ticks', 't')],
        [],
        { dt: 1800 }, // half-hour steps
      ),
    )
    sim.tick(4) // sim time is now 7200 ticks; the last eval ran at t = 3·1800 = 5400
    expect(sim.time).toBeCloseTo(7200, 9)
    expect(sim.getNode('ticks').value).toBeCloseTo(5400, 9)
    expect(sim.getNode('hours').value).toBeCloseTo(1.5, 9)
  })

  it('delay taus convert through the node unit', () => {
    // delay of 1 hour in a minute-unit node… use hour-unit node with tau 1:
    // buffer = 3600 ticks / dt(60) = 60 steps.
    const sim = new Simulation(
      flatModel(
        [
          variable('src', 't / 3600'),
          variable('lagged', 'delay(src, 1, -1)', { time: { unit: 'hour' } }),
        ],
        [],
        { dt: 60 },
      ),
    )
    sim.tick(59)
    expect(sim.getNode('lagged').value).toBe(-1) // still primed
    sim.tick(2) // tick 61 reads the sample recorded at tick 1: src(t=0) = 0
    expect(sim.getNode('lagged').value).toBeCloseTo(0, 12)
    sim.tick(1) // tick 62 reads src(t=60) = 60/3600
    expect(sim.getNode('lagged').value).toBeCloseTo(60 / 3600, 12)
  })

  it('custom unit tables override defaults', () => {
    const sim = new Simulation(
      flatModel([stock('s', '0'), flow('f', '1', { to: 's' }, { time: { unit: 'beat' } })], [], {
        dt: 1,
        timeUnits: { beat: 4 },
      }),
    )
    sim.tick(4)
    expect(sim.getNode('s').value).toBeCloseTo(1, 9)
  })
})

describe('sample-and-hold (time.every)', () => {
  it('holds values between scheduled evaluations', () => {
    const sim = new Simulation(
      flatModel(
        [variable('v', 't', { time: { every: 1 } })], // every 1 tick, dt 0.1
        [],
        { dt: 0.1 },
      ),
    )
    const seen = new Set<number>()
    for (let k = 0; k < 25; k++) {
      seen.add(Math.round(sim.getNode('v').value * 1e9) / 1e9)
      sim.tick()
    }
    expect([...seen].sort((a, b) => a - b)).toEqual([0, 1, 2])
  })

  it('held rates still integrate every tick (zero-order hold)', () => {
    const sim = new Simulation(
      flatModel([stock('s', '0'), flow('f', 't', { to: 's' }, { time: { every: 1 } })], [], {
        dt: 0.5,
      }),
    )
    // rate holds: evals at t=0 (0), t=1 (1), t=2 (2)…
    // steps: t0 rate0, t.5 rate0, t1 rate1, t1.5 rate1, t2 rate2 …
    sim.tick(4) // t=2: s = .5·(0+0+1+1) = 1
    expect(sim.getNode('s').value).toBeCloseTo(1, 9)
  })
})
