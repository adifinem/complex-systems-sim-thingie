import { ReactFlowProvider } from '@xyflow/react'
import { useEffect } from 'react'
import { GraphCanvas } from './canvas/GraphCanvas'
import { Palette } from './canvas/Palette'
import { controller } from './engine/controller'
import { FileBar } from './panels/FileBar'
import { Inspector } from './panels/Inspector'
import { TabBar } from './panels/TabBar'
import { Transport } from './panels/Transport'
import { redoDoc, undoDoc, useDoc } from './store/doc'
import { useUi } from './store/sim'

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
        </div>
        <Inspector />
      </div>
    </ReactFlowProvider>
  )
}
