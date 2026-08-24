import { useCallback, useEffect, useState } from 'react'
import {
  exportModelFile,
  importModelFile,
  listModels,
  loadModel,
  type ModelListing,
  saveModel,
} from '../persistence'
import { useDoc } from '../store/doc'

/** Floating file controls: open (from models/), save, save-as, export, import. */
export function FileBar() {
  const fileName = useDoc((s) => s.fileName)
  const model = useDoc((s) => s.model)
  const replaceModel = useDoc((s) => s.replaceModel)
  const setFileName = useDoc((s) => s.setFileName)
  const [models, setModels] = useState<ModelListing[]>([])
  const [status, setStatus] = useState('')

  const refresh = useCallback(() => {
    listModels()
      .then(setModels)
      .catch(() => setModels([]))
  }, [])

  useEffect(refresh, [refresh])

  const flash = (msg: string) => {
    setStatus(msg)
    setTimeout(() => setStatus(''), 1800)
  }

  const doSave = async (name: string | null) => {
    const target = name ?? window.prompt('Save as (models/<name>.json):', fileName ?? 'my_model')
    if (!target) return
    const clean = target.replace(/\.json$/, '')
    try {
      const named = {
        ...model,
        meta: { ...(model.meta ?? {}), name: clean.split('/').pop() ?? clean },
      }
      await saveModel(clean, named)
      setFileName(clean)
      flash(`saved ${clean}`)
      refresh()
    } catch (e) {
      flash(String(e))
    }
  }

  return (
    <div className="filebar">
      <span className="fname" title="current file">
        {fileName ?? 'unsaved'}
      </span>
      <select
        value=""
        title="Open a model from models/"
        onChange={async (e) => {
          const name = e.target.value
          if (!name) return
          try {
            replaceModel(await loadModel(name), name)
            flash(`opened ${name}`)
          } catch (err) {
            flash(String(err))
          }
        }}
      >
        <option value="">open…</option>
        {models.map((m) => (
          <option key={m.name} value={m.name}>
            {m.name}
          </option>
        ))}
      </select>
      <button type="button" title="Save" onClick={() => doSave(fileName)}>
        save
      </button>
      <button type="button" title="Save under a new name" onClick={() => doSave(null)}>
        save as
      </button>
      <button type="button" title="Download as JSON" onClick={() => exportModelFile(model)}>
        ⤓
      </button>
      <button
        type="button"
        title="Import a JSON file"
        onClick={async () => {
          try {
            replaceModel(await importModelFile(), null)
            flash('imported')
          } catch (e) {
            flash(String(e))
          }
        }}
      >
        ⤒
      </button>
      {status && <span className="status">{status}</span>}
    </div>
  )
}
