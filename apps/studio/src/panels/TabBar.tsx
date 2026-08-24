import { useDoc } from '../store/doc'
import { useUi } from '../store/sim'

/**
 * Top strip: graph tabs, or the breadcrumb trail when the canvas shows the
 * inside of a module instance (double-click a module to enter; Esc goes up).
 */
export function TabBar() {
  const model = useDoc((s) => s.model)
  const activeGraphId = useDoc((s) => s.activeGraphId)
  const setActiveGraph = useDoc((s) => s.setActiveGraph)
  const addGraph = useDoc((s) => s.addGraph)
  const breadcrumb = useUi((s) => s.breadcrumb)
  const { popToCrumb, clearCrumbs } = useUi()

  if (breadcrumb.length > 0) {
    return (
      <div className="tabbar">
        <button
          type="button"
          className="crumb"
          onClick={() => {
            clearCrumbs()
            setActiveGraph(model.mainGraph)
          }}
        >
          {model.graphs[model.mainGraph]?.name ?? model.mainGraph}
        </button>
        {breadcrumb.map((c, i) => (
          <span key={`${c.moduleId}-${i}`}>
            <span className="sep">▸</span>
            <button
              type="button"
              className={`crumb ${i === breadcrumb.length - 1 ? 'current' : ''}`}
              onClick={() => {
                popToCrumb(i + 1)
                setActiveGraph(c.graphId)
              }}
            >
              {c.moduleId}
            </button>
          </span>
        ))}
        <span className="hint-inline">live instance view · Esc = up</span>
      </div>
    )
  }

  return (
    <div className="tabbar">
      {Object.entries(model.graphs).map(([id, g]) => (
        <button
          key={id}
          type="button"
          className={`tab ${id === activeGraphId ? 'current' : ''}`}
          onClick={() => {
            clearCrumbs()
            setActiveGraph(id)
          }}
        >
          {g.name ?? id}
          {id === model.mainGraph && (
            <span className="main-dot" title="main graph">
              ●
            </span>
          )}
        </button>
      ))}
      <button type="button" className="tab add" title="New graph (tab)" onClick={() => addGraph()}>
        +
      </button>
      {activeGraphId !== model.mainGraph && (
        <span className="hint-inline">
          static view — live values appear when entered through a module
        </span>
      )}
    </div>
  )
}
