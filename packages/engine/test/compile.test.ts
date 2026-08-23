import { describe, expect, it } from 'vitest'
import { compile } from '../src/compile'
import { constant, flatModel, flow, link, stock, variable } from './helpers'

function errorsOf(model: ReturnType<typeof flatModel>): string[] {
  const r = compile(model)
  return r.ok ? [] : r.errors.map((e) => e.message)
}

describe('compile', () => {
  it('rejects algebraic cycles with the loop named and a hint', () => {
    const msgs = errorsOf(flatModel([variable('a', 'b + 1'), variable('b', 'a * 2')]))
    expect(msgs.join('\n')).toMatch(/circular dependency/)
    expect(msgs.join('\n')).toMatch(/a/)
    expect(msgs.join('\n')).toMatch(/b/)
    expect(msgs.join('\n')).toMatch(/stock, previous\(\), or delay\(\)/)
  })

  it('accepts cycles broken by a stock', () => {
    const r = compile(flatModel([stock('s', '10'), flow('grow', 's * 0.1', { to: 's' })]))
    expect(r.ok).toBe(true)
  })

  it('accepts cycles broken by previous()', () => {
    const r = compile(flatModel([variable('a', 'previous(b, 0) + 1'), variable('b', 'a * 2')]))
    expect(r.ok).toBe(true)
  })

  it('rejects self-referencing variables', () => {
    const msgs = errorsOf(flatModel([variable('x', 'x + 1')]))
    expect(msgs.join('\n')).toMatch(/circular/)
  })

  it('reports unknown identifiers with a suggestion', () => {
    const msgs = errorsOf(flatModel([constant('workload', 4), variable('x', 'worklaod * 2')]))
    expect(msgs.join('\n')).toMatch(/unknown name "worklaod"/)
    expect(msgs.join('\n')).toMatch(/did you mean "workload"/)
  })

  it('rejects duplicate aliases on one target', () => {
    const msgs = errorsOf(
      flatModel(
        [constant('a', 1), constant('b', 2), variable('x', 'v')],
        [link('a', 'x', 'v'), link('b', 'x', 'v')],
      ),
    )
    expect(msgs.join('\n')).toMatch(/duplicate alias "v"/)
  })

  it('warns on sibling references without a link edge', () => {
    const r = compile(flatModel([constant('a', 1), variable('x', 'a + 1')]))
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.warnings.map((w) => w.message).join('\n')).toMatch(/without a link edge/)
    }
  })

  it('resolves link aliases and marks edge indices', () => {
    const r = compile(
      flatModel(
        [constant('source_node', 3), variable('x', 'inp * 2')],
        [link('source_node', 'x', 'inp')],
      ),
    )
    expect(r.ok).toBe(true)
  })

  it('rejects circular initial values', () => {
    const msgs = errorsOf(flatModel([stock('s', 'v * 2'), variable('v', 's + 1')]))
    expect(msgs.join('\n')).toMatch(/circular initial values/)
  })

  it('delay without explicit initial cannot break an init cycle; with one it can', () => {
    const cyclic = flatModel([flow('f', 'delay(f, 1) + 1', {})])
    expect(errorsOf(cyclic).join('\n')).toMatch(/circular initial values/)
    const fixed = flatModel([flow('f', 'delay(f, 1, 0) + 1', {})])
    expect(compile(fixed).ok).toBe(true)
  })

  it('rejects stateful builtins in stock initials', () => {
    const msgs = errorsOf(flatModel([stock('s', 'smooth(1, 5)')]))
    expect(msgs.join('\n')).toMatch(/not allowed in initial values/)
  })

  it('rejects flows anchored to non-stocks', () => {
    const msgs = errorsOf(flatModel([constant('c', 1), flow('f', '1', { to: 'c' })]))
    expect(msgs.join('\n')).toMatch(/must reference a stock/)
  })

  it('warns on nonNegative stocks with multiple outflows', () => {
    const r = compile(
      flatModel([
        stock('s', '10', { nonNegative: true }),
        flow('out1', '1', { from: 's' }),
        flow('out2', '1', { from: 's' }),
      ]),
    )
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.warnings.map((w) => w.message).join('\n')).toMatch(/nonNegative with 2 outflows/)
    }
  })

  it('rejects unknown time units', () => {
    const msgs = errorsOf(flatModel([variable('x', '1', { time: { unit: 'fortnight' } })]))
    expect(msgs.join('\n')).toMatch(/unknown time unit "fortnight"/)
  })

  it('evaluation order is deterministic and respects dependencies', () => {
    const r = compile(
      flatModel([variable('c', 'b + 1'), variable('b', 'a + 1'), variable('a', '1')]),
    )
    expect(r.ok).toBe(true)
    if (r.ok) {
      const order = r.compiled.evalOrder.map((s) => r.compiled.paths[s])
      expect(order).toEqual(['a', 'b', 'c'])
    }
  })
})
