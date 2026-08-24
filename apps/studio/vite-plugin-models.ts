import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Connect, Plugin } from 'vite'

/**
 * Dev-server persistence: plain JSON model files in <repo>/models, served at
 * /api/models. Files are pretty-printed with a stable key order so git diffs
 * stay clean and hand-edits round-trip pleasantly.
 *
 *   GET  /api/models            → [{ name, mtime }]
 *   GET  /api/models/<name>     → file contents (name may contain subdirs)
 *   PUT  /api/models/<name>     → write file
 */
export function modelsPlugin(): Plugin {
  const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../models')

  const safeResolve = (name: string): string | null => {
    if (!/^[\w\-/]+$/.test(name)) return null
    const full = path.resolve(rootDir, `${name}.json`)
    if (!full.startsWith(rootDir + path.sep)) return null
    return full
  }

  const handler: Connect.NextHandleFunction = async (req, res, next) => {
    const url = new URL(req.url ?? '/', 'http://x')
    const sub = decodeURIComponent(url.pathname.replace(/^\/+|\/+$/g, ''))
    try {
      if (req.method === 'GET' && sub === '') {
        const names = await listModels(rootDir)
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify(names))
        return
      }
      const file = safeResolve(sub)
      if (!file) {
        res.statusCode = 400
        res.end(JSON.stringify({ error: `bad model name "${sub}"` }))
        return
      }
      if (req.method === 'GET') {
        res.setHeader('content-type', 'application/json')
        res.end(await readFile(file, 'utf8'))
        return
      }
      if (req.method === 'PUT') {
        const body = await readBody(req)
        const doc = JSON.parse(body) // reject invalid JSON before touching disk
        await mkdir(path.dirname(file), { recursive: true })
        await writeFile(file, `${stableStringify(doc)}\n`, 'utf8')
        res.end(JSON.stringify({ ok: true }))
        return
      }
      next()
    } catch (e) {
      res.statusCode = (e as NodeJS.ErrnoException).code === 'ENOENT' ? 404 : 500
      res.end(JSON.stringify({ error: String(e) }))
    }
  }

  return {
    name: 'mindmap-models-api',
    configureServer(server) {
      server.middlewares.use('/api/models', handler)
    },
    configurePreviewServer(server) {
      server.middlewares.use('/api/models', handler)
    },
  }
}

async function listModels(rootDir: string): Promise<{ name: string; mtime: number }[]> {
  const out: { name: string; mtime: number }[] = []
  const walk = async (dir: string, prefix: string): Promise<void> => {
    let entries: string[]
    try {
      entries = await readdir(dir)
    } catch {
      return
    }
    for (const entry of entries) {
      const full = path.join(dir, entry)
      const st = await stat(full)
      if (st.isDirectory()) {
        await walk(full, `${prefix}${entry}/`)
      } else if (entry.endsWith('.json')) {
        out.push({ name: `${prefix}${entry.slice(0, -5)}`, mtime: st.mtimeMs })
      }
    }
  }
  await walk(rootDir, '')
  return out.sort((a, b) => a.name.localeCompare(b.name))
}

function readBody(req: Connect.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

/** Preferred key order first, then alphabetical — deterministic git-diff-friendly output. */
const KEY_PRIORITY = [
  'version',
  'meta',
  'sim',
  'mainGraph',
  'graphs',
  'id',
  'type',
  'name',
  'initial',
  'formula',
  'value',
  'default',
  'ref',
  'mode',
  'from',
  'to',
  'alias',
  'nodes',
  'edges',
]

function stableStringify(x: unknown): string {
  return JSON.stringify(sortKeys(x), null, 2)
}

function sortKeys(x: unknown): unknown {
  if (Array.isArray(x)) return x.map(sortKeys)
  if (typeof x !== 'object' || x === null) return x
  const entries = Object.entries(x as Record<string, unknown>)
  entries.sort(([a], [b]) => {
    const pa = KEY_PRIORITY.indexOf(a)
    const pb = KEY_PRIORITY.indexOf(b)
    if (pa !== -1 || pb !== -1) {
      return (pa === -1 ? 99 : pa) - (pb === -1 ? 99 : pb)
    }
    return a.localeCompare(b)
  })
  return Object.fromEntries(entries.map(([k, v]) => [k, sortKeys(v)]))
}
