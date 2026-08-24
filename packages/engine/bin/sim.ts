#!/usr/bin/env tsx
/**
 * Headless sim runner for humans-in-terminals and LLM agents: run a model,
 * poke it, and read what happened as text instead of screenshots.
 *
 *   pnpm sim <model.json> [options]
 *
 * Options:
 *   --ticks N            steps to run (default 1000)
 *   --watch a,b,c        node paths to report (default: stocks + dials, max 12)
 *   --table [N]          print a sampled value table (N rows, default 20)
 *   --set path=v ...     set values before running (constants/stocks)
 *   --poke t:path=v ...  set a value mid-run at sim-time t (repeatable)
 *   --pin t:path=v       pin (override) a computed node at time t
 *   --unpin t:path       release a pin at time t
 *   --seed N             override the model seed
 *   --json               machine-shaped output instead of the text report
 *
 * The summary is deliberately token-lean: per-node min/max/final, trend
 * (settling/steady/oscillating/runaway), plus warnings and divergence.
 */

import { readFileSync } from 'node:fs'
import path from 'node:path'
import { validateModel } from '../src/model'
import { Simulation } from '../src/simulation'

interface Poke {
  t: number
  path: string
  value?: number
  kind: 'set' | 'pin' | 'unpin'
}

function fail(msg: string): never {
  console.error(`sim: ${msg}`)
  process.exit(1)
}

// ---- argument parsing ------------------------------------------------------

const argv = process.argv.slice(2)
const file = argv.find((a) => !a.startsWith('--'))
if (!file) fail('usage: pnpm sim <model.json> [--ticks N] [--watch a,b] [--table] …')

let ticks = 1000
let watch: string[] | null = null
let tableRows = 0
let seed: number | undefined
let asJson = false
const presets: { path: string; value: number }[] = []
const pokes: Poke[] = []

for (let i = 0; i < argv.length; i++) {
  const a = argv[i] as string
  const next = () => argv[++i] as string
  if (a === '--ticks') ticks = Number(next())
  else if (a === '--watch') watch = next().split(',')
  else if (a === '--table') {
    tableRows = /^\d+$/.test(argv[i + 1] ?? '') ? Number(next()) : 20
  } else if (a === '--seed') seed = Number(next())
  else if (a === '--json') asJson = true
  else if (a === '--set') {
    const m = next().match(/^(.+)=(-?[\d.eE+]+)$/)
    if (!m) fail('--set expects path=value')
    presets.push({ path: m[1] as string, value: Number(m[2]) })
  } else if (a === '--poke' || a === '--pin') {
    const m = next().match(/^(-?[\d.]+):(.+)=(-?[\d.eE+]+)$/)
    if (!m) fail(`${a} expects t:path=value`)
    pokes.push({
      t: Number(m[1]),
      path: m[2] as string,
      value: Number(m[3]),
      kind: a === '--pin' ? 'pin' : 'set',
    })
  } else if (a === '--unpin') {
    const m = next().match(/^(-?[\d.]+):(.+)$/)
    if (!m) fail('--unpin expects t:path')
    pokes.push({ t: Number(m[1]), path: m[2] as string, kind: 'unpin' })
  }
}
pokes.sort((a, b) => a.t - b.t)

// ---- run -------------------------------------------------------------------

// pnpm runs package scripts from the package dir; INIT_CWD is where the user was.
const resolved = path.resolve(process.env.INIT_CWD ?? process.cwd(), file)
const doc = JSON.parse(readFileSync(resolved, 'utf8'))
const { model, issues } = validateModel(doc)
if (!model) fail(`invalid model:\n${issues.map((i) => `  ${i.message}`).join('\n')}`)

const sim = new Simulation(model, seed !== undefined ? { seed } : undefined)
const info = sim.info
if (presets.length > 0) {
  for (const { path, value } of presets) sim.setValue(path, value)
  // Re-evaluate initial values so --set constants reach t=0 seeding too.
  sim.reset()
}

const watched =
  watch ??
  info.paths
    .filter((p, i) => info.types[i] === 'stock' || info.types[i] === 'constant')
    .slice(0, 12)
for (const w of watched) {
  if (!info.slotOf.has(w)) fail(`unknown node "${w}" — paths: ${info.paths.join(', ')}`)
}

const sampleEvery = Math.max(1, Math.floor(ticks / Math.max(tableRows, 200)))
const samples: { t: number; values: number[] }[] = []
const events: string[] = []

