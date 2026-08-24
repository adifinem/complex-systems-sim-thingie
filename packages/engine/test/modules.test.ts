import { describe, expect, it } from 'vitest'
import { compile } from '../src/compile'
import type { Model } from '../src/model'
import { Simulation } from '../src/simulation'
import { flatModel, flow, link, stock, variable } from './helpers'

/** Root graph with two "population" module instances driven by different rates. */
function twoInstanceModel(): Model {
  return {
    version: 1,
    mainGraph: 'root',
    sim: { dt: 0.1, seed: 5 },
    graphs: {
      root: {
        nodes: [
          { id: 'fast_rate', type: 'constant', value: 0.2 },
          { id: 'slow_rate', type: 'constant', value: 0.05 },
          { id: 'popA', type: 'module', ref: 'population' },
          { id: 'popB', type: 'module', ref: 'population' },
          { id: 'total', type: 'variable', formula: 'a + b' },
        ],
        edges: [
          { id: 'e1', type: 'link', from: 'fast_rate', to: 'popA', toPort: 'growth_rate' },
          { id: 'e2', type: 'link', from: 'slow_rate', to: 'popB', toPort: 'growth_rate' },
          { id: 'e3', type: 'link', from: 'popA', fromPort: 'size', to: 'total', alias: 'a' },
          { id: 'e4', type: 'link', from: 'popB', fromPort: 'size', to: 'total', alias: 'b' },
        ],
      },
      population: {
        nodes: [
          { id: 'growth_rate', type: 'input', default: '0.1' },
          { id: 'pop', type: 'stock', initial: '100' },
          { id: 'births', type: 'flow', formula: 'pop * growth_rate', to: 'pop' },
          { id: 'size', type: 'output', formula: 'pop' },
        ],
        edges: [
          { id: 'i1', type: 'link', from: 'pop', to: 'births' },
          { id: 'i2', type: 'link', from: 'growth_rate', to: 'births' },
        ],
      },
    },
  }
}

