import { listModels, loadModel, readAutosave, writeAutosave } from './persistence'
import { useDoc } from './store/doc'

/**
 * Boot: restore the autosave if it is newer than its file (crash recovery),
 * else reopen the last file, else fall back to the built-in demo already in
 * the store. Then start the debounced autosave loop.
 */
export async function bootPersistence(): Promise<void> {
  // No blocking dialogs at boot: restore silently and note it in the console.
  // Re-opening the file from the FileBar dropdown is the "discard" gesture.
  const auto = readAutosave()
  try {
    if (auto?.fileName) {
      const files = await listModels().catch(() => [])
      const file = files.find((f) => f.name === auto.fileName)
      if (file && auto.savedAt > file.mtime + 2000) {
        useDoc.getState().replaceModel(auto.model, auto.fileName)
        console.info(
          `[mindmap] restored unsaved changes to "${auto.fileName}" from the last session — re-open it from the file menu to discard them`,
        )
      } else if (file) {
        useDoc.getState().replaceModel(await loadModel(auto.fileName), auto.fileName)
      }
    } else if (auto) {
      useDoc.getState().replaceModel(auto.model, null)
      console.info('[mindmap] restored your unsaved model from the last session')
    }
  } catch {
    // persistence must never block the app — the demo model is already loaded
  }

  let timer: ReturnType<typeof setTimeout> | undefined
  useDoc.subscribe((s) => {
    clearTimeout(timer)
    timer = setTimeout(() => writeAutosave(s.fileName, s.model), 1000)
  })
}
