import type { Graph, Model, ModelEdge, ModelNode, SimConfig } from '../src/model'

/** Terse single-graph model builder for tests. */
export function flatModel(nodes: ModelNode[], edges: ModelEdge[] = [], sim: SimConfig = {}): Model {
  const graph: Graph = { name: 'Main', nodes, edges }
  return {
    version: 1,
    mainGraph: 'main',
    sim: { dt: 0.1, seed: 42, ...sim },
    graphs: { main: graph },
  }
}

export const stock = (id: string, initial: string, extra: Partial<ModelNode> = {}): ModelNode =>
  ({ id, type: 'stock', initial, ...extra }) as ModelNode

export const flow = (
  id: string,
  formula: string,
  anchors: { from?: string | null; to?: string | null } = {},
  extra: Partial<ModelNode> = {},
): ModelNode => ({ id, type: 'flow', formula, ...anchors, ...extra }) as ModelNode

export const variable = (id: string, formula: string, extra: Partial<ModelNode> = {}): ModelNode =>
  ({ id, type: 'variable', formula, ...extra }) as ModelNode

export const constant = (id: string, value: number, extra: Partial<ModelNode> = {}): ModelNode =>
  ({ id, type: 'constant', value, ...extra }) as ModelNode

export const link = (from: string, to: string, alias?: string): ModelEdge => ({
  id: `${from}->${to}`,
  type: 'link',
  from,
  to,
  ...(alias ? { alias } : {}),
})

/** Thermostat: balancing loop with analytic equilibrium at 17.5. */
export function thermostatModel(): Model {
  return flatModel([
    stock('room_temp', '18'),
    constant('setpoint', 20),
    constant('outdoor', 5),
    flow('heating', 'max(0, setpoint - room_temp) * 0.5', { to: 'room_temp' }),
    flow('heat_loss', '(room_temp - outdoor) * 0.1', { from: 'room_temp' }),
  ])
}

/** Lotka-Volterra predator-prey: oscillates. */
export function predatorPreyModel(): Model {
  return flatModel(
    [
      stock('prey', '40', { nonNegative: true }),
      stock('pred', '8', { nonNegative: true }),
      flow('prey_growth', '0.5 * prey', { to: 'prey' }),
      flow('predation', '0.05 * prey * pred', { from: 'prey' }),
      flow('pred_growth', '0.005 * prey * pred', { to: 'pred' }),
      flow('pred_death', '0.3 * pred', { from: 'pred' }),
    ],
    [],
    { dt: 0.01 },
  )
}

/**
 * Delayed negative feedback: T' = gain · (target − T(t−lag)).
 * Oscillates (growing) when gain·lag > π/2; damps when well below.
 */
export function showerModel(gain: number, lag = 1): Model {
  return flatModel(
    [
      stock('temp', '20'),
      constant('target', 40),
      constant('gain', gain),
      flow('adjust', 'gain * (target - delay(temp, lag, 20))', { to: 'temp' }),
      constant('lag', lag),
    ],
    [],
    { dt: 0.01 },
  )
}

/** Count sign changes of the first difference — a crude oscillation detector. */
export function directionChanges(series: Float64Array | number[], eps = 1e-9): number {
  let changes = 0
  let lastSign = 0
  for (let i = 1; i < series.length; i++) {
    const d = (series[i] as number) - (series[i - 1] as number)
    if (Math.abs(d) <= eps) continue
    const sign = d > 0 ? 1 : -1
    if (lastSign !== 0 && sign !== lastSign) changes++
    lastSign = sign
  }
  return changes
}
