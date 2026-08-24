import '@xyflow/react/dist/style.css'
import './theme.css'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import { startEngineSync } from './engine/controller'

startEngineSync()

const rootEl = document.getElementById('root')
if (rootEl) {
  createRoot(rootEl).render(<App />)
}
