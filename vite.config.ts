import { defineConfig, type Plugin, type Connect } from 'vite'
import { spawn } from 'node:child_process'
import { readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { curatedKey, validateFeatureCollection } from './scripts/curated-validate.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)))
const CURATED = join(ROOT, 'data/curated')

/**
 * Vite stamps `crossorigin` on the emitted <script> and <link rel=stylesheet>.
 * Every asset here is same-origin, so it buys nothing — but it does make the
 * browser send an `Origin` header, and some static hosts answer that CORS
 * variant with the SPA fallback HTML instead of the file. The stylesheet then
 * gets refused for having a `text/html` MIME type and the whole site renders
 * unstyled, while curl (no Origin) sees a perfectly good text/css. Dropping the
 * attribute keeps the request simple and the response correct.
 */
function noCrossorigin(): Plugin {
  return {
    name: 'no-crossorigin-on-same-origin-assets',
    enforce: 'post',
    transformIndexHtml(html) {
      return html.replace(/\s+crossorigin(=("|')[^"']*\2)?/g, '')
    },
  }
}

/**
 * Dev-only endpoints for the in-app draw tool (`apply: 'serve'`, so they do
 * not exist in the production build or on the deployed site):
 *
 *   GET  /curated/:file  — the raw curated GeoJSON, so the draw UI can load
 *                          the existing features and merge new shapes in.
 *   POST /api/save       — validate and write one curated file, then rebuild
 *                          public/data so a page reload shows the new shapes.
 *
 * The draw button in the app stays disabled unless the first endpoint answers,
 * which only this middleware can do — the deployed site never enables it.
 */
function curatedDevServer(): Plugin {
  let saveChain: Promise<unknown> = Promise.resolve()
  return {
    name: 'curated-dev-server',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = (req.url ?? '').split('?')[0]

        if (req.method === 'GET') {
          const m = /^\/curated\/([a-z]+\.geojson)$/.exec(url)
          if (m) {
            const key = curatedKey(m[1])
            if (!key) { res.statusCode = 404; res.end(`unknown curated file: ${m[1]}`); return }
            readFile(join(CURATED, `${key}.geojson`), 'utf8')
              .then((body) => {
                res.setHeader('Content-Type', 'application/json')
                res.end(body)
              })
              .catch(() => {
                res.statusCode = 404
                res.end(`curated file not found: ${m[1]}`)
              })
            return
          }
        }

        if (req.method === 'POST' && url === '/api/save') {
          // Serialise saves: two concurrent writes to the same file would
          // race, and the rebuild after each write must see the previous one.
          const run = saveChain.then(() => handleSave(req, res))
          saveChain = run.catch(() => {})
          void run
          return
        }

        next()
      })
    },
  }
}

async function readBody(req: Connect.IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(chunk as Buffer)
  return Buffer.concat(chunks).toString('utf8')
}

function reply(res: Connect.ServerResponse, code: number, body: Record<string, unknown>) {
  res.statusCode = code
  res.setHeader('Content-Type', 'application/json')
  res.end(JSON.stringify(body))
}

async function handleSave(req: Connect.IncomingMessage, res: Connect.ServerResponse) {
  let payload: { file?: unknown; data?: unknown }
  try {
    payload = JSON.parse(await readBody(req))
  } catch {
    reply(res, 400, { ok: false, error: 'request body is not valid JSON' })
    return
  }

  const key = curatedKey(payload.file as string)
  if (!key) {
    reply(res, 400, {
      ok: false,
      error: `unknown file "${String(payload.file)}" — allowed: boundary, buildings, paths, indoor, pois`,
    })
    return
  }

  const check = validateFeatureCollection(payload.data, key)
  if (!check.ok) { reply(res, 400, { ok: false, error: check.error }); return }

  try {
    await writeFile(join(CURATED, `${key}.geojson`), JSON.stringify(payload.data, null, 2) + '\n', 'utf8')
  } catch (e) {
    reply(res, 500, { ok: false, error: `write failed: ${(e as Error).message}` })
    return
  }

  const warning = await rebuildData()
  reply(res, 200, { ok: true, ...(warning ? { warning } : {}) })
}

/** Regenerate public/data from data/curated. Resolves a warning string, or
 *  null when the rebuild succeeded. */
function rebuildData(): Promise<string | null> {
  return new Promise((resolve) => {
    const child = spawn('bun', ['scripts/build-data.mjs'], {
      cwd: ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stderr = ''
    const timer = setTimeout(() => {
      child.kill()
      resolve('rebuild timed out after 60s')
    }, 60_000)
    child.stderr.on('data', (d: Buffer) => { stderr += d.toString() })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve(code === 0 ? null : `rebuild exited ${code}: ${stderr.slice(0, 200).trim()}`)
    })
    child.on('error', (e) => {
      clearTimeout(timer)
      resolve(`rebuild could not start: ${e.message}`)
    })
  })
}

export default defineConfig({
  plugins: [noCrossorigin(), curatedDevServer()],
  server: { port: 5180, open: false },
  build: { target: 'es2022', chunkSizeWarningLimit: 1200 },
})
