import { ParseError } from './ast'

export type TokenType = 'num' | 'ident' | 'op' | 'punct' | 'keyword' | 'eof'

export interface Token {
  type: TokenType
  text: string
  pos: number
  value?: number
}

const KEYWORDS = new Set(['if', 'then', 'else', 'and', 'or', 'not', 'true', 'false'])
const PUNCT = new Set(['(', ')', ','])

export function lex(src: string): Token[] {
  const tokens: Token[] = []
  let i = 0
  const n = src.length
  while (i < n) {
    const c = src[i] as string
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') {
      i++
      continue
    }
    const pos = i
    // numbers: 1, 1.5, .5, 1e-3, 2E+4
    if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(src[i + 1] ?? ''))) {
      let j = i
      while (j < n && /[0-9]/.test(src[j] as string)) j++
      if (src[j] === '.') {
        j++
        while (j < n && /[0-9]/.test(src[j] as string)) j++
      }
      if (src[j] === 'e' || src[j] === 'E') {
        let k = j + 1
        if (src[k] === '+' || src[k] === '-') k++
        if (/[0-9]/.test(src[k] ?? '')) {
          j = k
          while (j < n && /[0-9]/.test(src[j] as string)) j++
        }
      }
      const text = src.slice(i, j)
      tokens.push({ type: 'num', text, pos, value: Number(text) })
      i = j
      continue
    }
    // identifiers / keywords
    if (/[A-Za-z_]/.test(c)) {
      let j = i + 1
      while (j < n && /[A-Za-z0-9_]/.test(src[j] as string)) j++
      const text = src.slice(i, j)
      tokens.push({ type: KEYWORDS.has(text) ? 'keyword' : 'ident', text, pos })
      i = j
      continue
    }
    // [bracketed name with spaces]
    if (c === '[') {
      const close = src.indexOf(']', i + 1)
      if (close === -1) throw new ParseError('unclosed "[" — expected "]"', pos)
      const inner = src.slice(i + 1, close).trim()
      if (inner.length === 0) throw new ParseError('empty [bracketed name]', pos)
      tokens.push({ type: 'ident', text: inner, pos })
      i = close + 1
      continue
    }
    if (PUNCT.has(c)) {
      tokens.push({ type: 'punct', text: c, pos })
      i++
      continue
    }
    // multi-char operators first
    const two = src.slice(i, i + 2)
    if (two === '<=' || two === '>=' || two === '==' || two === '!=' || two === '<>') {
      tokens.push({ type: 'op', text: two === '<>' ? '!=' : two, pos })
      i += 2
      continue
    }
    if (two === '&&') {
      tokens.push({ type: 'op', text: 'and', pos })
      i += 2
      continue
    }
    if (two === '||') {
      tokens.push({ type: 'op', text: 'or', pos })
      i += 2
      continue
    }
    if ('+-*/%^<>'.includes(c)) {
      tokens.push({ type: 'op', text: c, pos })
      i++
      continue
    }
    if (c === '=') {
      tokens.push({ type: 'op', text: '==', pos })
      i++
      continue
    }
    if (c === '!') {
      tokens.push({ type: 'op', text: 'not', pos })
      i++
      continue
    }
    throw new ParseError(`unexpected character "${c}"`, pos)
  }
  tokens.push({ type: 'eof', text: '', pos: n })
  return tokens
}
