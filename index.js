/**
 * Host half of `dsh-excalidraw-canvas`.
 *
 * Owns the canvas documents, the queue of pending agent operations, the HTTP
 * surface the browser half talks to, and the three agent tools. All geometry is
 * computed in the browser, where Excalidraw can measure text; this half only
 * validates intent and stores bytes.
 *
 * @module dsh-excalidraw-canvas
 */
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { mkdir, readFile, readdir, rename, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, extname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Schema as z, defineTool } from './lib/host-runtime.js'

export const name = 'excalidraw'
export const inject = ['tools', 'webServer']

/** Model-facing configuration. */
export const Config = z.object({
  /** Directory holding the `.excalidraw` documents, relative to the workspace root. */
  directory: z.string().default('excalidraw'),
  /** Open the canvas panel in the browser after an agent draw. */
  openOnDraw: z.boolean().default(true),
  /** Milliseconds an agent write waits for the open panel to apply it. */
  applyTimeoutMs: z.number().default(8000),
  /** Milliseconds an export waits for the open panel to produce the file. */
  exportTimeoutMs: z.number().default(20000),
})

const ROUTE = '/plugins/dsh-excalidraw-canvas'
const FONT_ROUTE = `${ROUTE}/fonts`
const PACKAGE_DIR = dirname(fileURLToPath(import.meta.url))
const FONT_DIR = join(PACKAGE_DIR, 'assets', 'fonts')
const NAME_PATTERN = /^[\p{L}\p{N}][\p{L}\p{N} ._-]{0,63}$/u
const SHAPES = ['rect', 'round', 'ellipse', 'diamond', 'text']
const COLORS = ['blue', 'green', 'red', 'yellow', 'violet', 'orange', 'teal', 'gray', 'white']
const MAX_BODY_BYTES = 32 * 1024 * 1024

/** A failure that carries the HTTP status the route answers with. */
class HttpError extends Error {
  /**
   * @param status - HTTP status code.
   * @param message - diagnostic text returned to the caller.
   */
  constructor(status, message) {
    super(message)
    this.status = status
  }
}

/**
 * Resolve the one directory every canvas lives in.
 * @param ctx - plugin context, for the workspace's default directory.
 * @param config - resolved plugin configuration.
 * @returns absolute directory path.
 */
/**
 * The session's workspace root, or the process default when the session cannot be resolved.
 * @param ctx - plugin context.
 * @param sessionId - session whose workspace holds the document.
 * @returns the workspace directory and how it was found.
 */
function workspaceOf(ctx, config, sessionId) {
  const directories = ctx.get('workingDirectory')
  const defaultDirectory = directories?.defaultDirectory ?? process.cwd()
  if (typeof sessionId !== 'string' || sessionId === '' || directories === undefined) {
    return { root: defaultDirectory, source: 'default', detail: 'no session' }
  }
  try {
    const agent = ctx.get('agents')?.get?.(sessionId)
    if (agent === undefined || agent === null) {
      return { root: defaultDirectory, source: 'default', detail: 'no live agent for this session' }
    }
    return { root: directories.get(agent.session), source: 'session', detail: 'resolved' }
  } catch (error) {
    return { root: defaultDirectory, source: 'default', detail: `resolution failed: ${String(error?.message ?? error)}` }
  }
}

/**
 * The configured canvas folder inside one workspace.
 * @param workspace - workspace root.
 * @param config - resolved plugin configuration.
 * @returns the absolute canvas folder.
 */
function canvasFolder(workspace, config) {
  return resolve(workspace, config.directory)
}

/**
 * Resolve the document a browser or tool call means.
 *
 * Two spellings are accepted, because a conversation link carries a
 * workspace-relative path while the tools name a canvas in the canvas folder:
 * - `path` — any `.excalidraw` file inside the workspace, as
 *   `dsh-resource://file/session/<id>/<path>` spells it;
 * - `name` — a canvas in the configured folder, without the extension.
 * @param ctx - plugin context.
 * @param config - resolved plugin configuration.
 * @param request - `{ name }` or `{ path }`, plus the owning session.
 * @returns the resolved workspace, document, display name, and queue key.
 */
function resolveTarget(ctx, config, request) {
  const workspace = workspaceOf(ctx, config, request.session)
  const root = resolve(workspace.root)
  if (typeof request.path === 'string' && request.path.trim() !== '') {
    const relative = request.path.replace(/\\/g, '/').replace(/^\/+/, '')
    if (relative.split('/').includes('..')) throw new HttpError(400, 'path may not climb out of the workspace')
    const file = resolve(root, relative)
    if (file !== root && !file.startsWith(root + sep)) throw new HttpError(400, 'path leaves the workspace')
    if (extname(file).toLowerCase() !== '.excalidraw') throw new HttpError(400, 'not an .excalidraw document')
    return {
      workspace,
      root,
      file,
      name: basename(file).replace(/\.excalidraw$/i, ''),
      path: relative,
      key: file,
      session: request.session ?? null,
    }
  }
  const trimmed = String(request.name ?? '').trim().replace(/\.excalidraw$/i, '')
  if (!NAME_PATTERN.test(trimmed) || trimmed.includes('..')) {
    throw new HttpError(400, `invalid canvas name "${String(request.name)}"`)
  }
  const folder = canvasFolder(root, config)
  return {
    workspace,
    root,
    file: join(folder, `${trimmed}.excalidraw`),
    name: trimmed,
    path: `${config.directory}/${trimmed}.excalidraw`.replace(/\\/g, '/'),
    key: join(folder, `${trimmed}.excalidraw`),
    session: request.session ?? null,
  }
}

/**
 * List the canvases in one workspace's canvas folder.
 * @param ctx - plugin context.
 * @param config - resolved plugin configuration.
 * @param sessionId - owning session.
 * @returns the folder plus one entry per document.
 */
