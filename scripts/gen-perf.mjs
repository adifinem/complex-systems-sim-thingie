#!/usr/bin/env node
/**
 * Generate the M4 perf-gate fixture: ~300 nodes / ~400 edges of coupled
 * oscillating clusters, written to models/bench/perf-300.json.
 * Deterministic layout (no RNG) so the file is stable in git.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const CLUSTERS = 50 // 6 nodes each → 300 nodes
const nodes = []
const edges = []
let edgeN = 0

const link = (from, to) => {
  edges.push({ id: `e${edgeN++}`, type: 'link', from, to })
}

for (let i = 0; i < CLUSTERS; i++) {
  const col = i % 10
  const row = (i / 10) | 0
  const x = col * 340
  const y = row * 300
  const s = `stock_${i}`
  const inf = `in_${i}`
  const out = `out_${i}`
  const gain = `gain_${i}`
  const smoothed = `smooth_${i}`
  const gate = `gate_${i}`
  // Damped driven oscillator per cluster, phase-offset by index; every 5th
  // cluster couples to its neighbor so activity propagates.
  nodes.push(
    {
      id: s,
      type: 'stock',
      name: s,
      initial: `${80 + (i % 7) * 10}`,
      ui: { x: x + 100, y: y + 120 },
    },
    {
      id: inf,
      type: 'flow',
      name: inf,
      formula: `gain_${i} * (100 - ${s}) + 6 * sin(t / ${3 + (i % 5)})`,
      to: s,
      ui: { x, y: y + 140 },
    },
    {
      id: out,
      type: 'flow',
      name: out,
      formula: `${s} * 0.08`,
      from: s,
      ui: { x: x + 220, y: y + 140 },
    },
    {
      id: gain,
      type: 'constant',
      name: gain,
      value: 0.15 + (i % 4) * 0.05,
      dial: { min: 0, max: 1, step: 0.01 },
      ui: { x, y: y + 30 },
    },
    {
      id: smoothed,
      type: 'variable',
      name: smoothed,
      formula: `smooth(${s}, 4)`,
      ui: { x: x + 120, y: y + 230 },
    },
    {
      id: gate,
      type: 'variable',
      name: gate,
      formula: `if(${smoothed} > 100, ${s}, ${smoothed})`,
      ui: { x: x + 240, y: y + 230 },
    },
  )
  link(gain, inf)
  link(s, inf)
  link(s, out)
  link(s, smoothed)
  link(smoothed, gate)
  link(s, gate)
  if (i > 0 && i % 5 !== 0) {
    // couple to previous cluster: its smoothed value nudges our inflow
    edges.pop() // keep edge budget ~400: drop the s→gate link for coupled ones
    link(`smooth_${i - 1}`, gate)
  }
}

const model = {
  version: 1,
  meta: { name: 'perf-300', notes: 'Synthetic perf-gate fixture: ~300 nodes, ~400 edges.' },
  sim: { dt: 0.1, seed: 1 },
  mainGraph: 'main',
  graphs: { main: { name: 'Main', nodes, edges } },
}

const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../models/bench')
mkdirSync(dir, { recursive: true })
writeFileSync(path.join(dir, 'perf-300.json'), `${JSON.stringify(model, null, 2)}\n`)
console.log(
  `wrote models/bench/perf-300.json: ${nodes.length} nodes, ${edges.length} link edges (+${nodes.filter((n) => n.type === 'flow').length * 2 - CLUSTERS * 0} pipe segments)`,
)
