import { describe, expect, it } from 'vitest'
import { compile } from '../src/compile'
import { validateModel } from '../src/model'
import { parse } from '../src/parser/parser'
import { Simulation } from '../src/simulation'
import { constant, flatModel, flow, link, stock, variable } from './helpers'

/** Regression tests for the adversarial-review findings. */
describe('review fixes', () => {
  it('restore is bit-identical even when a tau expression is time-varying', () => {
    const make = () =>
      new Simulation(
        flatModel(
          [
            stock('s', '0'),
            flow('inflow', '1', { to: 's' }),
            variable('tau_v', '2 + step(2, 3)'),
            variable('d', 'delay(s, tau_v, 0)'),
            variable('sm', 'smooth(s, tau_v, 0)'),
          ],
          [],
          { dt: 1 },
        ),
      )
    const sim = make()
    sim.tick(6)
    const snap = sim.snapshot({ includeHistory: true })
    const cont: number[] = []
    for (let k = 0; k < 5; k++) {
      sim.tick()
      cont.push(sim.getNode('d').value, sim.getNode('sm').value)
    }
    sim.restore(snap)
    const restored: number[] = []
    for (let k = 0; k < 5; k++) {
      sim.tick()
      restored.push(sim.getNode('d').value, sim.getNode('sm').value)
    }
    expect(restored).toEqual(cont)
  })

  it('applyModel of an unchanged model with time-varying taus is bit-identical', () => {
    const model = flatModel(
      [
        stock('s', '0'),
        flow('inflow', '1', { to: 's' }),
        variable('tau_v', '2 + step(2, 3)'),
        variable('d', 'delay(s, tau_v, 0)'),
      ],
      [],
      { dt: 1 },
    )
    const control = new Simulation(model)
    const swapped = new Simulation(model)
    control.tick(6)
    swapped.tick(6)
    expect(swapped.applyModel(swapped.exportModel()).ok).toBe(true)
    for (let k = 0; k < 5; k++) {
      control.tick()
      swapped.tick()
      expect(swapped.getNode('d').value).toBe(control.getNode('d').value)
    }
  })

  it('overridden nodes freeze completely: no edge marking, no history recording', () => {
    const sim = new Simulation(
      flatModel([constant('x', 1), variable('y', 'delay(x, 2, 0)')], [link('x', 'y')], { dt: 1 }),
    )
    const edgeIdx = sim.info.edgeIndexOf.get('x->y') as number
    sim.tick(1)
    expect(sim.getFrame().edgeActive[edgeIdx]).toBe(1)
    sim.setOverride('y', 42)
    sim.tick(3)
    expect(sim.getFrame().edgeActive[edgeIdx]).toBe(0)
    // Delay history froze while pinned: releasing resumes where it left off.
    // Only one live sample (from tick 1) was recorded before the freeze, so
    // the next read still returns the primed 0, then the recorded 1.
    sim.clearOverride('y')
    sim.tick(1)
    expect(sim.getNode('y').value).toBe(0)
    sim.tick(1)
    expect(sim.getNode('y').value).toBe(1)
  })

  it('diverged flag survives snapshot/restore', () => {
    const sim = new Simulation(
      flatModel([stock('s', '1'), flow('boom', 's * s * 10', { to: 's' })]),
    )
    sim.tick(500)
    expect(sim.getFrame().diverged).not.toBeNull()
    const snap = sim.snapshot()
    const fresh = new Simulation(
      flatModel([stock('s', '1'), flow('boom', 's * s * 10', { to: 's' })]),
    )
    fresh.restore(snap)
    expect(fresh.getFrame().diverged).toEqual(sim.getFrame().diverged)
  })

  it('history-less restore leaves history empty, not one bogus reset row', () => {
    const sim = new Simulation(flatModel([stock('s', '0'), flow('f', '1', { to: 's' })]))
    sim.tick(100)
    const snap = sim.snapshot() // no history block
    sim.restore(snap)
    expect(sim.history('s').length).toBe(0)
    sim.tick(1)
    expect(sim.history('s').length).toBe(1)
    expect(sim.history('s')[0]).toBeCloseTo(10, 9) // the restored value, not 0
  })

  it('restored history cursor/count are clamped to the receiving historyLength', () => {
    const big = new Simulation(
      flatModel([stock('s', '0'), flow('f', '1', { to: 's' })], [], { historyLength: 64 }),
    )
    big.tick(50)
    const snap = big.snapshot({ includeHistory: true })
    const small = new Simulation(
      flatModel([stock('s', '0'), flow('f', '1', { to: 's' })], [], { historyLength: 16 }),
    )
    small.restore(snap)
    expect(small.history('s').length).toBeLessThanOrEqual(16)
    small.tick(5) // must not corrupt neighboring slots / throw
    expect(small.getFrame().diverged).toBeNull()
  })

  it('type-changed nodes do not inherit stale values across applyModel', () => {
    const before = flatModel([variable('v', '7'), stock('s', 'v * 0 + 1')])
    const sim = new Simulation(before)
    sim.tick(5)
    const after = flatModel([constant('v', 9), stock('s', '1')])
    const r = sim.applyModel(after)
    expect(r.ok).toBe(true)
    expect(sim.getNode('v').value).toBe(9) // new constant value, not the stale 7
  })

  it('applyModel with an edited constant lets the document win', () => {
    const sim = new Simulation(flatModel([constant('c', 5), variable('v', 'c * 2')]))
    sim.tick(3)
    const edited = flatModel([constant('c', 50), variable('v', 'c * 2')])
    expect(sim.applyModel(edited).ok).toBe(true)
    sim.tick(1)
    expect(sim.getNode('c').value).toBe(50)
    expect(sim.getNode('v').value).toBe(100)
  })

  it('plain restore reverts constants to snapshot values and syncs the model', () => {
    const sim = new Simulation(flatModel([constant('c', 5), variable('v', 'c * 2')]))
    sim.tick(3)
    const snap = sim.snapshot()
    sim.setValue('c', 50)
    sim.tick(3)
    sim.restore(snap)
    sim.tick(1)
    expect(sim.getNode('c').value).toBe(5)
    expect(sim.getNode('v').value).toBe(10)
    const raw = sim.exportModel().graphs.main?.nodes.find((n) => n.id === 'c')
    expect((raw as { value: number }).value).toBe(5)
  })

  it('applyModel surfaces unmatched dropped state', () => {
    const sim = new Simulation(flatModel([variable('old_name', 't'), stock('s', '1')]))
    sim.setOverride('old_name', 9)
    sim.tick(5)
    const renamed = flatModel([variable('new_name', 't'), stock('s', '1')])
    const r = sim.applyModel(renamed)
    expect(r.ok).toBe(true)
    expect('unmatched' in r && (r as { unmatched: string[] }).unmatched).toContain('old_name')
  })

  it('setValue on an overridden stock updates the pin instead of being swallowed', () => {
    const sim = new Simulation(flatModel([stock('s', '10'), flow('f', '1', { to: 's' })]))
    sim.setOverride('s', 10)
    sim.setValue('s', 99)
    sim.tick(3)
    expect(sim.getNode('s').value).toBe(99)
  })

  it('validateModel rejects duplicate edge ids', () => {
    const model = flatModel(
      [constant('a', 1), constant('b', 2), variable('x', 'p + q')],
      [
        { id: 'E', type: 'link', from: 'a', to: 'x', alias: 'p' },
        { id: 'E', type: 'link', from: 'b', to: 'x', alias: 'q' },
      ],
    )
    const { issues } = validateModel(model)
    expect(issues.map((i) => i.message).join('\n')).toMatch(/duplicate edge id "E"/)
  })

  it('compile rejects invalid historyLength', () => {
    const r = compile(flatModel([variable('v', '1')], [], { historyLength: 0 }))
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.errors[0]?.message).toMatch(/historyLength/)
  })

  it('if-sugar accepts conditions that start with a paren group', () => {
    const cases = [
      'if (a > 0) and (b > 0) then 1 else 0',
      'if (a) * 2 > 1 then 1 else 0',
      'if (a > 0) then 1 else 0',
      'if ((a)) then 1 else 0',
    ]
    for (const src of cases) {
      expect(() => parse(src)).not.toThrow()
    }
    const sim = new Simulation(
      flatModel([
        constant('a', 1),
        constant('b', 2),
        variable('out', 'if (a > 0) and (b > 0) then 7 else -7'),
      ]),
    )
    sim.tick()
    expect(sim.getNode('out').value).toBe(7)
  })

  it('time.every below dt is treated as every-tick (matching its warning)', () => {
    const sim = new Simulation(
      flatModel([variable('v', 't', { time: { every: 0.05 } })], [], { dt: 0.1 }),
    )
    sim.tick(3)
    expect(sim.getNode('v').value).toBeCloseTo(0.2, 9) // evaluated every tick
  })
})
