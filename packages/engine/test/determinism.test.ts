import { describe, expect, it } from 'vitest'
import type { Model } from '../src/model'
import { Simulation } from '../src/simulation'
import { constant, flatModel, flow, link, stock, variable } from './helpers'

/** A model exercising stochastic, stateful, held, and integrated paths at once. */
function noisyModel(): Model {
  return flatModel([
    stock('s', '10'),
    constant('gain', 0.3),
    flow('in_f', 'gain * s * (0.8 + 0.4 * rand())', { to: 's' }),
    flow('out_f', 'smooth(s, 2) * 0.25', { from: 's' }),
    variable('jitter', 'randNormal(0, 1)', { time: { every: 1 } }),
    variable('lagged', 'delay(s, 0.5, 10)'),
  ])
}

function trajectory(sim: Simulation, ticks: number): number[] {
  const out: number[] = []
  for (let k = 0; k < ticks; k++) {
    sim.tick()
    out.push(
      sim.getNode('s').value,
      sim.getNode('jitter').value,
      sim.getNode('lagged').value,
      sim.getNode('out_f').value,
    )
  }
  return out
}

describe('determinism', () => {
  it('identical model + seed ⇒ bit-identical trajectories', () => {
    const a = trajectory(new Simulation(noisyModel()), 300)
    const b = trajectory(new Simulation(noisyModel()), 300)
    expect(a).toEqual(b)
  })

  it('different seeds diverge (sanity check that rand() is actually used)', () => {
    const a = trajectory(new Simulation(noisyModel(), { seed: 1 }), 50)
    const b = trajectory(new Simulation(noisyModel(), { seed: 2 }), 50)
    expect(a).not.toEqual(b)
  })

  it('snapshot mid-run → restore ⇒ bit-identical continuation, repeatably', () => {
    const sim = new Simulation(noisyModel())
    sim.tick(137)
    const snap = sim.snapshot({ includeHistory: true })
    const cont1 = trajectory(sim, 200)
    sim.restore(snap)
    const cont2 = trajectory(sim, 200)
    sim.restore(snap)
    const cont3 = trajectory(sim, 200)
    expect(cont2).toEqual(cont1)
    expect(cont3).toEqual(cont1)
  })

  it('snapshots survive JSON round-trips', () => {
    const sim = new Simulation(noisyModel())
    sim.tick(64)
    const snap = JSON.parse(JSON.stringify(sim.snapshot()))
    const cont1 = trajectory(sim, 100)
    sim.restore(snap)
    const cont2 = trajectory(sim, 100)
    expect(cont2).toEqual(cont1)
  })

  it('applyModel with an unchanged model ⇒ bit-identical continuation', () => {
    const uninterrupted = new Simulation(noisyModel())
    const swapped = new Simulation(noisyModel())
    uninterrupted.tick(100)
    swapped.tick(100)
    const result = swapped.applyModel(swapped.exportModel())
    expect(result.ok).toBe(true)
    const a = trajectory(uninterrupted, 150)
    const b = trajectory(swapped, 150)
    expect(b).toEqual(a)
  })

  it("setFormula on one node preserves every other node's state", () => {
    const make = () =>
      new Simulation(
        flatModel([
          stock('s', '5'),
          flow('grow', 's * 0.1', { to: 's' }),
          variable('tracker', 'smooth(s, 3)'),
          variable('bystander', '2 * 3'),
        ]),
      )
    const control = make()
    const edited = make()
    control.tick(80)
    edited.tick(80)
    const r = edited.setFormula('bystander', '6') // value-equivalent rewrite
    expect(r.ok).toBe(true)
    control.tick(120)
    edited.tick(120)
    expect(edited.getNode('s').value).toBe(control.getNode('s').value)
    expect(edited.getNode('tracker').value).toBe(control.getNode('tracker').value)
  })

  it('editing a delay tau mid-run re-samples the buffer length', () => {
    const sim = new Simulation(
      flatModel([variable('src', 't'), variable('lagged', 'delay(src, 0.5, 0)')]),
    )
    sim.tick(50) // t=5; lagged tracks t−0.5
    expect(sim.getNode('lagged').value).toBeCloseTo(4.9 - 0.5, 9)
    const r = sim.setFormula('lagged', 'delay(src, 2, 0)')
    expect(r.ok).toBe(true)
    sim.tick(50) // buffer was re-seeded at swap; after 20 ticks it lags by 2
    expect(sim.getNode('lagged').value).toBeCloseTo(9.9 - 2, 9)
  })

  it('setFormula is atomic: a bad edit leaves the running program untouched', () => {
    const sim = new Simulation(flatModel([variable('x', 't * 2')]))
    sim.tick(10)
    const r = sim.setFormula('x', 't * (')
    expect(r.ok).toBe(false)
    sim.tick(1)
    expect(sim.getNode('x').value).toBeCloseTo(1 * 2, 9) // still the old formula, t=1.0
  })

  it('overrides and edge activity survive snapshot/restore', () => {
    const sim = new Simulation(
      flatModel(
        [
          constant('a', 1),
          constant('b', 2),
          constant('mode', 1),
          variable('x', 'if(mode > 0, a, b)'),
        ],
        [link('a', 'x'), link('b', 'x'), link('mode', 'x')],
      ),
    )
    sim.tick(5)
    sim.setOverride('x', 99)
    sim.tick(5)
    const snap = sim.snapshot()
    const fresh = new Simulation(
      flatModel(
        [
          constant('a', 1),
          constant('b', 2),
          constant('mode', 1),
          variable('x', 'if(mode > 0, a, b)'),
        ],
        [link('a', 'x'), link('b', 'x'), link('mode', 'x')],
      ),
    )
    fresh.restore(snap)
    expect(fresh.getNode('x').value).toBe(99)
    expect(fresh.getNode('x').overridden).toBe(true)
    fresh.clearOverride('x')
    fresh.tick(1)
    expect(fresh.getNode('x').value).toBe(1)
  })
})
