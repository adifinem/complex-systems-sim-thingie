import { ReactFlowProvider } from '@xyflow/react'
import { useEffect } from 'react'
import { GraphCanvas } from './canvas/GraphCanvas'
import { Palette } from './canvas/Palette'
import { controller } from './engine/controller'
import { FileBar } from './panels/FileBar'
import { Inspector } from './panels/Inspector'
import { Transport } from './panels/Transport'

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
      } else if (e.key === 'r' || e.key === 'R') {
        controller.reset()
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
          <Transport />
        </div>
        <Inspector />
      </div>
    </ReactFlowProvider>
  )
}
