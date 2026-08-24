import type { NodeType } from '@mindmap/engine'
import { useReactFlow } from '@xyflow/react'
import { useDoc } from '../store/doc'
import { useUi } from '../store/sim'

const ITEMS: { type: NodeType; icon: string; title: string }[] = [
  { type: 'stock', icon: '▭', title: 'Stock — accumulates via flows' },
  { type: 'flow', icon: '⋈', title: 'Flow — rate into/out of stocks' },
  { type: 'variable', icon: '◯', title: 'Variable — formula' },
  { type: 'constant', icon: '◉', title: 'Constant — dial' },
  { type: 'module', icon: '▣', title: 'Module — a graph as an IC chip' },
  { type: 'input', icon: '⮕', title: 'Input port (for graphs used as modules)' },
  { type: 'output', icon: '➡', title: 'Output port (for graphs used as modules)' },
  { type: 'note', icon: '✎', title: 'Note — annotation' },
]

export function Palette() {
  const addNode = useDoc((s) => s.addNode)
  const addModuleNode = useDoc((s) => s.addModuleNode)
  const select = useUi((s) => s.select)
  const { screenToFlowPosition } = useReactFlow()
  return (
    <div className="palette">
      {ITEMS.map((it) => (
        <button
          key={it.type}
          type="button"
          title={it.title}
          onClick={() => {
            const center = screenToFlowPosition({
              x: window.innerWidth / 2 + (Math.random() - 0.5) * 120,
              y: window.innerHeight / 2 + (Math.random() - 0.5) * 80,
            })
            select(it.type === 'module' ? addModuleNode(center) : addNode(it.type, center))
          }}
        >
          {it.icon}
        </button>
      ))}
    </div>
  )
}