let pokeIdx = 0
for (let k = 0; k < ticks; k++) {
  while (pokeIdx < pokes.length && (pokes[pokeIdx] as Poke).t <= sim.time) {
    const p = pokes[pokeIdx++] as Poke
    try {
      if (p.kind === 'pin') sim.setOverride(p.path, p.value as number)
      else if (p.kind === 'unpin') sim.clearOverride(p.path)
      else sim.setValue(p.path, p.value as number)
      events.push(
        `t=${sim.time.toFixed(2)} ${p.kind} ${p.path}${p.value !== undefined ? `=${p.value}` : ''}`,
      )
    } catch (e) {
      events.push(`t=${sim.time.toFixed(2)} FAILED ${p.kind} ${p.path}: ${(e as Error).message}`)
    }
  }
  sim.tick()
  if (k % sampleEvery === 0 || k === ticks - 1) {
    samples.push({
      t: sim.time,
      values: watched.map((w) => sim.getNode(w).value),
    })
  }
  const diverged = sim.getFrame().diverged
  if (diverged) {
    events.push(`t=${sim.time.toFixed(2)} DIVERGED at "${diverged.path}" — stopping`)
    break
  }
}

// ---- analysis --------------------------------------------------------------

type Trend = 'settling' | 'steady' | 'oscillating' | 'runaway' | '—'

function analyzeTrend(h: Float64Array): Trend {
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
  let crossings = 0
  let lastSign = 0
  for (let i = half; i < n; i++) {
    const d = (h[i] as number) - mean
    if (Math.abs(d) < scale * 1e-4) continue
    const sign = d > 0 ? 1 : -1
    if (lastSign !== 0 && sign !== lastSign) crossings++
    lastSign = sign
  }
  const drift1 = Math.abs((h[half] as number) - (h[0] as number))
  const drift2 = Math.abs(last - (h[half] as number))
  if (drift2 > scale * 0.5 && drift2 > drift1 * 1.8) return 'runaway'
  if (a2 < scale * 0.005) return 'steady'
  if (crossings >= 3 && a2 > a1 * 0.6) return 'oscillating'
  if (a2 < a1 * 0.5) return 'settling'
  if (crossings >= 3) return 'oscillating'
  return 'steady'
}

const fmt = (v: number): string => {
  if (!Number.isFinite(v)) return String(v)
  const a = Math.abs(v)
  if (a !== 0 && (a >= 1e5 || a < 1e-3)) return v.toExponential(2)
  return String(Math.round(v * 1000) / 1000)
}

const summary = watched.map((w) => {
  const h = sim.history(w)
  let lo = Number.POSITIVE_INFINITY
  let hi = Number.NEGATIVE_INFINITY
  for (const v of h) {
    if (v < lo) lo = v
    if (v > hi) hi = v
  }
  const nv = sim.getNode(w)
  return {
    path: w,
    final: nv.value,
    min: lo,
    max: hi,
    trend: analyzeTrend(h),
    pinned: nv.overridden || undefined,
  }
})

const out = {
  file,
  ticks,
  dt: sim.dt,
  endTime: sim.time,
  events,
  warnings: [...info.warnings.map((w) => w.message), ...sim.runtimeWarnings],
  diverged: sim.getFrame().diverged,
  summary,
}

// ---- output ----------------------------------------------------------------

if (asJson) {
  console.log(JSON.stringify(out, null, 1))
  process.exit(0)
}

console.log(`${file} · ${ticks} ticks · dt=${sim.dt} · t=${fmt(sim.time)}`)
for (const e of events) console.log(`  ! ${e}`)
for (const w of out.warnings) console.log(`  ⚠ ${w}`)
if (out.diverged) console.log(`  ✗ DIVERGED at "${out.diverged.path}"`)

console.log('\nnode                          final        min…max              trend')
for (const s of summary) {
  console.log(
    `${s.path.padEnd(28)} ${fmt(s.final).padStart(9)}   ${`${fmt(s.min)}…${fmt(s.max)}`.padEnd(20)} ${s.trend}${s.pinned ? ' 📌' : ''}`,
  )
}

if (tableRows > 0) {
  const step = Math.max(1, Math.floor(samples.length / tableRows))
  console.log(`\nt        ${watched.map((w) => w.slice(-12).padStart(12)).join(' ')}`)
  for (let i = 0; i < samples.length; i += step) {
    const s = samples[i] as { t: number; values: number[] }
    console.log(`${fmt(s.t).padEnd(8)} ${s.values.map((v) => fmt(v).padStart(12)).join(' ')}`)
  }
}
