import type { CompileIssue } from '@mindmap/engine'
import { create } from 'zustand'

/**
 * Transient run status for React. Per-tick VALUES never pass through here —
 * they go engine → AnimationBridge → DOM.
 */
export type RunStatus = 'idle' | 'running' | 'paused'

export interface SimUiState {
  status: RunStatus
  /** Ticks of sim time per real second. */
  speed: number
  compileErrors: CompileIssue[]
  compileWarnings: CompileIssue[]
  runtimeWarnings: string[]
  diverged: { path: string; tickIndex: number } | null

  set: (patch: Partial<Omit<SimUiState, 'set'>>) => void
}

export const useSimUi = create<SimUiState>((set) => ({
  status: 'idle',
  speed: 20,
  compileErrors: [],
  compileWarnings: [],
  runtimeWarnings: [],
  diverged: null,
  set: (patch) => set(patch),
}))

export interface Crumb {
  /** Module node id in the parent graph. */
  moduleId: string
  /** Graph the module instance opens into. */
  graphId: string
}

export interface UiState {
  selectedNodeId: string | null
  selectedEdgeId: string | null
  /** Instance trail when the canvas shows the inside of a module. */
  breadcrumb: Crumb[]
  /** Deviations side panel visibility. */
  showDeviations: boolean
  select: (nodeId: string | null, edgeId?: string | null) => void
  pushCrumb: (crumb: Crumb) => void
  popToCrumb: (depth: number) => void
  clearCrumbs: () => void
  setCrumbs: (crumbs: Crumb[]) => void
  toggleDeviations: () => void
}

export const useUi = create<UiState>((set) => ({
  selectedNodeId: null,
  selectedEdgeId: null,
  breadcrumb: [],
  select: (nodeId, edgeId = null) => set({ selectedNodeId: nodeId, selectedEdgeId: edgeId }),
  pushCrumb: (crumb) =>
    set((s) => ({ breadcrumb: [...s.breadcrumb, crumb], selectedNodeId: null })),
  popToCrumb: (depth) => set((s) => ({ breadcrumb: s.breadcrumb.slice(0, depth) })),
  clearCrumbs: () => set({ breadcrumb: [] }),
  setCrumbs: (crumbs) => set({ breadcrumb: crumbs }),
  showDeviations: false,
  toggleDeviations: () => set((s) => ({ showDeviations: !s.showDeviations })),
}))

/** "econ/labor/" — path prefix for the instance currently on the canvas. */
export function crumbPrefix(breadcrumb: Crumb[]): string {
  return breadcrumb.length === 0 ? '' : `${breadcrumb.map((c) => c.moduleId).join('/')}/`
}
