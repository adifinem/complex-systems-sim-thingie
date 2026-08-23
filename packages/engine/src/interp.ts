/**
 * Tree-walking formula interpreter.
 *
 * - `if`/`and`/`or` evaluate lazily; every ref actually read marks its link
 *   edge in `ctx.edgeRead` — this is the "which links are active" mechanism.
 * - Stateful builtins (delay/smooth/…) READ their serialized state here and
 *   never evaluate their first argument; that happens in the record phase.
 * - All times inside a formula (t, dt, taus, step/pulse/ramp args) are in the
 *   node's own unit; ctx supplies pre-converted t and dt.
 */

import type { Ast } from './parser/ast'
import { ParseError } from './parser/ast'
import type { Rng } from './rng'

export type FuncState =
  | { kind: 'ring'; buf: Float64Array; cursor: number }
  | { kind: 'smooth'; s: number; k: number }
  | { kind: 'prev'; last: number }
  | { kind: 'd1'; level: number; tauTicks: number }
  | { kind: 'd3'; l1: number; l2: number; l3: number; tau3: number }

export interface EvalCtx {
  values: Float64Array
  /** Sim time in the evaluating node's unit. */
  t: number
  /** Step size in the evaluating node's unit. */
  dt: number
  rng: Rng
  funcState: Map<string, FuncState>
  /** `${nodePath}#` — prefix for stateful call-site ids. */
  callSitePrefix: string
  /** Marks edgeRead[edgeIdx] = 1 for every ref actually dereferenced. Nullable for init/priming. */
  edgeRead: Uint8Array | null
}

export class FormulaEvalError extends Error {
  constructor(
    message: string,
    readonly pos: number,
  ) {
    super(message)
    this.name = 'FormulaEvalError'
  }
}

export function evalAst(a: Ast, ctx: EvalCtx): number {
  switch (a.kind) {
    case 'num':
      return a.v
    case 'ref': {
      if (a.slot === -2) return ctx.t
      if (a.slot === -3) return ctx.dt
      if (a.slot === -4) return Math.PI
      if (a.slot === -5) return Math.E
      if (a.edgeIdx >= 0 && ctx.edgeRead) ctx.edgeRead[a.edgeIdx] = 1
      return ctx.values[a.slot] as number
    }
    case 'un': {
      const v = evalAst(a.e, ctx)
      return a.op === '-' ? -v : v === 0 ? 1 : 0
    }
    case 'bin': {
      switch (a.op) {
        case 'and':
          return evalAst(a.l, ctx) !== 0 ? (evalAst(a.r, ctx) !== 0 ? 1 : 0) : 0
        case 'or':
          return evalAst(a.l, ctx) !== 0 ? 1 : evalAst(a.r, ctx) !== 0 ? 1 : 0
        default:
          break
      }
      const l = evalAst(a.l, ctx)
      const r = evalAst(a.r, ctx)
      switch (a.op) {
        case '+':
          return l + r
        case '-':
          return l - r
        case '*':
          return l * r
        case '/':
          return l / r
        case '%':
          return l % r
        case '^':
          return l ** r
        case '<':
          return l < r ? 1 : 0
        case '<=':
          return l <= r ? 1 : 0
        case '>':
          return l > r ? 1 : 0
        case '>=':
          return l >= r ? 1 : 0
        case '==':
          return l === r ? 1 : 0
        case '!=':
          return l !== r ? 1 : 0
        default:
          return Number.NaN
      }
    }
    case 'if':
      return evalAst(a.cond, ctx) !== 0 ? evalAst(a.then, ctx) : evalAst(a.else, ctx)
    case 'call':
      return evalCall(a, ctx)
  }
}

