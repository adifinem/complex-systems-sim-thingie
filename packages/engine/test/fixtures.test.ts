import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import type { Model } from '../src/model'
import { validateModel } from '../src/model'
import { Simulation } from '../src/simulation'
import { directionChanges } from './helpers'

/**
 * The shipped example models are also regression fixtures: every file in
 * models/examples must validate, compile, and run without diverging — so the
 * demos can never silently rot.
 */
const EXAMPLES_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../models/examples')

function loadFixture(name: string): Model {
  const raw = JSON.parse(readFileSync(path.join(EXAMPLES_DIR, `${name}.json`), 'utf8'))
  const { model, issues } = validateModel(raw)
  if (!model) throw new Error(issues.map((i) => i.message).join('\n'))
  return model
}

describe('example fixtures', () => {
  const files = readdirSync(EXAMPLES_DIR)
    .filter((f: string) => f.endsWith('.json'))
    .map((f: string) => f.slice(0, -5))

  it('ships the promised example set', () => {
    expect(files).toEqual(
      expect.arrayContaining([
        'bathtub',
        'thermostat',
        'predator-prey',
        'viral-growth',
        'shower-delay',
      ]),
    )
  })

  for (const name of files) {
    it(`${name}: validates, compiles, and runs 2000 ticks without diverging`, () => {
      const sim = new Simulation(loadFixture(name))
      expect(sim.info.warnings.filter((w) => w.missingLink)).toEqual([])
      sim.tick(2000)
      expect(sim.getFrame().diverged).toBeNull()
    })
  }

  it('thermostat settles at its analytic equilibrium', () => {
    const sim = new Simulation(loadFixture('thermostat'))
    sim.tick(2000)
    expect(sim.getNode('room_temp').value).toBeCloseTo(17.5, 2)
  })

  it('bathtub reaches inflow/drain equilibrium', () => {
    const sim = new Simulation(loadFixture('bathtub'))
    sim.tick(5000)
    expect(sim.getNode('level').value).toBeCloseTo(2 / 0.02, 1)
  })

  it('predator-prey oscillates', () => {
    const sim = new Simulation(loadFixture('predator-prey'))
    const prey: number[] = []
    for (let k = 0; k < 8000; k++) {
      sim.tick()
      if (k % 20 === 0) prey.push(sim.getNode('prey').value)
    }
    expect(directionChanges(prey, 1e-6)).toBeGreaterThanOrEqual(4)
  })

  it('viral-growth produces an S-curve with final size below the population', () => {
    const sim = new Simulation(loadFixture('viral-growth'))
    sim.tick(6000)
    const recovered = sim.getNode('recovered').value
    expect(recovered).toBeGreaterThan(5000)
    expect(recovered).toBeLessThan(10000)
    expect(sim.getNode('infected').value).toBeLessThan(50)
  })

  it('shower-delay settles at gain 0.8 and oscillates harder at gain 4', () => {
    const calm = new Simulation(loadFixture('shower-delay'))
    calm.tick(6000)
    expect(Math.abs(calm.getNode('temp').value - 40)).toBeLessThan(1)

    const model = loadFixture('shower-delay')
    const gain = model.graphs.main?.nodes.find((n) => n.id === 'gain')
    if (gain && gain.type === 'constant') gain.value = 4
    const wild = new Simulation(model)
    const temps: number[] = []
    for (let k = 0; k < 3000; k++) {
      wild.tick()
      temps.push(wild.getNode('temp').value)
    }
    const amp = (xs: number[]) => Math.max(...xs) - Math.min(...xs)
    expect(amp(temps.slice(2000))).toBeGreaterThan(amp(temps.slice(0, 1000)))
  })
})
