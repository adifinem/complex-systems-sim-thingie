import { describe, expect, it } from 'vitest'
import { Simulation } from '../src/simulation'
import { constant, flatModel, link, variable } from './helpers'

function edgeActive(sim: Simulation, edgeId: string): number {
  const idx = sim.info.edgeIndexOf.get(edgeId)
  if (idx === undefined) throw new Error(`no edge ${edgeId}`)
  return sim.getFrame().edgeActive[idx] as number
}

describe('read-set link activity', () => {
  it('only the taken if-branch marks its links active; flipping the condition flips the edges', () => {
    const model = flatModel(
      [
        constant('mode', 1),
        constant('a', 5),
        constant('b', 7),
        variable('out', 'if(mode > 0, a, b)'),
      ],
      [link('mode', 'out'), link('a', 'out'), link('b', 'out')],
    )
    const sim = new Simulation(model)
    sim.tick()
    expect(edgeActive(sim, 'mode->out')).toBe(1)
    expect(edgeActive(sim, 'a->out')).toBe(1)
    expect(edgeActive(sim, 'b->out')).toBe(0)
    expect(sim.getNode('out').value).toBe(5)

    sim.setValue('mode', 0)
    sim.tick()
    expect(edgeActive(sim, 'a->out')).toBe(0)
    expect(edgeActive(sim, 'b->out')).toBe(1)
    expect(sim.getNode('out').value).toBe(7)
  })

  it('short-circuit and/or leave unread links inactive', () => {
    const model = flatModel(
      [constant('gate', 0), constant('x', 1), variable('out', 'gate and x')],
      [link('gate', 'out'), link('x', 'out')],
    )
    const sim = new Simulation(model)
    sim.tick()
    expect(edgeActive(sim, 'gate->out')).toBe(1)
    expect(edgeActive(sim, 'x->out')).toBe(0) // short-circuited

    sim.setValue('gate', 1)
    sim.tick()
    expect(edgeActive(sim, 'x->out')).toBe(1)
  })

  it('links read inside delay/smooth arguments stay active (recorded every tick)', () => {
    const model = flatModel(
      [constant('src', 3), variable('out', 'smooth(src, 2)')],
      [link('src', 'out')],
    )
    const sim = new Simulation(model)
    sim.tick(3)
    expect(edgeActive(sim, 'src->out')).toBe(1)
  })

  it('an overridden node reads nothing — its inbound links go dormant', () => {
    const model = flatModel([constant('a', 5), variable('out', 'a * 2')], [link('a', 'out')])
    const sim = new Simulation(model)
    sim.tick()
    expect(edgeActive(sim, 'a->out')).toBe(1)
    sim.setOverride('out', 1)
    sim.tick()
    expect(edgeActive(sim, 'a->out')).toBe(0)
    sim.clearOverride('out')
    sim.tick()
    expect(edgeActive(sim, 'a->out')).toBe(1)
  })
})