describe('modules', () => {
  it('feedback routed through a module matches the equivalent flat model exactly', () => {
    const modular: Model = {
      version: 1,
      mainGraph: 'root',
      sim: { dt: 0.1, seed: 1 },
      graphs: {
        root: {
          nodes: [
            { id: 'temp', type: 'stock', initial: '18' },
            { id: 'ctrl', type: 'module', ref: 'controller' },
            { id: 'heat', type: 'flow', formula: 'power', to: 'temp' },
            { id: 'loss', type: 'flow', formula: 'temp * 0.1', from: 'temp' },
          ],
          edges: [
            { id: 'r1', type: 'link', from: 'temp', to: 'ctrl', toPort: 'reading' },
            {
              id: 'r2',
              type: 'link',
              from: 'ctrl',
              fromPort: 'output_power',
              to: 'heat',
              alias: 'power',
            },
            { id: 'r3', type: 'link', from: 'temp', to: 'loss' },
          ],
        },
        controller: {
          nodes: [
            { id: 'reading', type: 'input', default: '0' },
            { id: 'output_power', type: 'output', formula: 'max(0, (20 - reading) * 0.5)' },
          ],
          edges: [{ id: 'c1', type: 'link', from: 'reading', to: 'output_power' }],
        },
      },
    }
    const flat = flatModel(
      [
        stock('temp', '18'),
        variable('power_v', 'max(0, (20 - temp) * 0.5)'),
        flow('heat', 'power_v', { to: 'temp' }),
        flow('loss', 'temp * 0.1', { from: 'temp' }),
      ],
      [link('temp', 'power_v'), link('power_v', 'heat'), link('temp', 'loss')],
      { seed: 1 },
    )
    const a = new Simulation(modular)
    const b = new Simulation(flat)
    for (let k = 0; k < 500; k++) {
      a.tick()
      b.tick()
      expect(a.getNode('temp').value).toBe(b.getNode('temp').value)
    }
  })

  it('two instances of one graph have independent state', () => {
    const sim = new Simulation(twoInstanceModel())
    sim.tick(100) // t=10
    const popA = sim.getNode('popA/pop').value
    const popB = sim.getNode('popB/pop').value
    expect(popA).toBeGreaterThan(popB) // 0.2 growth vs 0.05
    expect(popA).toBeCloseTo(100 * (1 + 0.2 * 0.1) ** 100, 6)
    expect(popB).toBeCloseTo(100 * (1 + 0.05 * 0.1) ** 100, 6)
    expect(sim.getNode('total').value).toBeCloseTo(
      sim.history('popA/size', 1)[0] === undefined
        ? popA + popB
        : sim.getNode('popA/size').value + sim.getNode('popB/size').value,
      9,
    )
  })

  it('unbound inputs use their default; standalone graphs still run', () => {
    const m = twoInstanceModel()
    ;(m.graphs.root?.edges as { id: string }[]).splice(0, 1) // unbind popA
    const sim = new Simulation(m)
    sim.tick(10)
    const popStart = sim.getNode('popA/pop').value
    sim.tick(1) // births evaluates against start-of-tick pop
    // popA now grows at the default 0.1
    expect(sim.getNode('popA/births').value).toBeCloseTo(popStart * 0.1, 9)
  })

  it('frozen mode holds the whole value table; unfreezing resumes', () => {
    const sim = new Simulation(twoInstanceModel())
    sim.tick(50)
    const heldPop = sim.getNode('popA/pop').value
    const r = sim.setModuleMode('popA', 'frozen')
    expect(r.ok).toBe(true)
    const heldSize = sim.getNode('popA/size').value // last evaluated output
    sim.tick(100)
    expect(sim.getNode('popA/pop').value).toBe(heldPop) // frozen: no growth
    expect(sim.getNode('popA/size').value).toBe(heldSize) // output held too
    expect(sim.getNode('popB/pop').value).toBeGreaterThan(100) // others run on
    // The held output stays readable by the outer graph (same eval epoch):
    expect(sim.getNode('total').value).toBeCloseTo(
      sim.getNode('popA/size').value + sim.getNode('popB/size').value,
      9,
    )
    sim.setModuleMode('popA', 'full')
    sim.tick(10)
    expect(sim.getNode('popA/pop').value).toBeGreaterThan(heldPop) // resumed
  })

  it('summary mode replaces the inner network with per-output formulas', () => {
    const m = twoInstanceModel()
    const popA = m.graphs.root?.nodes.find((n) => n.id === 'popA')
    if (popA && popA.type === 'module') {
      popA.mode = 'summary'
      popA.summary = { size: '100 + growth_rate * 1000' }
    }
    const sim = new Simulation(m)
    sim.tick(10)
    // summary output: 100 + 0.2·1000 = 300, regardless of any inner dynamics
    expect(sim.getNode('popA/size').value).toBeCloseTo(300, 9)
    // the inner network is not instantiated:
    expect(sim.info.slotOf.has('popA/pop')).toBe(false)
    expect(sim.info.slotOf.has('popA/births')).toBe(false)
    // but the full instance popB still is:
    expect(sim.info.slotOf.has('popB/pop')).toBe(true)
  })

  it('summary mode without a formula for an output is a compile error', () => {
    const m = twoInstanceModel()
    const popA = m.graphs.root?.nodes.find((n) => n.id === 'popA')
    if (popA && popA.type === 'module') popA.mode = 'summary'
    const r = compile(m)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.errors.map((e) => e.message).join('\n')).toMatch(/no summary formula/)
  })

  it('recursive module references are a compile error naming the cycle', () => {
    const m: Model = {
      version: 1,
      mainGraph: 'a',
      graphs: {
        a: { nodes: [{ id: 'mb', type: 'module', ref: 'b' }], edges: [] },
        b: { nodes: [{ id: 'ma', type: 'module', ref: 'a' }], edges: [] },
      },
    }
    const r = compile(m)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.errors.map((e) => e.message).join('\n')).toMatch(/recursive module/)
  })

  it('module time.unit sets the subtree default (innermost override wins)', () => {
    const m: Model = {
      version: 1,
      mainGraph: 'root',
      sim: { dt: 60 }, // one step = a minute of second-ticks
      graphs: {
        root: {
          nodes: [{ id: 'eco', type: 'module', ref: 'inner', time: { unit: 'hour' } }],
          edges: [],
        },
        inner: {
          nodes: [
            { id: 'tank', type: 'stock', initial: '0' },
            // inherits "hour": rate 1/hr → fills 1.0 after 60 min
            { id: 'fill', type: 'flow', formula: '1', to: 'tank' },
            // overrides to tick: t in raw ticks
            { id: 'raw_t', type: 'variable', formula: 't', time: { unit: 'tick' } },
            { id: 'hours_t', type: 'variable', formula: 't' },
          ],
          edges: [],
        },
      },
    }
    const sim = new Simulation(m)
    sim.tick(60)
    expect(sim.getNode('eco/tank').value).toBeCloseTo(1, 9)
    expect(sim.getNode('eco/raw_t').value).toBeCloseTo(59 * 60, 9)
    expect(sim.getNode('eco/hours_t').value).toBeCloseTo((59 * 60) / 3600, 9)
  })

  it('instances survive snapshot/restore bit-identically', () => {
    const sim = new Simulation(twoInstanceModel())
    sim.tick(77)
    const snap = sim.snapshot({ includeHistory: true })
    const cont: number[] = []
    for (let k = 0; k < 50; k++) {
      sim.tick()
      cont.push(sim.getNode('popA/pop').value, sim.getNode('total').value)
    }
    sim.restore(snap)
    const replay: number[] = []
    for (let k = 0; k < 50; k++) {
      sim.tick()
      replay.push(sim.getNode('popA/pop').value, sim.getNode('total').value)
    }
    expect(replay).toEqual(cont)
  })

  it('binding an input port twice is a compile error', () => {
    const m = twoInstanceModel()
    m.graphs.root?.edges.push({
      id: 'dup',
      type: 'link',
      from: 'slow_rate',
      to: 'popA',
      toPort: 'growth_rate',
    })
    const r = compile(m)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.errors.map((e) => e.message).join('\n')).toMatch(/bound twice/)
  })

  it('links into modules require toPort; outputs require fromPort', () => {
    const m = twoInstanceModel()
    m.graphs.root?.edges.push({ id: 'bad', type: 'link', from: 'fast_rate', to: 'popA' })
    const r = compile(m)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.errors.map((e) => e.message).join('\n')).toMatch(/must name a toPort/)
  })

  it('constants inside instances stay shared through setValue', () => {
    const m = twoInstanceModel()
    m.graphs.population?.nodes.push({ id: 'scale', type: 'constant', value: 2 })
    const g = m.graphs.population
    if (g) {
      const births = g.nodes.find((n) => n.id === 'births')
      if (births && births.type === 'flow') births.formula = 'pop * growth_rate * scale'
    }
    const sim = new Simulation(m)
    sim.setValue('popA/scale', 3)
    // the constant belongs to the population graph — both instances see it
    expect(sim.getNode('popA/scale').value).toBe(3)
    expect(sim.getNode('popB/scale').value).toBe(3)
  })
})