async function listCanvases(ctx, config, sessionId) {
  const workspace = workspaceOf(ctx, config, sessionId)
  const root = resolve(workspace.root)
  const folder = canvasFolder(root, config)
  let names = []
  try {
    names = (await readdir(folder)).filter(entry => entry.toLowerCase().endsWith('.excalidraw'))
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
  const canvases = []
  for (const entry of names.sort()) {
    const name = entry.slice(0, -'.excalidraw'.length)
    const file = join(folder, entry)
    const document = await readDocument(file)
    const count = Array.isArray(document.scene?.elements)
      ? document.scene.elements.filter(element => element?.isDeleted !== true).length
      : 0
    canvases.push({
      name,
      path: `${config.directory}/${entry}`.replace(/\\/g, '/'),
      rev: document.rev,
      updatedAt: document.updatedAt,
      elementCount: count,
    })
  }
  return { workspace, root, folder, canvases }
}

/**
 * The resource address of a canvas document.
 *
 * A tab opened by a file link is keyed by this address, so the agent's open has
 * to name the same address or the sidebar opens a second tab for one file - two
 * editors saving the same document from underneath each other.
 * @param sessionId - the session whose workspace holds the file.
 * @param root - that workspace's root.
 * @param file - absolute document path.
 * @returns the `dsh-resource://file/session/<id>/<path>` address.
 */
function resourceAddressOf(sessionId, root, file) {
  const relative = file === root || !file.startsWith(root + sep) ? file : file.slice(root.length + 1)
  const encoded = relative
    .split(sep)
    .map(segment => encodeURIComponent(segment).replace(/%3A/gi, ':'))
    .join('/')
  return `dsh-resource://file/session/${encodeURIComponent(sessionId)}/${encoded}`
}

/**
 * Read a scene document and the revision that identifies its bytes.
 * @param file - absolute document path.
 * @returns the scene, or `exists: false` when the document is absent.
 */
async function readDocument(file) {
  let text
  try {
    text = await readFile(file, 'utf8')
  } catch (error) {
    if (error.code === 'ENOENT') return { exists: false, scene: null, rev: '0:0', updatedAt: null }
    throw error
  }
  const info = await stat(file)
  let scene
  try {
    scene = JSON.parse(text)
  } catch {
    throw new HttpError(500, `${file} is not valid JSON`)
  }
  return { exists: true, scene, rev: `${Math.round(info.mtimeMs)}:${info.size}`, updatedAt: info.mtimeMs }
}

/**
 * Replace a scene document atomically and report the new revision.
 * @param file - absolute document path.
 * @param scene - Excalidraw scene envelope.
 * @returns the new revision string.
 */
async function writeDocument(file, scene) {
  await mkdir(dirname(file), { recursive: true })
  const temporary = `${file}.${randomUUID()}.tmp`
  await writeFile(temporary, JSON.stringify(scene), 'utf8')
  await rename(temporary, file)
  const info = await stat(file)
  return `${Math.round(info.mtimeMs)}:${info.size}`
}

/**
 * Read and parse a JSON request body.
 * @param request - Node incoming message.
 * @returns the parsed body, or `{}` for an empty body.
 */
async function readBody(request) {
  const chunks = []
  let size = 0
  for await (const chunk of request) {
    size += chunk.length
    if (size > MAX_BODY_BYTES) throw new HttpError(413, 'request body too large')
    chunks.push(chunk)
  }
  const text = Buffer.concat(chunks).toString('utf8')
  if (text.trim() === '') return {}
  try {
    return JSON.parse(text)
  } catch {
    throw new HttpError(400, 'request body is not valid JSON')
  }
}

/**
 * Answer one request with JSON.
 * @param response - Node server response.
 * @param status - HTTP status code.
 * @param value - JSON-serializable payload.
 */
function sendJson(response, status, value) {
  const body = Buffer.from(JSON.stringify(value), 'utf8')
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(body.length),
    'cache-control': 'no-store',
  })
  response.end(body)
}

/**
 * Serve one font file from the package's bundled assets.
 * @param request - Node incoming message.
 * @param response - Node server response.
 */
async function serveFont(request, response) {
  const path = decodeURIComponent((request.url ?? '').split('?')[0])
  const relative = (path.startsWith(FONT_ROUTE) ? path.slice(FONT_ROUTE.length) : path).replace(/^\/+/, '')
  if (relative === '' || relative.includes('..')) {
    response.writeHead(404)
    response.end()
    return
  }
  const file = join(FONT_DIR, relative)
  if (extname(file) !== '.woff2') {
    response.writeHead(404)
    response.end()
    return
  }
  try {
    const bytes = await readFile(file)
    response.writeHead(200, {
      'content-type': 'font/woff2',
      'content-length': String(bytes.length),
      'cache-control': 'public, max-age=31536000, immutable',
      'x-content-type-options': 'nosniff',
    })
    response.end(bytes)
  } catch {
    response.writeHead(404)
    response.end()
  }
}

/**
 * Describe a scene as the compact summary the model reads.
 * @param scene - Excalidraw scene envelope.
 * @returns nodes, edges, and counts.
 */
function summarize(scene) {
  const elements = Array.isArray(scene?.elements) ? scene.elements.filter(element => element?.isDeleted !== true) : []
  const labels = new Map()
  for (const element of elements) {
    if (element.type === 'text' && element.containerId) {
      labels.set(element.containerId, element.originalText ?? element.text ?? '')
    }
  }
  const nodes = elements
    .filter(element => element.type !== 'text' && element.type !== 'arrow' && element.type !== 'line')
    .map(element => ({
      id: element.id,
      type: element.type,
      label: labels.get(element.id) ?? '',
      x: Math.round(element.x ?? 0),
      y: Math.round(element.y ?? 0),
      width: Math.round(element.width ?? 0),
      height: Math.round(element.height ?? 0),
    }))
  const edges = elements
    .filter(element => element.type === 'arrow' || element.type === 'line')
    .map(element => ({
      id: element.id,
      from: element.startBinding?.elementId ?? null,
      to: element.endBinding?.elementId ?? null,
      label: labels.get(element.id) ?? '',
    }))
  const texts = elements
    .filter(element => element.type === 'text' && !element.containerId)
    .map(element => ({ id: element.id, text: element.originalText ?? element.text ?? '' }))
  return { nodes, edges, texts, elementCount: elements.length }
}

/**
 * Render a summary as the text the model reads.
 * @param canvas - canvas name and revision.
 * @param summary - result of {@link summarize}.
 * @returns a compact multi-line description.
 */