function evalCall(a: Ast & { kind: 'call' }, ctx: EvalCtx): number {
  const args = a.args
  const n1 = () => (args.length > 0 ? evalAst(args[0] as Ast, ctx) : 0)
  switch (a.name) {
    // ---- stateful reads (input arg NOT evaluated here) ----
    case 'delay': {
      const st = ctx.funcState.get(ctx.callSitePrefix + a.ordinal)
      if (st?.kind !== 'ring') throw new FormulaEvalError('delay(): missing state', a.pos)
      return st.buf[st.cursor] as number
    }
    case 'smooth': {
      const st = ctx.funcState.get(ctx.callSitePrefix + a.ordinal)
      if (st?.kind !== 'smooth') throw new FormulaEvalError('smooth(): missing state', a.pos)
      return st.s
    }
    case 'previous': {
      const st = ctx.funcState.get(ctx.callSitePrefix + a.ordinal)
      if (st?.kind !== 'prev') throw new FormulaEvalError('previous(): missing state', a.pos)
      return st.last
    }
    case 'delay1': {
      const st = ctx.funcState.get(ctx.callSitePrefix + a.ordinal)
      if (st?.kind !== 'd1') throw new FormulaEvalError('delay1(): missing state', a.pos)
      return st.level / st.tauTicks
    }
    case 'delay3': {
      const st = ctx.funcState.get(ctx.callSitePrefix + a.ordinal)
      if (st?.kind !== 'd3') throw new FormulaEvalError('delay3(): missing state', a.pos)
      return st.l3 / st.tau3
    }
    // ---- pure math ----
    case 'min': {
      let m = Number.POSITIVE_INFINITY
      for (const arg of args) m = Math.min(m, evalAst(arg, ctx))
      return m
    }
    case 'max': {
      let m = Number.NEGATIVE_INFINITY
      for (const arg of args) m = Math.max(m, evalAst(arg, ctx))
      return m
    }
    case 'abs':
      return Math.abs(n1())
    case 'floor':
      return Math.floor(n1())
    case 'ceil':
      return Math.ceil(n1())
    case 'round':
      return Math.round(n1())
    case 'sqrt':
      return Math.sqrt(n1())
    case 'exp':
      return Math.exp(n1())
    case 'ln':
      return Math.log(n1())
    case 'log': {
      const x = n1()
      const base = args.length > 1 ? evalAst(args[1] as Ast, ctx) : 10
      return Math.log(x) / Math.log(base)
    }
    case 'pow':
      return n1() ** evalAst(args[1] as Ast, ctx)
    case 'clamp': {
      const x = n1()
      const lo = evalAst(args[1] as Ast, ctx)
      const hi = evalAst(args[2] as Ast, ctx)
      return Math.min(Math.max(x, lo), hi)
    }
    case 'lerp': {
      const p = n1()
      const q = evalAst(args[1] as Ast, ctx)
      const k = evalAst(args[2] as Ast, ctx)
      return p + (q - p) * k
    }
    case 'sign':
      return Math.sign(n1())
    case 'mod': {
      const x = n1()
      const m = evalAst(args[1] as Ast, ctx)
      return ((x % m) + m) % m
    }
    case 'sin':
      return Math.sin(n1())
    case 'cos':
      return Math.cos(n1())
    case 'tan':
      return Math.tan(n1())
    // ---- time (all in the node's unit) ----
    case 'step': {
      const height = n1()
      const startT = evalAst(args[1] as Ast, ctx)
      return ctx.t >= startT ? height : 0
    }
    case 'pulse': {
      const startT = n1()
      const height = args.length > 1 ? evalAst(args[1] as Ast, ctx) : 1
      const width = args.length > 2 ? evalAst(args[2] as Ast, ctx) : ctx.dt
      const repeat = args.length > 3 ? evalAst(args[3] as Ast, ctx) : 0
      if (ctx.t + 1e-12 < startT) return 0
      const local = repeat > 0 ? (ctx.t - startT) % repeat : ctx.t - startT
      return local >= -1e-12 && local < width - 1e-12 ? height : 0
    }
    case 'ramp': {
      const slope = n1()
      const startT = evalAst(args[1] as Ast, ctx)
      const endT = args.length > 2 ? evalAst(args[2] as Ast, ctx) : Number.POSITIVE_INFINITY
      if (ctx.t <= startT) return 0
      return slope * (Math.min(ctx.t, endT) - startT)
    }
    // ---- stochastic ----
    case 'rand': {
      if (args.length >= 2) {
        const lo = n1()
        const hi = evalAst(args[1] as Ast, ctx)
        return lo + ctx.rng.next() * (hi - lo)
      }
      return ctx.rng.next()
    }
    case 'randNormal': {
      const mean = args.length > 0 ? n1() : 0
      const sd = args.length > 1 ? evalAst(args[1] as Ast, ctx) : 1
      return ctx.rng.normal(mean, sd)
    }
    case 'randBool': {
      const p = args.length > 0 ? n1() : 0.5
      return ctx.rng.next() < p ? 1 : 0
    }
    default:
      throw new FormulaEvalError(`unknown function "${a.name}"`, a.pos)
  }
}

export const KNOWN_FNS = new Set([
  'delay',
  'delay1',
  'delay3',
  'smooth',
  'previous',
  'min',
  'max',
  'abs',
  'floor',
  'ceil',
  'round',
  'sqrt',
  'exp',
  'ln',
  'log',
  'pow',
  'clamp',
  'lerp',
  'sign',
  'mod',
  'sin',
  'cos',
  'tan',
  'step',
  'pulse',
  'ramp',
  'rand',
  'randNormal',
  'randBool',
])

export interface FnArity {
  min: number
  max: number
}

export const FN_ARITY: Record<string, FnArity> = {
  delay: { min: 2, max: 3 },
  delay1: { min: 2, max: 3 },
  delay3: { min: 2, max: 3 },
  smooth: { min: 2, max: 3 },
  previous: { min: 1, max: 2 },
  min: { min: 1, max: 99 },
  max: { min: 1, max: 99 },
  abs: { min: 1, max: 1 },
  floor: { min: 1, max: 1 },
  ceil: { min: 1, max: 1 },
  round: { min: 1, max: 1 },
  sqrt: { min: 1, max: 1 },
  exp: { min: 1, max: 1 },
  ln: { min: 1, max: 1 },
  log: { min: 1, max: 2 },
  pow: { min: 2, max: 2 },
  clamp: { min: 3, max: 3 },
  lerp: { min: 3, max: 3 },
  sign: { min: 1, max: 1 },
  mod: { min: 2, max: 2 },
  sin: { min: 1, max: 1 },
  cos: { min: 1, max: 1 },
  tan: { min: 1, max: 1 },
  step: { min: 2, max: 2 },
  pulse: { min: 1, max: 4 },
  ramp: { min: 2, max: 3 },
  rand: { min: 0, max: 2 },
  randNormal: { min: 0, max: 2 },
  randBool: { min: 0, max: 1 },
}

/** Compile-time check of function names and arities; throws ParseError. */
export function checkCalls(ast: Ast): void {
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
      case 'call': {
        if (!KNOWN_FNS.has(a.name)) {
          throw new ParseError(`unknown function "${a.name}"`, a.pos)
        }
        const ar = FN_ARITY[a.name] as FnArity
        if (a.args.length < ar.min || a.args.length > ar.max) {
          const want = ar.min === ar.max ? `${ar.min}` : `${ar.min}–${ar.max}`
          throw new ParseError(
            `${a.name}() takes ${want} argument${ar.max === 1 ? '' : 's'}, got ${a.args.length}`,
            a.pos,
          )
        }
        for (const arg of a.args) walk(arg)
        return
      }
    }
  }
  walk(ast)
}
