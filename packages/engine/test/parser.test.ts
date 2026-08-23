import { describe, expect, it } from 'vitest'
import { checkCalls } from '../src/interp'
import { ParseError } from '../src/parser/ast'
import { parse } from '../src/parser/parser'

/** Serialize an AST to a canonical s-expression for table-driven assertions. */
function sexpr(src: string): string {
  const ast = parse(src)
  const w = (a: ReturnType<typeof parse>): string => {
    switch (a.kind) {
      case 'num':
        return String(a.v)
      case 'ref':
        return a.name
      case 'un':
        return `(${a.op} ${w(a.e)})`
      case 'bin':
        return `(${a.op} ${w(a.l)} ${w(a.r)})`
      case 'if':
        return `(if ${w(a.cond)} ${w(a.then)} ${w(a.else)})`
      case 'call':
        return `(${a.name}${a.args.map((x) => ` ${w(x)}`).join('')})`
    }
  }
  return w(ast)
}

describe('parser', () => {
  const table: [string, string][] = [
    ['1 + 2 * 3', '(+ 1 (* 2 3))'],
    ['(1 + 2) * 3', '(* (+ 1 2) 3)'],
    ['2 ^ 3 ^ 2', '(^ 2 (^ 3 2))'], // right-assoc
    ['-2 ^ 2', '(- (^ 2 2))'], // -(2^2)
    ['-a * b', '(* (- a) b)'],
    ['a ^ -b', '(^ a (- b))'],
    ['1 < 2 and 3 >= 2', '(and (< 1 2) (>= 3 2))'],
    ['a or b and c', '(or a (and b c))'],
    ['not a or b', '(or (not a) b)'],
    ['a = b', '(== a b)'],
    ['a <> b', '(!= a b)'],
    ['a && b || !c', '(or (and a b) (not c))'],
    ['1.5e2 + .5', '(+ 150 0.5)'],
    ['true + false', '(+ 1 0)'],
    ['[Birth Rate] * 2', '(* Birth_Rate 2)'.replace('Birth_Rate', 'Birth Rate')],
    ['min(a, b, 3)', '(min a b 3)'],
    ['if(a > 1, b, c)', '(if (> a 1) b c)'],
    ['if a > 1 then b else c', '(if (> a 1) b c)'],
    ['if (a > 1) then b else c', '(if (> a 1) b c)'],
    ['if(x, 1, 0) + 2', '(+ (if x 1 0) 2)'],
    ['5 % 3', '(% 5 3)'],
  ]
  for (const [src, expected] of table) {
    it(`parses ${JSON.stringify(src)}`, () => {
      expect(sexpr(src)).toBe(expected)
    })
  }

  it('reports error positions', () => {
    try {
      parse('1 + * 2')
      expect.unreachable()
    } catch (e) {
      expect(e).toBeInstanceOf(ParseError)
      expect((e as ParseError).pos).toBe(4)
    }
  })

  const badFormulas = ['', '1 +', 'foo(', '(1 + 2', '[unclosed', 'if a then b', '1 2', 'a , b']
  for (const src of badFormulas) {
    it(`rejects ${JSON.stringify(src)}`, () => {
      expect(() => parse(src)).toThrow(ParseError)
    })
  }

  it('assigns stateful ordinals in source order', () => {
    const ast = parse('smooth(delay(x, 5), 3) + previous(y)')
    const found: [string, number][] = []
    const walk = (a: ReturnType<typeof parse>): void => {
      if (a.kind === 'call') {
        if (a.ordinal >= 0) found.push([a.name, a.ordinal])
        for (const arg of a.args) walk(arg)
      } else if (a.kind === 'bin') {
        walk(a.l)
        walk(a.r)
      } else if (a.kind === 'un') walk(a.e)
    }
    walk(ast)
    // parseCall assigns ordinals bottom-up: inner delay first
    expect(found.sort((p, q) => p[1] - q[1])).toEqual([
      ['delay', 0],
      ['smooth', 1],
      ['previous', 2],
    ])
  })

  it('checkCalls rejects unknown functions and bad arity', () => {
    expect(() => checkCalls(parse('frobnicate(1)'))).toThrow(/unknown function/)
    expect(() => checkCalls(parse('abs(1, 2)'))).toThrow(/takes 1 argument/)
    expect(() => checkCalls(parse('delay(x)'))).toThrow(/takes 2–3 arguments/)
    expect(() => checkCalls(parse('clamp(1, 2, 3)'))).not.toThrow()
  })
})