function formatSummary(canvas, summary) {
  const lines = [`Canvas "${canvas.name}" (revision ${canvas.rev}, ${summary.elementCount} elements)`]
  if (summary.nodes.length > 0) {
    lines.push('nodes:')
    for (const node of summary.nodes) {
      lines.push(`- ${node.id} [${node.type}] "${node.label}" at (${node.x},${node.y}) ${node.width}x${node.height}`)
    }
  }
  if (summary.edges.length > 0) {
    lines.push('edges:')
    for (const edge of summary.edges) {
      const label = edge.label ? ` "${edge.label}"` : ''
      lines.push(`- ${edge.from ?? '?'} -> ${edge.to ?? '?'}${label}`)
    }
  }
  if (summary.texts.length > 0) {
    lines.push('texts:')
    for (const text of summary.texts) lines.push(`- ${text.id}: "${text.text}"`)
  }
  if (summary.elementCount === 0) lines.push('(empty canvas)')
  return lines.join('\n')
}

/**
 * Plugin entry: canvas storage, browser routes, and agent tools.
 * @param ctx - plugin context.
 * @param config - resolved configuration.
 * @returns when every registration is in place.
 */
export async function apply(ctx, config) {
  /** Pending operations per canvas name, with the waiters an agent call is blocked on. */
  const queues = new Map()
  /** Canvas names whose panel an agent asked the browser to open. */
  const openRequests = new Map()
  /** What the browser half reported about its own activation, newest last. */
  const clientLog = []
  /** Recent requests, so a failing browser call is diagnosable from the Host. */
  const requestLog = []

  /**
   * Record one handled request.
   * @param route - route path suffix.
   * @param detail - request identity and outcome.
   */
  const noteRequest = (route, detail) => {
    requestLog.push({ at: Date.now(), route, ...detail })
    while (requestLog.length > 24) requestLog.shift()
  }

  /**
   * Identity of one canvas: two sessions may each own an `excalidraw/flow` file,
   * so a queue and an open request are keyed by the resolved document, not by
   * the bare name the model used.
   * @param canvas - canvas name.
   * @param sessionId - session that owns the workspace, when known.
   * @returns the resolved root, the document path, and the queue key.
   */
  /**
   * Resolve a request (`{ name }` or `{ path }`) into one document identity.
   * @param request - name or workspace-relative path, plus its session.
   * @returns the resolution, including the queue key.
   */
  const identityOf = request => resolveTarget(ctx, config, request)

  /**
   * Read `name` / `path` / `session` off a query string or a request body.
   * @param source - URL search params or a parsed JSON body.
   * @returns the request shape the resolvers take.
   */
  const requestOf = source => {
    const read = key => (source instanceof URLSearchParams
      ? source.get(key) ?? undefined
      : (typeof source?.[key] === 'string' ? source[key] : undefined))
    return { name: read('name'), path: read('path'), session: read('session') }
  }

  /**
   * The queue record for one canvas key.
   * @param key - queue identity.
   * @returns its queue, created on demand.
   */
  const queueOf = (key) => {
    let queue = queues.get(key)
    if (queue === undefined) {
      queue = { ops: [], waiters: new Map() }
      queues.set(key, queue)
    }
    return queue
  }

  /**
   * Queue one operation for the browser half.
   * @param key - queue identity.
   * @param op - operation envelope for the browser.
   * @returns the operation id.
   */
  const enqueue = (key, op) => {
    const queue = queueOf(key)
    const entry = { id: randomUUID(), op, at: Date.now() }
    queue.ops.push(entry)
    return entry.id
  }

  /**
   * Ask the browser to show one canvas.
   * @param identity - resolved canvas identity.
   */
  const requestOpen = (identity) => {
    if (config.openOnDraw !== true) return
    const workspace = workspaceOf(ctx, config, identity.session)
    const address = identity.file === undefined || identity.session === undefined
      ? null
      : resourceAddressOf(identity.session, resolve(workspace.root), identity.file)
    openRequests.set(identity.key, {
      id: randomUUID(),
      name: identity.name,
      address,
      at: Date.now(),
      session: identity.session ?? null,
    })
  }

  /**
   * Wait until the browser reports the queued operations handled.
   * @param key - queue identity.
   * @param ids - operation ids to wait for.
   * @param timeoutMs - bound on the wait.
   * @returns whether the browser answered in time, and what it reported.
   */
  const waitForApply = (key, ids, timeoutMs) => {
    if (ids.length === 0) return Promise.resolve({ answered: true, detail: null })
    const queue = queueOf(key)
    return new Promise((resolveWait) => {
      const timer = setTimeout(() => {
        for (const id of ids) queue.waiters.delete(id)
        resolveWait({ answered: false, detail: null })
      }, timeoutMs)
      timer.unref?.()
      for (const id of ids) {
        queue.waiters.set(id, answer => {
          clearTimeout(timer)
          resolveWait({ answered: true, detail: answer?.detail ?? null, applied: answer?.applied !== false })
        })
      }
    })
  }

  /**
   * Record that the browser handled one batch of operations.
   * @param key - queue identity.
   * @param ids - operation ids the browser handled.
   * @param answer - what the browser reported, forwarded to the waiting tool.
   */
  const settle = (key, ids, answer) => {
    const queue = queues.get(key)
    if (queue === undefined) return
    const handled = new Set(ids)
    queue.ops = queue.ops.filter(entry => !handled.has(entry.id))
    for (const id of handled) {
      const waiter = queue.waiters.get(id)
      if (waiter === undefined) continue
      queue.waiters.delete(id)
      waiter(answer)
    }
  }

  // ---------------------------------------------------------------------------
  // Browser routes
  // ---------------------------------------------------------------------------
  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: FONT_ROUTE,
    handler: (request, response) => serveFont(request, response),
  }), 'dsh-excalidraw-canvas: bundled fonts')

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: `${ROUTE}/api/state`,
    handler: async (request, response) => {
      try {
        const url = new URL(request.url ?? '/', 'http://localhost')
        const session = url.searchParams.get('session') ?? undefined
        const listed = await listCanvases(ctx, config, session)
        sendJson(response, 200, {
          root: listed.folder,
          workspace: listed.root,
          resolution: listed.workspace,
          session: session ?? null,
          canvases: listed.canvases,
          client: clientLog[clientLog.length - 1] ?? null,
          clientLog,
          requestLog,
          open: [...openRequests.values()],
          pending: queues.size,
        })
      } catch (error) {
        sendJson(response, error.status ?? 500, { error: String(error.message ?? error) })
      }
    },
  }), 'dsh-excalidraw-canvas: canvas inventory')

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: `${ROUTE}/api/hello`,
    handler: async (request, response) => {
      try {
        if (request.method !== 'POST') throw new HttpError(405, 'POST required')
        const body = await readBody(request)
        clientLog.push({
          at: Date.now(),
          stage: typeof body.stage === 'string' ? body.stage : 'unknown',
          error: typeof body.error === 'string' ? body.error.slice(0, 4000) : null,
          notes: body.notes !== undefined && body.notes !== null ? JSON.stringify(body.notes).slice(0, 2000) : null,
        })
        while (clientLog.length > 40) clientLog.shift()
        sendJson(response, 200, { ok: true })
      } catch (error) {
        sendJson(response, error.status ?? 500, { error: String(error.message ?? error) })
      }
    },
  }), 'dsh-excalidraw-canvas: client heartbeat')

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: `${ROUTE}/api/scene`,
    handler: async (request, response) => {
      try {
        const url = new URL(request.url ?? '/', 'http://localhost')
        const identity = identityOf(requestOf(url.searchParams))
        const canvas = identity.name
        const document = await readDocument(identity.file)
        sendJson(response, 200, {
          name: canvas,
          exists: document.exists,
          rev: document.rev,
          updatedAt: document.updatedAt,
          scene: document.scene,
          ops: (queues.get(identity.key)?.ops ?? []).map(entry => entry.op),
          opIds: (queues.get(identity.key)?.ops ?? []).map(entry => entry.id),
        })
      } catch (error) {
        sendJson(response, error.status ?? 500, { error: String(error.message ?? error) })
      }
    },
  }), 'dsh-excalidraw-canvas: scene read')

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: `${ROUTE}/api/save`,
    handler: async (request, response) => {
      try {
        if (request.method !== 'POST') throw new HttpError(405, 'POST required')
        const body = await readBody(request)
        const identity = identityOf(requestOf(body))
        const canvas = identity.name
        const file = identity.file
        const current = await readDocument(file)
        if (body.create === true && current.exists) {
          noteRequest('save', { name: canvas, session: body.session ?? null, status: 409, file, create: true })
          sendJson(response, 409, { error: `canvas "${canvas}" already exists`, exists: true, rev: current.rev })
          return
        }
        if (typeof body.baseRev === 'string' && body.baseRev !== current.rev && current.exists && body.baseRev !== '0:0') {
          noteRequest('save', { name: canvas, session: body.session ?? null, status: 409, file })
          sendJson(response, 409, {
            error: 'the document changed on disk',
            rev: current.rev,
            scene: current.scene,
          })
          return
        }
        const rev = await writeDocument(file, body.scene ?? { type: 'excalidraw', version: 2, source: 'dsh-excalidraw-canvas', elements: [] })
        noteRequest('save', { name: canvas, session: body.session ?? null, status: 200, file })
        sendJson(response, 200, { name: canvas, rev })
      } catch (error) {
        noteRequest('save', { status: error.status ?? 500, error: String(error.message ?? error) })
        sendJson(response, error.status ?? 500, { error: String(error.message ?? error) })
      }
    },
  }), 'dsh-excalidraw-canvas: scene save')

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: `${ROUTE}/api/ops`,
    handler: async (request, response) => {
      try {
        if (request.method === 'GET') {
          const url = new URL(request.url ?? '/', 'http://localhost')
          const identity = identityOf(requestOf(url.searchParams))
          const queue = queues.get(identity.key)
          sendJson(response, 200, {
            ops: (queue?.ops ?? []).map(entry => ({ id: entry.id, op: entry.op })),
            open: [...openRequests.values()].filter(entry => entry.name === identity.name),
          })
          return
        }
        if (request.method !== 'POST') throw new HttpError(405, 'GET or POST required')
        const body = await readBody(request)
        const identity = identityOf(requestOf(body))
        if (body.ack === true) {
          settle(identity.key, Array.isArray(body.ids) ? body.ids.map(String) : [], {
            applied: body.applied !== false,
            detail: body.detail ?? null,
          })
          if (Array.isArray(body.openedIds)) {
            const handled = new Set(body.openedIds.map(String))
            for (const [key, value] of openRequests) if (handled.has(value.id)) openRequests.delete(key)
          }
        }
        sendJson(response, 200, { ok: true })
      } catch (error) {
        sendJson(response, error.status ?? 500, { error: String(error.message ?? error) })
      }
    },
  }), 'dsh-excalidraw-canvas: operation queue')

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: `${ROUTE}/api/asset`,
    handler: async (request, response) => {
      try {
        if (request.method !== 'POST') throw new HttpError(405, 'POST required')
        const body = await readBody(request)
        const identity = identityOf(requestOf(body))
        const canvas = identity.name
        const root = dirname(identity.file)
        const format = body.format === 'svg' ? 'svg' : body.format === 'png' ? 'png' : undefined
        if (format === undefined) throw new HttpError(400, 'format must be png or svg')
        const encoded = typeof body.data === 'string' ? body.data : ''
        if (encoded === '') throw new HttpError(400, 'data is empty')
        const bytes = Buffer.from(encoded, 'base64')
        const file = join(root, `${canvas}.${format}`)
        await mkdir(root, { recursive: true })
        await writeFile(file, bytes)
        sendJson(response, 200, { path: file, bytes: bytes.length })
      } catch (error) {
        sendJson(response, error.status ?? 500, { error: String(error.message ?? error) })
      }
    },
  }), 'dsh-excalidraw-canvas: export asset')

  // The authoring conventions ship as a runtime skill: a skill directory on disk
  // is only discovered when the filesystem provider is mounted and configured,
  // while this registration reaches every agent that has `ctx.skills`.
  ctx.inject(['skills'], (owner) => {
    const skills = owner.get('skills')
    if (skills === undefined) return
    let content
    try {
      content = readFileSync(join(PACKAGE_DIR, 'skills', 'excalidraw-diagrams.md'), 'utf8')
        .replace(/^---[\s\S]*?---\s*/, '')
    } catch {
      return
    }
    owner.effect(() => skills.register({
      name: 'excalidraw-diagrams',
      description: 'Author readable Excalidraw diagrams in the DSH canvas panel with the excalidraw_* tools: '
        + 'layered flow, decision diamonds, retries written as terminal nodes, edge-attached arrows, placing '
        + 'screenshots as an evenly spaced row or grid, and the draw/export/inspect loop.',
      whenToUse: 'The user asks to draw, sketch, diagram, or update a flow, architecture, sequence, or mind map '
        + 'in the Excalidraw canvas panel, refers to an existing canvas, or asks to arrange screenshots or '
        + 'images on the canvas.',
      source: 'runtime',
      content,
    }), 'dsh-excalidraw-canvas: diagram skill')
  })

  // ---------------------------------------------------------------------------
  // Agent tools
  // ---------------------------------------------------------------------------
  const nodeShape = {
    type: 'object',
    additionalProperties: false,
    properties: {
      id: { type: 'string', required: true, description: 'Stable node id, also the element id used by later edits.' },
      label: { type: 'string', required: true, description: 'Text shown inside the node; wrap with \\n for several lines.' },
      shape: { type: 'string', enum: SHAPES, description: 'rect (default), round, ellipse, diamond, or text for a bare label.' },
      color: { type: 'string', enum: COLORS, description: 'Fill accent of the node.' },
      x: { type: 'number', description: 'Explicit x in scene coordinates; omit to place automatically.' },
      y: { type: 'number', description: 'Explicit y in scene coordinates; omit to place automatically.' },
      width: { type: 'number', description: 'Explicit width; omit to size from the label.' },
      height: { type: 'number', description: 'Explicit height; omit to size from the label.' },
    },
  }

  const edgeShape = {
    type: 'object',
    additionalProperties: false,
    properties: {
      from: { type: 'string', required: true, description: 'Source node id.' },
      to: { type: 'string', required: true, description: 'Target node id.' },
      label: { type: 'string', description: 'Text on the edge.' },
      dashed: { type: 'boolean', description: 'Draw the edge dashed.' },
      arrow: { type: 'string', enum: ['end', 'both', 'none'], description: 'Arrowheads; defaults to end.' },
    },
  }

  /**
   * Identify an image by its leading bytes.
   *
   * Only the four types DSH accepts as attachments travel: a canvas that holds
   * anything else would render a placeholder for every viewer but the author.
   * @param raw - the file's bytes.
   * @returns the mime type, or undefined when it is not a supported image.
   */
  const sniffImage = (raw) => {
    if (raw.length >= 24 && raw[0] === 0x89 && raw[1] === 0x50 && raw[2] === 0x4e && raw[3] === 0x47) return 'image/png'
    if (raw.length >= 3 && raw[0] === 0xff && raw[1] === 0xd8 && raw[2] === 0xff) return 'image/jpeg'
    if (raw.length >= 6 && raw.subarray(0, 3).toString('latin1') === 'GIF') return 'image/gif'
    if (raw.length >= 16 && raw.subarray(0, 4).toString('latin1') === 'RIFF' && raw.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp'
    return undefined
  }

  /**
   * Pixel size of a supported image, read from its header.
   *
   * The aspect ratio is all the layout needs, so this reads the smallest amount
   * of header that carries it instead of decoding the picture.
   * @param raw - the file's bytes.
   * @param mimeType - the type `sniffImage` reported.
   * @returns `{ width, height }` in pixels, or undefined when unreadable.
   */
  const imageSize = (raw, mimeType) => {
    if (mimeType === 'image/png') return { width: raw.readUInt32BE(16), height: raw.readUInt32BE(20) }
    if (mimeType === 'image/gif') return { width: raw.readUInt16LE(6), height: raw.readUInt16LE(8) }
    if (mimeType === 'image/jpeg') {
      let offset = 2
      while (offset + 9 < raw.length) {
        if (raw[offset] !== 0xff) {
          offset += 1
          continue
        }
        const marker = raw[offset + 1]
        const length = raw.readUInt16BE(offset + 2)
        // SOF0..SOF3 carry the frame size; the other markers only carry metadata.
        if (marker >= 0xc0 && marker <= 0xc3) {
          return { height: raw.readUInt16BE(offset + 5), width: raw.readUInt16BE(offset + 7) }
        }
        if (length < 2) return undefined
        offset += 2 + length
      }
      return undefined
    }
    // WebP: VP8X stores canvas size - 1, VP8 the visible frame, VP8L a packed pair.
    const chunk = raw.subarray(12, 16).toString('latin1')
    if (chunk === 'VP8X') {
      return { width: raw.readUIntLE(24, 3) + 1, height: raw.readUIntLE(27, 3) + 1 }
    }
    if (chunk === 'VP8 ') {
      return { width: raw.readUInt16LE(26) & 0x3fff, height: raw.readUInt16LE(28) & 0x3fff }
    }
    if (chunk === 'VP8L') {
      const bits = raw.readUInt32LE(21)
      return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 }
    }
    return undefined
  }

  /**
   * Locate an image a conversation message referenced by its `sha256:` id.
   *
   * DSH stores attachments content-addressed under the profile's attachment
   * root, so the id alone names the file: an image the user pasted is readable
   * without asking them for a path. Both the normalized-image store and the
   * verbatim one are checked, and a miss is reported rather than guessed at.
   * @param attachmentId - `sha256:<hex>` as printed in the conversation.
   * @returns an absolute path, or undefined when nothing is stored under it.
   */
  const attachmentPath = async (attachmentId) => {
    const digest = String(attachmentId).trim().replace(/^sha256:/, '')
    if (!/^[0-9a-f]{64}$/i.test(digest)) return undefined
    const home = process.env.DSH_HOME ?? join(homedir(), '.dsh')
    const shard = digest.slice(0, 2)
    const candidates = [
      join(home, 'attachments', 'v1', 'objects', shard, digest),
      join(home, 'attachments', 'v1', 'file-objects', shard, digest),
    ]
    for (const candidate of candidates) {
      try {
        await stat(candidate)
        return candidate
      } catch {
        // Try the next store; a miss is the normal case for the other one.
      }
    }
    return undefined
  }

  /**
   * Place images as a strip or a grid with one gap between every pair.
   *
   * Widths follow from a shared height, so a row of screenshots of different
   * shapes still lines up on both edges. The block is centred on `centreX` and
   * starts at `topY`.
   * @param sizes - `{ width, height }` in pixels, in the wanted order.
   * @param options - `{ height, gap, columns, centreX, topY }`.
   * @returns one `{ x, y, width, height }` per image.
   */
  const layoutImages = (sizes, options) => {
    const height = options.height
    const gap = options.gap
    const columns = Math.max(1, Math.min(sizes.length, options.columns ?? sizes.length))
    const widths = sizes.map(size => Math.round(height * (size.width / size.height) * 10) / 10)
    const rows = []
    for (let index = 0; index < widths.length; index += columns) rows.push(widths.slice(index, index + columns))
    const widest = Math.max(...rows.map(row => row.reduce((sum, width) => sum + width, 0) + gap * (row.length - 1)))
    const boxes = []
    let y = options.topY
    for (const row of rows) {
      let x = options.centreX - (row.reduce((sum, width) => sum + width, 0) + gap * (row.length - 1)) / 2
      for (const width of row) {
        boxes.push({ x: Math.round(x * 10) / 10, y: Math.round(y * 10) / 10, width, height })
        x += width + gap
      }
      y += height + gap
    }
    return { boxes, width: widest, height: rows.length * height + gap * (rows.length - 1) }
  }

  /**
   * Queue a diagram operation and report what the browser did.
   * @param canvas - canvas name.
   * @param op - diagram operation.
   * @param timeoutMs - how long to wait for the browser.
   * @returns whether the browser applied it.
   */
  /**
   * Turn a browser answer into the tool's canonical result.
   * @param outcome - `{ answered, applied, detail }` from the browser.
   * @param canvas - canvas name.
   * @param copy - the three sentences for done, refused, and queued.
   * @returns the declared tool value.
   */
  const describeOutcome = (outcome, canvas, copy) => {
    if (outcome?.applied === true) return { applied: true, summary: copy.done }
    if (outcome?.answered === true) {
      const reason = outcome.detail?.error
      return {
        applied: false,
        summary: `${copy.failed}${reason === undefined ? '' : `: ${reason}`}. Canvas "${canvas}" was not changed.`,
      }
    }
    return { applied: false, summary: copy.queued }
  }

  const dispatch = async (canvas, op, timeoutMs, session) => {
    const identity = identityOf({ name: canvas, session })
    const id = enqueue(identity.key, op)
    requestOpen(identity)
    return waitForApply(identity.key, [id], timeoutMs)
  }

  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'excalidraw_read',
    description:
      'Read an Excalidraw canvas from the workspace, or list the canvases that exist. '
      + 'Returns every node id, label, shape and position plus the arrows between them, so a later '
      + 'excalidraw_edit can name what it changes. Omit `name` to list canvases.',
    parameters: {
      name: { type: 'string', description: 'Canvas name without the .excalidraw extension.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          summary: { type: 'string', required: true },
          canvases: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                name: { type: 'string', required: true },
                elementCount: { type: 'integer', required: true },
              },
            },
          },
          nodes: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string', required: true },
                label: { type: 'string', required: true },
                x: { type: 'integer', required: true },
                y: { type: 'integer', required: true },
              },
            },
          },
          edges: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                from: { type: 'string', required: true },
                to: { type: 'string', required: true },
              },
            },
          },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.summary }],
    },
    async execute(args, exec) {
      const session = exec?.agent?.session?.id
      if (args.name === undefined || args.name.trim() === '') {
        const listed = await listCanvases(ctx, config, session)
        const canvases = listed.canvases.map(canvas => ({ name: canvas.name, elementCount: canvas.elementCount }))
        const summary = canvases.length === 0
          ? `No canvases yet in ${listed.folder}. Create one with excalidraw_draw.`
          : `Canvases in ${listed.folder}:\n${canvases.map(canvas => `- ${canvas.name} (${canvas.elementCount} elements)`).join('\n')}`
        return { summary, canvases, nodes: [], edges: [] }
      }
      const target = resolveTarget(ctx, config, { name: args.name, session })
      const canvas = target.name
      const document = await readDocument(target.file)
      if (!document.exists) {
        return {
          summary: `Canvas "${canvas}" does not exist. Create it with excalidraw_draw.`,
          canvases: [],
          nodes: [],
          edges: [],
        }
      }
      const summary = summarize(document.scene)
      return {
        summary: formatSummary({ name: canvas, rev: document.rev }, summary),
        canvases: [{ name: canvas, elementCount: summary.elementCount }],
        nodes: summary.nodes.map(node => ({ id: node.id, label: node.label, x: node.x, y: node.y })),
        edges: summary.edges.map(edge => ({ from: edge.from ?? '', to: edge.to ?? '' })),
      }
    },
  })), 'dsh-excalidraw-canvas: read tool')

  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'excalidraw_draw',
    description:
      'Draw a diagram on an Excalidraw canvas in the DSH right sidebar. Give nodes with ids and labels plus '
      + 'arrows between those ids; the layout, sizing, and arrow attachment are computed automatically in the '
      + 'browser, so do not compute coordinates unless you want to place something precisely. '
      + '`mode: replace` (default) redraws the whole canvas, `merge` adds to what is there. '
      + 'The panel opens by itself and shows the result. '
      + 'Rules that keep the picture readable: never draw a retry loop (a cycle edge is routed around the '
      + 'outside and looks cramped) - end that branch in a node whose label states the action, such as '
      + '"提示：密码错误\\n返回重试"; use `diamond` only for a yes/no question, one short line, with '
      + 'width 320 and height 150; label branch arrows "是"/"否"; leave x/y out so the layout decides.',
    parameters: {
      name: { type: 'string', required: true, description: 'Canvas name, for example "checkout-architecture".' },
      title: { type: 'string', description: 'Optional heading drawn above the diagram.' },
      direction: { type: 'string', enum: ['TB', 'LR'], description: 'Flow direction: TB top-to-bottom (default) or LR left-to-right.' },
      mode: { type: 'string', enum: ['replace', 'merge'], description: 'replace clears the canvas first (default); merge keeps existing content.' },
      nodes: { type: 'array', required: true, description: 'Boxes to draw.', items: nodeShape },
      edges: { type: 'array', description: 'Arrows between node ids.', items: edgeShape },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          applied: { type: 'boolean', required: true },
          summary: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.summary }],
    },
    async execute(args, exec) {
      const { name: canvas } = resolveTarget(ctx, config, { name: args.name, session: exec?.agent?.session?.id })
      const ids = new Set(args.nodes.map(node => node.id))
      for (const edge of args.edges ?? []) {
        if (!ids.has(edge.from) && !(args.mode === 'merge')) throw new Error(`edge references unknown node "${edge.from}"`)
        if (!ids.has(edge.to) && !(args.mode === 'merge')) throw new Error(`edge references unknown node "${edge.to}"`)
      }
      const outcome = await dispatch(canvas, {
        kind: 'draw',
        mode: args.mode ?? 'replace',
        direction: args.direction ?? 'TB',
        title: args.title ?? null,
        nodes: args.nodes,
        edges: args.edges ?? [],
      }, config.applyTimeoutMs, exec?.agent?.session?.id)
      const nodes = outcome?.detail?.nodes ?? args.nodes.length
      const arrows = outcome?.detail?.arrows ?? (args.edges ?? []).length
      return describeOutcome(outcome, canvas, {
        done: `Drew ${nodes} nodes and ${arrows} arrows on canvas "${canvas}".`,
        failed: 'The open Excalidraw panel refused the operation',
        queued: `Queued the diagram for canvas "${canvas}"; it is drawn as soon as the Excalidraw panel is open.`,
      })
    },
  })), 'dsh-excalidraw-canvas: draw tool')

  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'excalidraw_edit',
    description:
      'Change an existing Excalidraw canvas by element id: rename labels, move or resize nodes, recolor them, '
      + 'delete elements, or add nodes and arrows to what is already drawn. Read the canvas with '
      + 'excalidraw_read first to learn the ids.',
    parameters: {
      name: { type: 'string', required: true, description: 'Canvas name without the extension.' },
      edits: {
        type: 'array',
        description: 'Per-element changes, matched by element id.',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            id: { type: 'string', required: true, description: 'Element or node id.' },
            label: { type: 'string', description: 'New text for the element.' },
            x: { type: 'number', description: 'New x position.' },
            y: { type: 'number', description: 'New y position.' },
            width: { type: 'number', description: 'New width.' },
            height: { type: 'number', description: 'New height.' },
            color: { type: 'string', enum: COLORS, description: 'New fill accent.' },
            fontSize: { type: 'number', description: 'New label font size.' },
          },
        },
      },
      remove: { type: 'array', description: 'Element ids to delete.', items: { type: 'string' } },
      addNodes: { type: 'array', description: 'Nodes to add, laid out beside the existing content.', items: nodeShape },
      addEdges: { type: 'array', description: 'Arrows to add between existing or added node ids.', items: edgeShape },
      reroute: {
        type: 'boolean',
        description: 'Recompute every arrow so it meets its shapes at the edge instead of running through the '
          + 'label. Use after moving or resizing shapes, and once on a canvas drawn before boundary attachment existed.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          applied: { type: 'boolean', required: true },
          summary: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.summary }],
    },
    async execute(args, exec) {
      const { name: canvas } = resolveTarget(ctx, config, { name: args.name, session: exec?.agent?.session?.id })
      const edits = args.edits ?? []
      const remove = args.remove ?? []
      const addNodes = args.addNodes ?? []
      const addEdges = args.addEdges ?? []
      const reroute = args.reroute === true
      if (edits.length + remove.length + addNodes.length + addEdges.length === 0 && !reroute) {
        return { applied: false, summary: 'Nothing to do: no edits, removals, or additions were given.' }
      }
      const outcome = await dispatch(canvas, {
        kind: 'edit',
        edits,
        remove,
        addNodes,
        addEdges,
        reroute,
      }, config.applyTimeoutMs, exec?.agent?.session?.id)
      const detail = outcome?.detail
      const changed = detail?.changed ?? edits.length
      const matched = detail?.matched ?? edits.length
      const removed = detail?.removed ?? remove.length
      const added = detail?.added ?? addNodes.length
      const missed = Math.max(0, edits.length - matched)
      const rerouted = detail?.rerouted
      return describeOutcome(outcome, canvas, {
        done: `Updated canvas "${canvas}": ${changed} changed, ${removed} removed, ${added} added`
          + (rerouted === undefined ? '' : `, ${rerouted} arrows re-attached to shape edges`)
          + (missed > 0 ? `; ${missed} edit(s) named an id that is not on the canvas.` : '.'),
        failed: 'The open Excalidraw panel refused the operation',
        queued: `Queued the changes for canvas "${canvas}"; they apply as soon as the Excalidraw panel is open.`,
      })
    },
  })), 'dsh-excalidraw-canvas: edit tool')

  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'excalidraw_add_images',
    description:
      'Place images - screenshots, photos, exported charts - on an Excalidraw canvas. The bytes are read from '
      + 'a file in the workspace (or from an image the user attached to the conversation) and embedded in the '
      + 'document, so the .excalidraw file stays self-contained. Do not compute positions: the tool scales every '
      + 'image to one shared height, keeps an equal gap between them, and anchors the block below the existing '
      + 'content. Use layout "grid" with `columns` when a single row would be wider than the canvas is tall. '
      + 'To caption or annotate them afterwards, use excalidraw_edit with an explicit x/y.',
    parameters: {
      name: { type: 'string', required: true, description: 'Canvas name without the .excalidraw extension.' },
      images: {
        type: 'array',
        required: true,
        description: 'Images to place, in reading order.',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            path: { type: 'string', description: 'png/jpeg/webp/gif file: workspace-relative or absolute.' },
            attachmentId: { type: 'string', description: 'Conversation attachment id ("sha256:..."), instead of a path.' },
          },
        },
      },
      layout: {
        type: 'string',
        enum: ['row', 'grid'],
        description: 'row (default) puts every image on one line; grid wraps after `columns` images.',
      },
      columns: { type: 'integer', description: 'Images per row for layout "grid", 1 to 6; default 3.' },
      height: { type: 'number', description: 'Shared height in canvas units, default 420; widths follow the aspect ratio.' },
      gap: { type: 'number', description: 'Space between images, and between grid rows; default 44.' },
      anchor: {
        type: 'string',
        enum: ['below', 'right', 'origin'],
        description: 'Where the block starts: below the existing content (default), to its right, or at the origin.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          applied: { type: 'boolean', required: true },
          summary: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.summary }],
    },
    async execute(args, exec) {
      const session = exec?.agent?.session?.id
      const target = resolveTarget(ctx, config, { name: args.name, session })
      const canvas = target.name
      const document = await readDocument(target.file)
      if (!document.exists) {
        return {
          applied: false,
          summary: `Canvas "${canvas}" does not exist yet. Draw it first with excalidraw_draw, then add images.`,
        }
      }

      const entries = args.images ?? []
      if (entries.length === 0) return { applied: false, summary: 'No images were given.' }
      const limit = 20 * 1024 * 1024
      const files = []
      const sizes = []
      let total = 0
      for (const [index, entry] of entries.entries()) {
        let file = undefined
        if (typeof entry.attachmentId === 'string' && entry.attachmentId !== '') {
          file = await attachmentPath(entry.attachmentId)
          if (file === undefined) {
            return {
              applied: false,
              summary: `No stored image for attachment ${entry.attachmentId}. `
                + 'Pass its file path as "path" instead.',
            }
          }
        } else if (typeof entry.path === 'string' && entry.path !== '') {
          file = resolve(target.root, entry.path)
        } else {
          return { applied: false, summary: `Image ${index + 1} needs a "path" or an "attachmentId".` }
        }
        let raw
        try {
          raw = await readFile(file)
        } catch (error) {
          return { applied: false, summary: `Cannot read ${file}: ${error.message}` }
        }
        if (raw.length > limit) {
          return { applied: false, summary: `${basename(file)} is larger than 20 MB; use a smaller copy.` }
        }
        const mimeType = sniffImage(raw)
        if (mimeType === undefined) {
          return { applied: false, summary: `${basename(file)} is not a png, jpeg, webp, or gif image.` }
        }
        const size = imageSize(raw, mimeType)
        if (size === undefined || size.width === 0 || size.height === 0) {
          return { applied: false, summary: `Cannot read the pixel size of ${basename(file)}.` }
        }
        total += raw.length
        if (total > 40 * 1024 * 1024) {
          return { applied: false, summary: 'These images add up to more than 40 MB; add fewer, or smaller copies.' }
        }
        const fileId = `image:${randomUUID().slice(0, 8)}`
        files.push({ id: fileId, mimeType, dataURL: `data:${mimeType};base64,${raw.toString('base64')}`, created: Date.now() })
        sizes.push(size)
      }

      const live = (document.scene?.elements ?? []).filter(element => element.isDeleted !== true)
      const bounds = live.reduce((box, element) => ({
        minX: Math.min(box.minX, element.x),
        minY: Math.min(box.minY, element.y),
        maxX: Math.max(box.maxX, element.x + element.width),
        maxY: Math.max(box.maxY, element.y + element.height),
      }), { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity })
      const hasContent = Number.isFinite(bounds.minX)
      const height = Math.min(1200, Math.max(80, Math.round(args.height ?? 420)))
      const gap = Math.min(400, Math.max(4, Math.round(args.gap ?? 44)))
      const columns = args.layout === 'grid' ? Math.min(6, Math.max(1, Math.round(args.columns ?? 3))) : sizes.length
      const plan = layoutImages(sizes, { height, gap, columns, centreX: 0, topY: 0 })
      const anchor = args.anchor ?? 'below'
      const centreX = anchor === 'right' && hasContent ? bounds.maxX + 64 + plan.width / 2
        : hasContent ? (bounds.minX + bounds.maxX) / 2
          : plan.width / 2
      const topY = anchor === 'below' && hasContent ? bounds.maxY + 64
        : anchor === 'right' && hasContent ? (bounds.minY + bounds.maxY) / 2 - plan.height / 2
          : 0
      const { boxes } = layoutImages(sizes, { height, gap, columns, centreX, topY })
      const placements = boxes.map((box, index) => ({
        id: `image-${randomUUID().slice(0, 8)}`,
        fileId: files[index].id,
        ...box,
      }))

      const outcome = await dispatch(canvas, { kind: 'images', files, placements }, config.applyTimeoutMs, session)
      const shape = args.layout === 'grid' ? `${columns}-column grid` : 'row'
      const where = anchor === 'right' ? 'to the right of the existing content'
        : anchor === 'origin' ? 'at the scene origin'
          : 'below the existing content'
      return describeOutcome(outcome, canvas, {
        done: `Placed ${placements.length} image${placements.length === 1 ? '' : 's'} on canvas "${canvas}" `
          + `as a ${shape} at ${height}px high with ${gap}px gaps, ${where}.`,
        failed: 'The open Excalidraw panel refused the operation',
        queued: `Queued ${placements.length} images for canvas "${canvas}"; they appear when the panel is open.`,
      })
    },
  })), 'dsh-excalidraw-canvas: images tool')

  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'excalidraw_export',
    description:
      'Export a canvas next to its document as PNG or SVG, for embedding in documents or chat. '
      + 'Requires the Excalidraw panel to be open; the browser renders the image.',
    parameters: {
      name: { type: 'string', required: true, description: 'Canvas name without the extension.' },
      format: { type: 'string', required: true, enum: ['png', 'svg'], description: 'Image format.' },
      scale: {
        type: 'integer',
        description: 'Pixel multiplier for a PNG, 1 to 4. Defaults to 2; use 3 or 4 for a hand drawing that will be '
          + 'looked at closely or printed. Excalidraw renders at 1x unless told otherwise, which is why a single '
          + 'drawing can look soft.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          exported: { type: 'boolean', required: true },
          summary: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.summary }],
    },
    async execute(args, exec) {
      const target = resolveTarget(ctx, config, { name: args.name, session: exec?.agent?.session?.id })
      const canvas = target.name
      const file = target.file
      const document = await readDocument(file)
      if (!document.exists) throw new Error(`canvas "${canvas}" does not exist`)
      const identity = target
      identity.session = exec?.agent?.session?.id ?? null
      const scale = Math.min(4, Math.max(1, Math.round(args.scale ?? 2)))
      const id = enqueue(identity.key, { kind: 'export', format: args.format, scale })
      requestOpen(identity)
      const outcome = await waitForApply(identity.key, [id], config.exportTimeoutMs)
      if (outcome.applied !== true) {
        return {
          exported: false,
          summary: outcome.answered === true
            ? `The panel could not render canvas "${canvas}": ${outcome.detail?.error ?? 'unknown error'}.`
            : `Open the Excalidraw panel on canvas "${canvas}" and run excalidraw_export again: the browser renders the image.`,
        }
      }
      const quality = args.format === 'png' ? ` at ${scale}x` : ''
      return { exported: true, summary: `Exported canvas "${canvas}" as ${args.format.toUpperCase()}${quality} beside its document.` }
    },
  })), 'dsh-excalidraw-canvas: export tool')
}
