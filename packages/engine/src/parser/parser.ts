import { type Ast, type BinOp, ParseError, STATEFUL_FNS } from './ast'
import { lex, type Token } from './lexer'

/**
 * Pratt parser for the formula language.
 *
 * Precedence (low → high):
 *   or < and < not < comparisons < + - < * / % < unary - < ^ (right-assoc) < call/primary
 */
export function parse(src: string): Ast {
  return new Parser(src).parseFormula()
}

class Parser {
  private tokens: Token[]
  private i = 0
  private statefulOrdinal = 0

  constructor(src: string) {
    this.tokens = lex(src)
  }

  parseFormula(): Ast {
    const ast = this.parseExpr(0)
    const t = this.peek()
    if (t.type !== 'eof') throw new ParseError(`unexpected "${t.text}"`, t.pos)
    return ast
  }

  private peek(): Token {
    return this.tokens[this.i] as Token
  }

  private next(): Token {
    return this.tokens[this.i++] as Token
  }

  private expect(type: Token['type'], text?: string): Token {
    const t = this.peek()
    if (t.type !== type || (text !== undefined && t.text !== text)) {
      throw new ParseError(`expected ${text ?? type}, got "${t.text || 'end of formula'}"`, t.pos)
    }
    return this.next()
  }

  private parseExpr(minBp: number): Ast {
    return this.parseBinRhs(this.parsePrefix(), minBp)
  }

  /** Continue the binary-operator loop with an already-parsed left operand. */
  private parseBinRhs(seed: Ast, minBp: number): Ast {
    let left = seed
    for (;;) {
      const t = this.peek()
      let op: BinOp | undefined
      if (t.type === 'op' && t.text !== 'not') op = t.text as BinOp
      else if (t.type === 'keyword' && (t.text === 'and' || t.text === 'or')) op = t.text
      if (!op) break
      const bp = binBp(op)
      if (bp < minBp) break
      this.next()
      // ^ is right-associative: parse rhs at the same binding power.
      const right = this.parseExpr(op === '^' ? bp : bp + 1)
      left = { kind: 'bin', op, l: left, r: right }
    }
    return left
  }

  private parsePrefix(): Ast {
    const t = this.peek()
    if (t.type === 'op' && t.text === '-') {
      this.next()
      // Bind tighter than * but looser than ^ so -2^2 = -(2^2).
      return { kind: 'un', op: '-', e: this.parseExpr(70) }
    }
    if ((t.type === 'op' || t.type === 'keyword') && t.text === 'not') {
      this.next()
      return { kind: 'un', op: 'not', e: this.parseExpr(30) }
    }
    return this.parsePrimary()
  }

  private parsePrimary(): Ast {
    const t = this.next()
    switch (t.type) {
      case 'num':
        return { kind: 'num', v: t.value as number }
      case 'punct': {
        if (t.text === '(') {
          const inner = this.parseExpr(0)
          this.expect('punct', ')')
          return inner
        }
        throw new ParseError(`unexpected "${t.text}"`, t.pos)
      }
      case 'keyword': {
        if (t.text === 'true') return { kind: 'num', v: 1 }
        if (t.text === 'false') return { kind: 'num', v: 0 }
        if (t.text === 'if') return this.parseIf(t)
        throw new ParseError(`unexpected keyword "${t.text}"`, t.pos)
      }
      case 'ident': {
        if (this.peek().type === 'punct' && this.peek().text === '(') {
          return this.parseCall(t)
        }
        return { kind: 'ref', name: t.text, pos: t.pos, slot: -1, edgeIdx: -1 }
      }
      default:
        throw new ParseError(
          `unexpected ${t.type === 'eof' ? 'end of formula' : `"${t.text}"`}, expected a value`,
          t.pos,
        )
    }
  }

  /**
   * Two accepted forms, normalized to one AST node:
   *   if(cond, then, else)
   *   if cond then a else b     (cond may be parenthesized)
   */
  private parseIf(ifTok: Token): Ast {
    if (this.peek().type === 'punct' && this.peek().text === '(') {
      // Could be call-form `if(c, a, b)` or sugar with parenthesized cond
      // `if (c) then a else b`. Disambiguate on the token after the first expr.
      this.next() // consume '('
      const first = this.parseExpr(0)
      const after = this.peek()
      if (after.type === 'punct' && after.text === ',') {
        this.next()
        const thenE = this.parseExpr(0)
        this.expect('punct', ',')
        const elseE = this.parseExpr(0)
        this.expect('punct', ')')
        return { kind: 'if', cond: first, then: thenE, else: elseE }
      }
      this.expect('punct', ')')
      // The paren group may be just the START of the condition:
      // `if (a > 0) and (b > 0) then … else …` — continue the operator loop.
      const cond = this.parseBinRhs(first, 0)
      this.expect('keyword', 'then')
      const thenE = this.parseExpr(0)
      this.expect('keyword', 'else')
      const elseE = this.parseExpr(0)
      return { kind: 'if', cond, then: thenE, else: elseE }
    }
    const cond = this.parseExpr(0)
    this.expect('keyword', 'then')
    const thenE = this.parseExpr(0)
    this.expect('keyword', 'else')
    const elseE = this.parseExpr(0)
    void ifTok
    return { kind: 'if', cond, then: thenE, else: elseE }
  }

  private parseCall(nameTok: Token): Ast {
    this.expect('punct', '(')
    const args: Ast[] = []
    if (!(this.peek().type === 'punct' && this.peek().text === ')')) {
      for (;;) {
        args.push(this.parseExpr(0))
        const t = this.peek()
        if (t.type === 'punct' && t.text === ',') {
          this.next()
          continue
        }
        break
      }
    }
    this.expect('punct', ')')
    const ordinal = STATEFUL_FNS.has(nameTok.text) ? this.statefulOrdinal++ : -1
    return { kind: 'call', name: nameTok.text, args, pos: nameTok.pos, ordinal }
  }
}

function binBp(op: BinOp): number {
  switch (op) {
    case 'or':
      return 10
    case 'and':
      return 20
    case '<':
    case '<=':
    case '>':
    case '>=':
    case '==':
    case '!=':
      return 40
    case '+':
    case '-':
      return 50
    case '*':
    case '/':
    case '%':
      return 60
    case '^':
      return 80
  }
}
