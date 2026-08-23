/** Formula AST. Formulas compile once to an AST; evaluation is tree-walking. */

export type Ast =
  | { kind: 'num'; v: number }
  | { kind: 'ref'; name: string; pos: number; slot: number; edgeIdx: number }
  | { kind: 'un'; op: '-' | 'not'; e: Ast }
  | { kind: 'bin'; op: BinOp; l: Ast; r: Ast }
  | { kind: 'if'; cond: Ast; then: Ast; else: Ast }
  | Call

export interface Call {
  kind: 'call'
  name: string
  args: Ast[]
  pos: number
  /**
   * For stateful builtins (delay/smooth/…): ordinal of this call within its
   * formula, assigned at parse time. Combined with the node path it forms the
   * stable call-site id that keys serialized state.
   */
  ordinal: number
}

export type BinOp =
  | '+'
  | '-'
  | '*'
  | '/'
  | '%'
  | '^'
  | '<'
  | '<='
  | '>'
  | '>='
  | '=='
  | '!='
  | 'and'
  | 'or'

export class ParseError extends Error {
  constructor(
    message: string,
    /** Character offset into the formula source. */
    readonly pos: number,
  ) {
    super(message)
    this.name = 'ParseError'
  }
}

export const STATEFUL_FNS = new Set(['delay', 'delay1', 'delay3', 'smooth', 'previous'])
export const RANDOM_FNS = new Set(['rand', 'randNormal', 'randBool'])

/** Collect every distinct referenced name (for dependency extraction). */
export function collectRefs(ast: Ast): { orderRefs: Set<string>; historyRefs: Set<string> } {
  const orderRefs = new Set<string>()
  const historyRefs = new Set<string>()
  const walk = (a: Ast, inHistory: boolean): void => {
    switch (a.kind) {
      case 'num':
        return
      case 'ref':
        ;(inHistory ? historyRefs : orderRefs).add(a.name)
        return
      case 'un':
        walk(a.e, inHistory)
        return
      case 'bin':
        walk(a.l, inHistory)
        walk(a.r, inHistory)
        return
      case 'if':
        walk(a.cond, inHistory)
        walk(a.then, inHistory)
        walk(a.else, inHistory)
        return
      case 'call': {
        if (STATEFUL_FNS.has(a.name)) {
          // First argument is the history-recorded input: refs inside it do NOT
          // constrain evaluation order (they're sampled in the record phase).
          for (let i = 0; i < a.args.length; i++) {
            walk(a.args[i] as Ast, i === 0 ? true : inHistory)
          }
        } else {
          for (const arg of a.args) walk(arg, inHistory)
        }
        return
      }
    }
  }
  walk(ast, false)
  // A name read both eagerly and in history still constrains order.
  for (const n of orderRefs) historyRefs.delete(n)
  return { orderRefs, historyRefs }
}

/** All stateful call sites in the AST, in ordinal order. */
export function collectStatefulCalls(ast: Ast): Call[] {
  const out: Call[] = []
  const walk = (a: Ast): void => {
    switch (a.kind) {
      case 'num':
      case 'ref':
        return
      case 'un':
        walk(a.e)
        return
      case 'bin':
        walk(a.l)
        walk(a.r)
        return
      case 'if':
        walk(a.cond)
        walk(a.then)
        walk(a.else)
        return
      case 'call':
        if (STATEFUL_FNS.has(a.name)) out.push(a)
        for (const arg of a.args) walk(arg)
        return
    }
  }
  walk(ast)
  out.sort((a, b) => a.ordinal - b.ordinal)
  return out
}

export function usesRandom(ast: Ast): boolean {
  let found = false
  const walk = (a: Ast): void => {
    if (found) return
    switch (a.kind) {
      case 'num':
      case 'ref':
        return
      case 'un':
        walk(a.e)
        return
      case 'bin':
        walk(a.l)
        walk(a.r)
        return
      case 'if':
        walk(a.cond)
        walk(a.then)
        walk(a.else)
        return
      case 'call':
        if (RANDOM_FNS.has(a.name)) {
          found = true
          return
        }
        for (const arg of a.args) walk(arg)
        return
    }
  }
  walk(ast)
  return found
}
