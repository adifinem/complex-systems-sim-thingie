import { ReactFlowProvider } from '@xyflow/react'
import { useEffect } from 'react'
import { GraphCanvas } from './canvas/GraphCanvas'
import { Palette } from './canvas/Palette'
import { controller } from './engine/controller'
import { DeviationsPanel } from './panels/DeviationsPanel'
import { FileBar } from './panels/FileBar'
import { Inspector } from './panels/Inspector'
import { TabBar } from './panels/TabBar'
import { Transport } from './panels/Transport'
import { redoDoc, undoDoc, useDoc } from './store/doc'
import { useUi } from './store/sim'

/** Single-node clipboard; survives tab switches so paste works across graphs. */
let clipboard: import('@mindmap/engine').ModelNode | null = null

export function App() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement
      if (
        el.tagName === 'INPUT' ||
        el.tagName === 'TEXTAREA' ||
        el.tagName === 'SELECT' ||
        el.isContentEditable
      ) {
        return
      }
      if (e.code === 'Space') {
        e.preventDefault()
        controller.toggle()
      } else if (e.key === '.') {
        controller.stepOnce()
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'c') {
        const doc = useDoc.getState()
        const sel = useUi.getState().selectedNodeId
        const node = sel
          ? doc.model.graphs[doc.activeGraphId]?.nodes.find((n) => n.id === sel)
          : undefined
        if (node) {
          clipboard = JSON.parse(JSON.stringify(node))
          e.preventDefault()
        }
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'v') {
        if (clipboard) {
          e.preventDefault()
          useUi.getState().select(useDoc.getState().pasteNode(clipboard))
        }
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'd') {
        const doc = useDoc.getState()
        const sel = useUi.getState().selectedNodeId
        const node = sel
          ? doc.model.graphs[doc.activeGraphId]?.nodes.find((n) => n.id === sel)
          : undefined
        if (node) {
          e.preventDefault()
          useUi.getState().select(doc.pasteNode(node))
        }
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
        e.preventDefault()
        if (e.shiftKey) redoDoc()
        else undoDoc()
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') {
        e.preventDefault()
        redoDoc()
      } else if (e.key === 'r' || e.key === 'R') {
        controller.reset()
      } else if (e.key === 'Escape') {
        // go up one level of the module breadcrumb
        const ui = useUi.getState()
        if (ui.breadcrumb.length > 0) {
          const doc = useDoc.getState()
          const next = ui.breadcrumb.slice(0, -1)
          ui.popToCrumb(next.length)
          doc.setActiveGraph(
            next.length > 0
              ? (next[next.length - 1]?.graphId ?? doc.model.mainGraph)
              : doc.model.mainGraph,
          )
        }
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  return (
    <ReactFlowProvider>
      <div className="app">
        <Palette />
        <div className="canvas-wrap">
          <GraphCanvas />
          <FileBar />
          <TabBar />
          <Transport />
          <DeviationsPanel />
        </div>
        <Inspector />
      </div>
    </ReactFlowProvider>
  )
}
