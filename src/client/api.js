/**
 * Thin client for the plugin's own Host routes.
 *
 * Requests stay document-relative, so the same code works behind the Web
 * carrier and the Desktop IPC bridge.
 *
 * @module dsh-excalidraw-canvas/client/api
 */

const BASE = 'plugins/dsh-excalidraw-canvas/api'

/**
 * Decode one response, turning an error status into a rejected promise that
 * keeps the payload (a save conflict carries the current scene).
 * @param response - fetch response.
 * @returns the parsed JSON body.
 */
async function decode(response) {
  let body
  try {
    body = await response.json()
  } catch {
    body = {}
  }
  if (!response.ok) {
    const error = new Error(body?.error ?? `request failed with ${response.status}`)
    error.status = response.status
    error.payload = body
    error.url = response.url
    throw error
  }
  return body
}

/**
 * One GET request against the canvas API.
 * @param path - path and query below the API root.
 * @returns the parsed body.
 */
function get(path) {
  return fetch(`${BASE}${path}`, { headers: { accept: 'application/json' } }).then(decode)
}

/**
 * One POST request against the canvas API.
 * @param path - path below the API root.
 * @param body - JSON payload.
 * @returns the parsed body.
 */
function post(path, body) {
  return fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }).then(decode)
}

/**
 * Append the session to a query string, so the Host resolves the same
 * workspace directory the session's tools use.
 * @param query - existing query text without a leading `?`.
 * @param session - session id, when known.
 * @returns the query text.
 */
function withSession(query, session) {
  if (typeof session !== 'string' || session === '') return `?${query}`
  const prefix = query === '' ? '?' : `?${query}&`
  return `${prefix}session=${encodeURIComponent(session)}`
}

/**
 * Identify the document a call is about.
 *
 * A canvas opened from the picker is named (`{ name }`); one opened from a file
 * link or the Files tree is a workspace path (`{ path }`).
 * @param target - `{ name }` or `{ path }`.
 * @returns query text such as `name=flow` or `path=excalidraw/flow.excalidraw`.
 */
function targetQuery(target) {
  if (typeof target?.path === 'string' && target.path !== '') return `path=${encodeURIComponent(target.path)}`
  return `name=${encodeURIComponent(target?.name ?? '')}`
}

/**
 * Spread the target into a request body.
 * @param target - `{ name }` or `{ path }`.
 * @returns the identifying body fields.
 */
function targetBody(target) {
  if (typeof target?.path === 'string' && target.path !== '') return { path: target.path }
  return { name: target?.name ?? '' }
}

/** The canvas API the panel calls. */
export const canvasApi = {
  /** Inventory of canvases, pending open requests, and queue lengths. */
  state: (session) => get(`/state${withSession('', session)}`),
  /**
   * One canvas document plus the operations queued for it.
   * @param name - canvas name.
   * @param session - session whose workspace holds the canvas.
   */
  scene: (target, session) => get(`/scene${withSession(targetQuery(target), session)}`),
  /**
   * Store a scene.
   * @param name - canvas name.
   * @param scene - Excalidraw scene envelope.
   * @param baseRev - the revision this save is based on.
   * @param session - session whose workspace holds the canvas.
   */
  save: (target, scene, baseRev, session, create = false) => post('/save', { ...targetBody(target), scene, baseRev, session, create }),
  /**
   * Operations queued for a canvas.
   * @param name - canvas name.
   * @param session - session whose workspace holds the canvas.
   */
  ops: (target, session) => get(`/ops${withSession(targetQuery(target), session)}`),
  /**
   * Report operations as handled.
   * @param name - canvas name.
   * @param ids - operation ids.
   * @param applied - false when the panel refused them.
   * @param openedIds - open-request ids the panel honoured.
   * @param session - session whose workspace holds the canvas.
   * @param detail - what the batch changed, or the failure text.
   */
  ack: (target, ids, applied, openedIds, session, detail) => post('/ops', {
    ...targetBody(target), ack: true, ids, applied, openedIds, session, detail,
  }),
  /**
   * Store an exported image beside the document.
   * @param name - canvas name.
   * @param format - `png` or `svg`.
   * @param data - base64 payload.
   */
  asset: (target, format, data, session) => post('/asset', { ...targetBody(target), format, data, session }),
}
