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

export interface UiState {
  selectedNodeId: string | null
  selectedEdgeId: string | null
  select: (nodeId: string | null, edgeId?: string | null) => void
}

export const useUi = create<UiState>((set) => ({
  selectedNodeId: null,
  selectedEdgeId: null,
  select: (nodeId, edgeId = null) => set({ selectedNodeId: nodeId, selectedEdgeId: edgeId }),
}))
