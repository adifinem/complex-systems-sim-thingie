/**
 * Name the behavior of a recent trajectory — the spec's "did it re-balance,
 * stick, spiral, or oscillate?" question, answered from the history ring.
 */
export type Trend = 'settling' | 'steady' | 'oscillating' | 'runaway' | '—'

export function analyzeTrend(h: Float64Array): Trend {
  const n = h.length
  if (n < 48) return '—'
  const last = h[n - 1] as number
  if (!Number.isFinite(last)) return 'runaway'

  let mean = 0
  for (let i = 0; i < n; i++) mean += h[i] as number
  mean /= n

  const amp = (from: number, to: number): number => {
    let lo = Number.POSITIVE_INFINITY
    let hi = Number.NEGATIVE_INFINITY
    for (let i = from; i < to; i++) {
      const v = h[i] as number
      if (v < lo) lo = v
      if (v > hi) hi = v
    }
    return hi - lo
  }
  const half = n >> 1
  const a1 = amp(0, half)
  const a2 = amp(half, n)
  const scale = Math.max(Math.abs(mean), a1, a2, 1e-9)

  // Sign changes of (x − mean) over the recent half → oscillation frequency.
  let crossings = 0
  let lastSign = 0
  for (let i = half; i < n; i++) {
    const d = (h[i] as number) - mean
    if (Math.abs(d) < scale * 1e-4) continue
    const sign = d > 0 ? 1 : -1
    if (lastSign !== 0 && sign !== lastSign) crossings++
    lastSign = sign
  }

  // Runaway: the recent half moves strictly away, faster than the early half.
  const drift1 = Math.abs((h[half] as number) - (h[0] as number))
  const drift2 = Math.abs(last - (h[half] as number))
  if (drift2 > scale * 0.5 && drift2 > drift1 * 1.8) return 'runaway'

  if (a2 < scale * 0.005) return 'steady'
  if (crossings >= 3 && a2 > a1 * 0.6) return 'oscillating'
  if (a2 < a1 * 0.5) return 'settling'
  if (crossings >= 3) return 'oscillating'
  return 'steady'
}

export const TREND_LABEL: Record<Trend, string> = {
  settling: '▁ settling',
  steady: '─ steady',
  oscillating: '∿ oscillating',
  runaway: '⤴ runaway',
  '—': '…',
}
