import type { Model } from '@mindmap/engine'
import { validateModel } from '@mindmap/engine'

/**
 * File persistence client for the /api/models middleware, plus localStorage
 * autosave as crash insurance. Names may contain subdirectories ("examples/x").
 */

export interface ModelListing {
  name: string
  mtime: number
}

export async function listModels(): Promise<ModelListing[]> {
  const res = await fetch('/api/models')
  if (!res.ok) throw new Error(`list failed: ${res.status}`)
  return (await res.json()) as ModelListing[]
}

export async function loadModel(name: string): Promise<Model> {
  const res = await fetch(`/api/models/${encodeURIComponent(name).replace(/%2F/g, '/')}`)
  if (!res.ok) throw new Error(`load "${name}" failed: ${res.status}`)
  const doc = await res.json()
  const { model, issues } = validateModel(doc)
  if (!model) {
    throw new Error(`"${name}" is not a valid model:\n${issues.map((i) => i.message).join('\n')}`)
  }
  return model
}

export async function saveModel(name: string, model: Model): Promise<void> {
  const res = await fetch(`/api/models/${encodeURIComponent(name).replace(/%2F/g, '/')}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(model),
  })
  if (!res.ok) throw new Error(`save "${name}" failed: ${res.status}`)
}

// ---- localStorage autosave ------------------------------------------------

const AUTOSAVE_KEY = 'mindmap:autosave'
const LAST_KEY = 'mindmap:lastModel'

export interface Autosave {
  savedAt: number
  fileName: string | null
  model: Model
}

export function writeAutosave(fileName: string | null, model: Model): void {
  try {
    const payload: Autosave = { savedAt: Date.now(), fileName, model }
    localStorage.setItem(AUTOSAVE_KEY, JSON.stringify(payload))
    if (fileName) localStorage.setItem(LAST_KEY, fileName)
  } catch {
    // quota/serialization problems must never break editing
  }
}

export function readAutosave(): Autosave | null {
  try {
    const raw = localStorage.getItem(AUTOSAVE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as Autosave
    return validateModel(parsed.model).model ? parsed : null
  } catch {
    return null
  }
}

export function clearAutosave(): void {
  localStorage.removeItem(AUTOSAVE_KEY)
}

// ---- export / import fallback --------------------------------------------

export function exportModelFile(model: Model): void {
  const blob = new Blob([JSON.stringify(model, null, 2)], { type: 'application/json' })
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = `${model.meta?.name ?? 'model'}.json`
  a.click()
  URL.revokeObjectURL(a.href)
}

export function importModelFile(): Promise<Model> {
  return new Promise((resolve, reject) => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = 'application/json,.json'
    input.onchange = async () => {
      const file = input.files?.[0]
      if (!file) return reject(new Error('no file chosen'))
      try {
        const doc = JSON.parse(await file.text())
        const { model, issues } = validateModel(doc)
        if (!model) {
          return reject(new Error(`invalid model:\n${issues.map((i) => i.message).join('\n')}`))
        }
        resolve(model)
      } catch (e) {
        reject(e)
      }
    }
    input.click()
  })
}
