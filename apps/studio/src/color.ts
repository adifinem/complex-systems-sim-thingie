/** Deviation (−1…1) → blue↔gray↔red ramp. Precomputed lookup, sRGB lerp. */

const BLUE: [number, number, number] = [0x4e, 0xa1, 0xff]
const GRAY: [number, number, number] = [0x8b, 0x8f, 0x98]
const RED: [number, number, number] = [0xff, 0x5d, 0x5d]

const STEPS = 64
const table: string[] = []
for (let i = 0; i <= 2 * STEPS; i++) {
  const d = (i - STEPS) / STEPS
  const [from, to, k] = d < 0 ? [GRAY, BLUE, -d] : [GRAY, RED, d]
  const c = from.map((f, j) => Math.round(f + ((to[j] as number) - f) * k))
  table.push(`rgb(${c[0]},${c[1]},${c[2]})`)
}

export function devColor(dev: number): string {
  const clamped = dev < -1 ? -1 : dev > 1 ? 1 : dev
  return table[Math.round((clamped + 1) * STEPS)] as string
}

/** Compact value formatting for node badges. */
export function fmtValue(v: number): string {
  if (!Number.isFinite(v)) return v > 0 ? '∞' : Number.isNaN(v) ? 'NaN' : '−∞'
  const a = Math.abs(v)
  if (a >= 1e9) return `${(v / 1e9).toFixed(2)}G`
  if (a >= 1e6) return `${(v / 1e6).toFixed(2)}M`
  if (a >= 1e4) return `${(v / 1e3).toFixed(1)}k`
  if (a >= 100) return v.toFixed(1)
  if (a >= 0.01 || v === 0) return v.toFixed(2)
  return v.toExponential(1)
}
