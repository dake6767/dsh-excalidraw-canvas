/**
 * The canvas panel: one Excalidraw editor bound to a `.excalidraw` document that
 * the agent edits through the same Host-owned operations queue.
 *
 * @module dsh-excalidraw-canvas/client/panel
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { CaptureUpdateAction, Excalidraw, exportToBlob, exportToSvg } from '@excalidraw/excalidraw'
import { canvasApi } from './api.js'
import { reportToHost } from './report.js'
import { applyEdit, buildDiagram, imageElements, mergeDiagram } from './diagram.js'
import { CanvasIcon, DownloadIcon, FitIcon, ImageIcon, MaximizeIcon, PlusIcon, ReloadIcon, SendIcon } from './icons.jsx'

/**
 * Take the canvas element fullscreen, or leave it.
 *
 * The sidebar's pane fullscreen only fills the app window - the conversation and
 * the shell stay on screen - so the real thing asks the browser: `requestFullscreen`
 * on the canvas wrapper removes every other surface and gives the drawing the
 * whole display, the way a slideshow behaves. Browsers require a user gesture, so
 * this is only ever called from a click.
 * @param wrapper - the element that wraps the editor.
 * @param onFallback - pane-level toggle, used when the API is unavailable.
 * @returns whether a fullscreen surface was entered or left.
 */
async function toggleElementFullscreen(wrapper, onFallback) {
  try {
    if (document.fullscreenElement !== null) {
      await document.exitFullscreen()
      reportToHost('fullscreen-exited')
      return true
    }
    if (wrapper !== null && typeof wrapper.requestFullscreen === 'function') {
      await wrapper.requestFullscreen({ navigationUI: 'hide' })
      reportToHost('fullscreen-entered', null, { via: 'element' })
      return true
    }
  } catch (error) {
    reportToHost('fullscreen-failed', error, { via: 'element' })
  }
  return onFallback !== null && onFallback() === true
}

/**
 * Bounds of the live elements, or null when the scene is empty.
 * @param elements - live scene elements, deleted ones included.
 * @returns `{ minX, minY, maxX, maxY }`.
 */
function sceneBounds(elements) {
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const element of elements) {
    if (element.isDeleted === true) continue
    minX = Math.min(minX, element.x)
    minY = Math.min(minY, element.y)
    maxX = Math.max(maxX, element.x + element.width)
    maxY = Math.max(maxY, element.y + element.height)
  }
  return Number.isFinite(minX) ? { minX, minY, maxX, maxY } : null
}

/**
 * Navigator thumbnail of the canvas, with the visible rectangle.
 *
 * A narrow dock pane shows a fraction of a wide canvas, so the navigator answers
 * "where am I" without zooming out to the point where nothing is legible. It
 * borrows the approach of a companion Excalidraw plugin: draw blocks and
 * polylines only - never the real strokes - and rebuild the thumbnail only when
 * the scene actually changed, so following the viewport costs a rectangle.
 * @param props - `{ apiRef }`.
 * @returns the navigator, or null before the editor exists.
 */
function CanvasMinimap({ apiRef }) {
  const canvasRef = useRef(null)
  const contentRef = useRef(null)
  const stampRef = useRef(-1)
  const viewRef = useRef(null)
  const reportedRef = useRef(false)

  useEffect(() => {
    let frame = 0
    let disposed = false
    let last = 0

    const paint = () => {
      const api = apiRef.current
      const canvas = canvasRef.current
      if (api === null || canvas === null) return
      const elements = api.getSceneElements()
      const bounds = sceneBounds(elements)
      const appState = api.getAppState()
      const zoom = appState.zoom?.value ?? 1
      const size = { width: appState.width ?? 0, height: appState.height ?? 0 }
      const view = {
        x: -appState.scrollX,
        y: -appState.scrollY,
        width: zoom === 0 ? 0 : size.width / zoom,
        height: zoom === 0 ? 0 : size.height / zoom,
      }
      viewRef.current = { bounds, view }

      const ratio = window.devicePixelRatio || 1
      const width = Math.round(MINIMAP_WIDTH * ratio)
      const height = Math.round(MINIMAP_HEIGHT * ratio)
      if (canvas.width !== width || canvas.height !== height) {
        canvas.width = width
        canvas.height = height
      }
      const context = canvas.getContext('2d')
      if (context === null) return
      context.clearRect(0, 0, width, height)
      canvas.style.display = bounds === null ? 'none' : ''
      if (bounds === null) return

      // One scale for both axes keeps the picture's proportions; the viewport
      // box may spill past the thumbnail, which is the honest thing to draw.
      const extentX = Math.max(bounds.maxX - bounds.minX, view.x + view.width - bounds.minX, 1)
      const extentY = Math.max(bounds.maxY - bounds.minY, view.y + view.height - bounds.minY, 1)
      const pad = 4 * ratio
      const scale = Math.min((width - pad * 2) / extentX, (height - pad * 2) / extentY)
      const offsetX = pad - Math.min(bounds.minX, view.x) * scale
      const offsetY = pad - Math.min(bounds.minY, view.y) * scale

      let content = contentRef.current
      if (content === null) {
        content = document.createElement('canvas')
        contentRef.current = content
      }
      const stamp = sceneStamp(elements, appState.viewBackgroundColor)
      if (content.width !== width || content.height !== height) {
        content.width = width
        content.height = height
      }
      if (stamp !== stampRef.current) {
        stampRef.current = stamp
        const offscreen = content.getContext('2d')
        if (offscreen !== null) {
          offscreen.clearRect(0, 0, width, height)
          offscreen.fillStyle = 'rgba(120, 130, 150, 0.85)'
          offscreen.strokeStyle = 'rgba(120, 130, 150, 0.85)'
          for (const element of elements) {
            if (element.isDeleted === true) continue
            const x = offsetX + element.x * scale
            const y = offsetY + element.y * scale
            const w = Math.max(element.width * scale, 1)
            const h = Math.max(element.height * scale, 1)
            if (element.type === 'text') {
              offscreen.globalAlpha = 0.5
              offscreen.fillRect(x, y + h * 0.2, w, Math.max(h * 0.6, 1))
              offscreen.globalAlpha = 1
            } else if (element.type === 'ellipse') {
              offscreen.globalAlpha = 0.35
              offscreen.beginPath()
              offscreen.ellipse(x + w / 2, y + h / 2, w / 2 || 1, h / 2 || 1, 0, 0, Math.PI * 2)
              offscreen.fill()
              offscreen.globalAlpha = 1
            } else if (element.type === 'diamond') {
              offscreen.globalAlpha = 0.35
              offscreen.beginPath()
              offscreen.moveTo(x + w / 2, y)
              offscreen.lineTo(x + w, y + h / 2)
              offscreen.lineTo(x + w / 2, y + h)
              offscreen.lineTo(x, y + h / 2)
              offscreen.closePath()
              offscreen.fill()
              offscreen.globalAlpha = 1
            } else if (element.type === 'line' || element.type === 'arrow' || element.type === 'freedraw') {
              // Freedraw keeps its polyline (no stroke width, no pressure): the
              // thumbnail needs the gesture's shape, not its ink.
              const points = Array.isArray(element.points) ? element.points : []
              if (points.length < 2) continue
              offscreen.beginPath()
              const first = points[0]
              offscreen.moveTo(offsetX + (element.x + first[0]) * scale, offsetY + (element.y + first[1]) * scale)
              for (const point of points.slice(1)) {
                offscreen.lineTo(offsetX + (element.x + point[0]) * scale, offsetY + (element.y + point[1]) * scale)
              }
              offscreen.lineWidth = Math.max(1, ratio * 0.8)
              offscreen.stroke()
            } else if (element.type === 'frame') {
              offscreen.globalAlpha = 0.25
              offscreen.fillRect(x, y, w, h)
              offscreen.globalAlpha = 1
              offscreen.strokeRect(x, y, w, h)
            } else {
              offscreen.fillRect(x, y, w, h)
            }
          }
        }
      }

      context.drawImage(content, 0, 0)
      if (!reportedRef.current) {
        reportedRef.current = true
        reportToHost('minimap-painted', null, { elements: elements.length })
      }
      // The viewport rectangle, drawn every tick: cheap and always current.
      context.strokeStyle = 'rgba(63, 131, 248, 0.95)'
      context.lineWidth = Math.max(1, ratio)
      context.strokeRect(
        offsetX + view.x * scale,
        offsetY + view.y * scale,
        Math.max(view.width * scale, 2),
        Math.max(view.height * scale, 2),
      )
    }

    const tick = (now) => {
      if (disposed) return
      if (now - last >= MINIMAP_INTERVAL_MS) {
        last = now
        paint()
      }
      frame = window.requestAnimationFrame(tick)
    }
    frame = window.requestAnimationFrame(tick)
    return () => {
      disposed = true
      window.cancelAnimationFrame(frame)
    }
  }, [apiRef])

  /** Centre the editor on the scene point under the pointer. */
  const centreOn = useCallback((event) => {
    const api = apiRef.current
    const canvas = canvasRef.current
    const current = viewRef.current
    if (api === null || canvas === null || current === null || current.bounds === null) return
    const rect = canvas.getBoundingClientRect()
    const ratio = canvas.width / Math.max(rect.width, 1)
    const width = canvas.width
    const height = canvas.height
    const bounds = current.bounds
    const view = current.view
    const extentX = Math.max(bounds.maxX - bounds.minX, view.x + view.width - bounds.minX, 1)
    const extentY = Math.max(bounds.maxY - bounds.minY, view.y + view.height - bounds.minY, 1)
    const pad = 4 * ratio
    const scale = Math.min((width - pad * 2) / extentX, (height - pad * 2) / extentY)
    const offsetX = pad - Math.min(bounds.minX, view.x) * scale
    const offsetY = pad - Math.min(bounds.minY, view.y) * scale
    const pointX = ((event.clientX - rect.left) * ratio - offsetX) / scale
    const pointY = ((event.clientY - rect.top) * ratio - offsetY) / scale
    const appState = api.getAppState()
    const zoom = appState.zoom?.value ?? 1
    if (zoom === 0) return
    // Keep the gesture out of the undo stack: moving the viewport is not an edit.
    api.updateScene({
      appState: {
        scrollX: (appState.width ?? 0) / (2 * zoom) - pointX,
        scrollY: (appState.height ?? 0) / (2 * zoom) - pointY,
      },
      captureUpdate: CaptureUpdateAction.NEVER,
    })
  }, [apiRef])

  return (
    <canvas
      ref={canvasRef}
      className="dxc-minimap"
      width={MINIMAP_WIDTH}
      height={MINIMAP_HEIGHT}
      style={{ width: MINIMAP_WIDTH, height: MINIMAP_HEIGHT }}
      onPointerDown={event => {
        event.currentTarget.setPointerCapture(event.pointerId)
        centreOn(event)
      }}
      onPointerMove={event => {
        if (event.buttons !== 1) return
        centreOn(event)
      }}
    />
  )
}

/** How often the panel asks for agent operations. */
const OPS_INTERVAL_MS = 1200
/** Quiet period before an edit is written back to disk. */
const SAVE_DELAY_MS = 450
/** How long the "agent updated" hint stays on screen. */
const HINT_MS = 4000
/** Navigator thumbnail size, in CSS pixels. */
const MINIMAP_WIDTH = 132
const MINIMAP_HEIGHT = 96
/** How often the navigator catches up with the scene, in ms. */
const MINIMAP_INTERVAL_MS = 120
/** Default pixel multiplier for exports; 1 is Excalidraw's own default and looks soft. */
const EXPORT_SCALE = 2
/** Storage key holding the canvas this browser showed last. */
const LAST_CANVAS_KEY = 'dsh-excalidraw-canvas.last-canvas'
/** The key this plugin used before it was renamed, read once as a fallback. */
const LEGACY_LAST_CANVAS_KEY = 'dsh-excalidraw.last-canvas'

// Module scope, not a fresh object per render: a new UIOptions identity makes
// Excalidraw rebuild its toolbar, which shows up as the active tool flickering.
const UI_OPTIONS = {
  canvasActions: {
    loadScene: false,
    saveToActiveFile: false,
    saveAsImage: false,
    export: false,
    toggleTheme: false,
  },
}

/**
 * Whether the application currently renders dark.
 * @returns true for a dark theme.
 */
function detectDark() {
  try {
    const raw = getComputedStyle(document.documentElement).getPropertyValue('--dsw-alias-bg-base').trim()
    const hex = /^#([0-9a-f]{6})$/i.exec(raw)
    if (hex !== null) {
      const value = parseInt(hex[1], 16)
      const r = (value >> 16) & 0xff
      const g = (value >> 8) & 0xff
      const b = value & 0xff
      return (r * 299 + g * 587 + b * 114) / 1000 < 128
    }
    const rgb = /^rgba?\((\d+)[,\s]+(\d+)[,\s]+(\d+)/i.exec(raw)
    if (rgb !== null) {
      const [r, g, b] = [Number(rgb[1]), Number(rgb[2]), Number(rgb[3])]
      return (r * 299 + g * 587 + b * 114) / 1000 < 128
    }
  } catch {
    // Reading the document is best effort; the light theme is the fallback.
  }
  return false
}

/**
 * Encode a blob as base64 without a data-URL prefix.
 * @param blob - image bytes.
 * @returns the base64 payload.
 */
function base64Of(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result).split(',')[1] ?? '')
    reader.onerror = () => reject(reader.error ?? new Error('could not read the exported image'))
    reader.readAsDataURL(blob)
  })
}

/**
 * Equality key for "what the user would call a change": the elements plus the
 * canvas background, which is the only app state the file carries.
 * @param elements - scene elements.
 * @param background - `appState.viewBackgroundColor`, when known.
 * @returns a comparable string.
 */
function fingerprint(elements, background) {
  return JSON.stringify([elements ?? [], background ?? null])
}

/**
 * Change stamp of a scene, cheap enough to run on every editor event.
 *
 * `onChange` fires once per pointer move while drawing, and serialising the whole
 * scene there turns a drag into O(scene) work per frame - the jank that shows up
 * first on a stroked canvas. Excalidraw bumps `version` and `versionNonce` on
 * every element it changes, so a rolling mix of those two numbers and the counts
 * detects a change without building a single string. A background change is
 * carried separately because it lives in appState, not in the elements.
 * @param elements - the live scene elements.
 * @param background - `viewBackgroundColor`.
 * @returns a comparable number.
 */
function sceneStamp(elements, background) {
  let stamp = 2166136261
  for (const element of elements) {
    // FNV-1a over the version pair: constant work per element, no allocation.
    stamp = Math.imul(stamp ^ (element.version ?? 0), 16777619)
    stamp = Math.imul(stamp ^ (element.versionNonce ?? 0), 16777619)
  }
  stamp = Math.imul(stamp ^ elements.length, 16777619)
  const colour = typeof background === 'string' ? background : ''
  for (let index = 0; index < colour.length; index += 1) {
    stamp = Math.imul(stamp ^ colour.charCodeAt(index), 16777619)
  }
  return stamp >>> 0
}

/**
 * Build the scene envelope saved to disk.
 * @param api - Excalidraw imperative API.
 * @returns the document.
 */
function sceneOf(api) {
  const appState = api.getAppState()
  return {
    type: 'excalidraw',
    version: 2,
    source: 'dsh-excalidraw-canvas',
    elements: api.getSceneElements(),
    appState: {
      viewBackgroundColor: appState.viewBackgroundColor,
      gridSize: appState.gridSize ?? null,
    },
    files: api.getFiles?.() ?? {},
  }
}

/**
 * Identity of one document selection: a picker name or a workspace path.
 * @param target - `{ name }`, `{ path }`, or null.
 * @returns a comparable string.
 */
function targetKey(target) {
  if (target === null || target === undefined) return ''
  if (typeof target.path === 'string' && target.path !== '') return `path:${target.path}`
  return `name:${target.name ?? ''}`
}

/**
 * The name a tab chip and the picker show for one selection.
 * @param target - `{ name }` or `{ path }`.
 * @returns the canvas name without its extension.
 */
function targetLabel(target) {
  if (target === null || target === undefined) return ''
  if (typeof target.name === 'string' && target.name !== '') return target.name
  const file = String(target.path ?? '').split('/').pop() ?? ''
  return file.replace(/\.excalidraw$/i, '')
}

/**
 * Decode a `dsh-resource://file/...` address into a workspace path.
 *
 * This is the address the Conversation and the Files tree hand to
 * `ctx.sidebarRight.openResource`, and the reason a `.excalidraw` link opens in
 * this panel rather than a text preview.
 * @param address - the tab's content address.
 * @returns `{ sessionId, path }` for a file address, or null.
 */
function parseFileAddress(address) {
  const prefix = 'dsh-resource://file/'
  if (typeof address !== 'string' || !address.startsWith(prefix)) return null
  const parts = address.slice(prefix.length).split('/')
  const decode = segment => {
    try {
      return decodeURIComponent(segment)
    } catch {
      return segment
    }
  }
  if (parts[0] === 'session' && parts.length >= 3) {
    return { sessionId: decode(parts[1]), path: parts.slice(2).map(decode).join('/') }
  }
  if (parts[0] === 'absolute' && parts.length >= 2) {
    return { sessionId: undefined, path: `/${parts.slice(1).map(decode).join('/')}` }
  }
  return null
}

/**
 * The document one tab navigation asks for.
 * @param navigation - the tab's navigation record.
 * @returns `{ name }`, `{ path }`, or null when the tab names nothing.
 */
function targetOfNavigation(navigation) {
  const params = navigation?.params
  if (typeof params?.path === 'string' && params.path !== '') return { path: params.path }
  if (typeof params?.name === 'string' && params.name !== '') return { name: params.name }
  const address = parseFileAddress(navigation?.address)
  if (address !== null && address.path !== '') return { path: address.path }
  return null
}

/**
 * A free canvas name that does not collide with the ones that exist.
 * @param canvases - current inventory.
 * @returns a name such as `canvas-1` or `flow-3`.
 */
function suggestName(canvases) {
  const taken = new Set((canvases ?? []).map(entry => entry.name))
  if (taken.size === 0) return 'canvas-1'
  for (let index = 1; index < 100; index += 1) {
    const candidate = `canvas-${index}`
    if (!taken.has(candidate)) return candidate
  }
  return `canvas-${Date.now() % 1000}`
}

/**
 * The one create-canvas form, used by the toolbar and by the empty state.
 * @param props - copy, the draft value, and the three callbacks.
 * @returns the form element.
 */
function CreateForm(props) {
  const { t, value, onChange, onSubmit, onCancel, inline = false } = props
  return (
    <form
      className={inline ? 'dxc-create dxc-create-inline' : 'dxc-create'}
      onSubmit={(event) => { event.preventDefault(); onSubmit() }}
    >
      <input
        className="dxc-input"
        autoFocus
        aria-label={t('prompt.name')}
        placeholder={t('prompt.name')}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => { if (event.key === 'Escape') onCancel() }}
      />
      <button type="submit" className="dxc-button">{t('prompt.ok')}</button>
      <button type="button" className="dxc-button dxc-quiet" onClick={onCancel}>{t('prompt.cancel')}</button>
    </form>
  )
}

/**
 * The canvas panel body.
 * @param props - slot props: `t`, `lang`, and the framework tab hook.
 * @returns the panel element.
 */
export function Panel(props) {
  try {
    return renderPanel(props)
  } catch (error) {
    reportToHost('panel-render-failed', error)
    throw error
  }
}

/**
 * Render the panel body; split out so a render failure can be reported.
 * @param props - slot props.
 * @returns the panel element.
 */
function renderPanel(props) {
  const t = props.t ?? ((key) => key)
  const lang = props.lang ?? 'en'
  const onToggleFullscreen = typeof props.onToggleFullscreen === 'function' ? props.onToggleFullscreen : null
  const panelRootRef = useRef(null)
  const [fullscreenActive, setFullscreenActive] = useState(false)
  const [maximised, setMaximised] = useState(false)
  useEffect(() => {
    const sync = () => setFullscreenActive(document.fullscreenElement === panelRootRef.current)
    document.addEventListener('fullscreenchange', sync)
    return () => document.removeEventListener('fullscreenchange', sync)
  }, [])

  // The CSS fallback has no browser chrome to exit with, so Esc must work here.
  useEffect(() => {
    if (!maximised) return undefined
    const onKey = event => {
      if (event.key === 'Escape') setMaximised(false)
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [maximised])
  const ownSession = typeof props.sessionId === 'string' ? props.sessionId : undefined
  const useTabInfo = props.useTabInfo ?? props.hooks?.tabInfo
  const info = typeof useTabInfo === 'function' ? useTabInfo() : undefined
  const navigation = info?.tab?.navigation
  // A file viewer (Better Sidebar) hands the document over directly instead of
  // going through tab navigation; the native tab keeps using the address.
  const viewerPath = typeof props.path === 'string' && props.path !== '' ? props.path : undefined
  const requestedTarget = viewerPath === undefined
    ? targetOfNavigation(navigation)
    : { path: viewerPath }
  const requestedName = requestedTarget?.name
  // An open request names the session whose workspace holds the canvas, which is
  // how a request raised from another session still finds its own file.
  const requestedSession = viewerPath !== undefined
    ? (typeof props.sessionId === 'string' ? props.sessionId : undefined)
    : (typeof navigation?.params?.session === 'string'
      ? navigation.params.session
      : parseFileAddress(navigation?.address)?.sessionId)
  const sessionId = requestedSession ?? ownSession
  const navigationRevision = navigation?.revision ?? 0

  const apiRef = useRef(null)
  const revRef = useRef('0:0')
  const dirtyRef = useRef(null)
  const savedRef = useRef('')
  const stampRef = useRef(-1)
  const suppressRef = useRef(false)
  const timerRef = useRef(null)
  const hintTimerRef = useRef(null)
  const latestRef = useRef({})
  const sessionRef = useRef(sessionId)
  sessionRef.current = sessionId

  const [theme, setTheme] = useState(() => detectDark())
  const [inventory, setInventory] = useState({ canvases: [], pending: {} })
  /** The canvas this browser showed last time, kept as a hint only. */
  const storedCanvasRef = useRef('')
  const [target, setTarget] = useState(() => {
    if (requestedTarget !== null) return requestedTarget
    try {
      const stored = localStorage.getItem(LAST_CANVAS_KEY)
        ?? localStorage.getItem(LEGACY_LAST_CANVAS_KEY)
        ?? ''
      storedCanvasRef.current = stored
      return stored === '' ? null : { name: stored }
    } catch {
      return null
    }
  })
  const canvas = targetKey(target)
  const [scene, setScene] = useState(null)
  const [phase, setPhase] = useState('loading')
  const [status, setStatus] = useState('saved')
  const [hint, setHint] = useState(null)
  const [failure, setFailure] = useState(null)
  const inventorySignatureRef = useRef('')
  const [conflict, setConflict] = useState(null)
  const [creating, setCreating] = useState(false)
  const [draftName, setDraftName] = useState('')
  const loadingRef = useRef('')
  const inventoryLoadedRef = useRef(false)
  const reportedRef = useRef(false)

  /** Show a transient note in the toolbar. */
  const flash = useCallback((text, kind = 'info') => {
    setHint({ text, kind })
    if (hintTimerRef.current !== null) clearTimeout(hintTimerRef.current)
    hintTimerRef.current = setTimeout(() => setHint(null), HINT_MS)
  }, [])

  useEffect(() => {
    if (reportedRef.current) return
    reportedRef.current = true
    reportToHost('panel-mounted', null, {
      canvas,
      phase,
      hasHook: typeof useTabInfo,
      hasNavigation: navigation !== undefined,
      requested: requestedName ?? null,
      session: sessionId ?? null,
    })
  }, [canvas, navigation, phase, requestedName, useTabInfo])

  // Follow the application theme, because the theme service publishes no
  // subscription and Excalidraw needs a concrete light/dark value.
  useEffect(() => {
    const observer = new MutationObserver(() => setTheme(detectDark()))
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'data-theme', 'style'] })
    return () => observer.disconnect()
  }, [])

  /**
   * Load one document into the editor state.
   * @param next - `{ name }` or `{ path }`; null clears the editor.
   */
  const load = useCallback(async (next) => {
    const key = targetKey(next)
    if (key === '') {
      setScene(null)
      setPhase(inventoryLoadedRef.current ? 'empty' : 'loading')
      return
    }
    loadingRef.current = key
    setPhase('loading')
    try {
      const payload = await canvasApi.scene(next, sessionRef.current)
      if (loadingRef.current !== key) return
      // A canvas that does not exist yet still needs an editable empty scene,
      // otherwise the editor cannot mount and nothing can be drawn into it.
      const loaded = payload.exists === true && payload.scene !== null
        ? payload.scene
        : { type: 'excalidraw', version: 2, source: 'dsh-excalidraw-canvas', elements: [], files: {} }
      setScene(loaded)
      revRef.current = payload.rev
      savedRef.current = fingerprint(loaded.elements, loaded.appState?.viewBackgroundColor)
      stampRef.current = sceneStamp(loaded.elements ?? [], loaded.appState?.viewBackgroundColor)
      if (dirtyRef.current?.key !== key) dirtyRef.current = null
      setConflict(null)
      setStatus('saved')
      setPhase('ready')
    } catch (error) {
      reportToHost('scene-load-failed', error, { target: key, url: error.url, status: error.status })
      if (loadingRef.current !== key) return
      setPhase('error')
      flash(`${t('error.load')}: ${error.message}`, 'error')
    }
  }, [flash, sessionId, t])

  /** Refresh the canvas list. */
  const refreshInventory = useCallback(async () => {
    try {
      const payload = await canvasApi.state(sessionRef.current)
      inventoryLoadedRef.current = true
      const canvases = payload.canvases ?? []
      const pending = payload.pending ?? {}
      // The poll exists to notice a canvas the agent created, not to re-render
      // every five seconds: an unchanged list leaves state alone, so the editor
      // (and its toolbar) is not disturbed while the user is drawing.
      const signature = JSON.stringify([canvases.map(entry => [entry.name, entry.elementCount]), pending])
      if (signature !== inventorySignatureRef.current) {
        inventorySignatureRef.current = signature
        setInventory({ canvases, pending })
      }
      // Only a panel with no canvas at all may fall back to the empty state; a
      // load already in flight owns the phase.
      setPhase(previous => (previous === 'loading' && loadingRef.current === '' ? 'empty' : previous))
      // A remembered name that this workspace no longer has is not a canvas;
      // drop the hint instead of fabricating an empty document for it.
      const remembered = storedCanvasRef.current
      if (remembered !== '' && !(payload.canvases ?? []).some(entry => entry.name === remembered)) {
        storedCanvasRef.current = ''
        setTarget(previous => (targetKey(previous) === `name:${remembered}` ? null : previous))
      }
      return payload
    } catch {
      return null
    }
  }, [])

  // Inventory polling keeps the picker current when the agent creates canvases.
  useEffect(() => {
    let cancelled = false
    const tick = async () => {
      if (cancelled) return
      await refreshInventory()
    }
    tick()
    const timer = setInterval(tick, 5000)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [refreshInventory])

  // An external open (agent draw, a file link, the Files tree) navigates this tab.
  useEffect(() => {
    if (requestedTarget === null) return
    setTarget(previous => (targetKey(previous) === targetKey(requestedTarget) ? previous : requestedTarget))
  }, [requestedTarget === null ? '' : targetKey(requestedTarget), navigationRevision])

  // Load whenever the selected document changes. A picker name resolves onto the
  // inventory path when there is one, so a named open and a file-link open read
  // the same document instead of loading twice.
  useEffect(() => {
    const known = target !== null && target.path === undefined
      ? inventory.canvases.find(entry => entry.name === target.name)
      : undefined
    const effective = known?.path !== undefined ? { path: known.path } : target
    setScene(null)
    void load(effective)
    const label = targetLabel(target)
    if (label !== '') {
      try {
        localStorage.setItem(LAST_CANVAS_KEY, label)
      } catch {
        // A blocked storage write only loses the last-canvas convenience.
      }
    }
  }, [canvas, load])

  // Leaving no document selected after the list is known picks the first one.
  useEffect(() => {
    if (target !== null || phase === 'loading') return
    const first = inventory.canvases[0]
    if (first !== undefined) setTarget(first.path !== undefined ? { path: first.path } : { name: first.name })
  }, [target, inventory, phase])

  /** Serializes saves so two batches cannot race on one document revision. */
  const saveChainRef = useRef(Promise.resolve())

  /**
   * Write the pending scene to disk, once.
   *
   * The payload names its own canvas and base revision, so a pending edit is
   * written to the document it came from even when the picker already moved on.
   * A revision that turns out to be this panel's own earlier write is rebased and
   * retried once; any other mismatch is a real conflict and is reported.
   * @param attempt - 0 for the first try, 1 for the rebase retry.
   * @returns whether the document reached disk.
   */
  const flushOnce = useCallback(async (attempt) => {
    const payload = dirtyRef.current
    if (payload === null) return true
    dirtyRef.current = null
    setStatus('saving')
    try {
      // Saves are serialized, so this panel's own latest revision is the right
      // base for its current canvas; any other writer still shows up as a 409.
      const current = payload.key === latestRef.current.canvas
      const baseRev = current && revRef.current !== '' ? revRef.current : payload.rev
      const result = await canvasApi.save(payload.target, payload.scene, baseRev, sessionRef.current)
      if (current) {
        revRef.current = result.rev
        savedRef.current = fingerprint(payload.scene.elements, payload.scene.appState?.viewBackgroundColor)
        stampRef.current = sceneStamp(payload.scene.elements ?? [], payload.scene.appState?.viewBackgroundColor)
        setStatus(dirtyRef.current === null ? 'saved' : 'saving')
        setFailure(null)
      }
      return true
    } catch (error) {
      if (error.status === 409) {
        const currentRev = error.payload?.rev
        if (attempt === 0 && typeof currentRev === 'string' && currentRev === revRef.current) {
          // The file holds the revision this panel just wrote; rebase and retry.
          dirtyRef.current = { ...payload, rev: currentRev }
          return flushOnce(1)
        }
        if (current) {
          setConflict(error.payload ?? {})
          setStatus('conflict')
        }
        return false
      }
      dirtyRef.current = payload
      setStatus('error')
      setFailure(`${t('error.save')}: ${error.message}`)
      return false
    }
  }, [t])

  /**
   * Queue one save behind the previous one.
   * @returns whether the document reached disk.
   */
  const flush = useCallback(() => {
    const next = saveChainRef.current.then(() => flushOnce(0))
    saveChainRef.current = next.catch(() => {})
    return next
  }, [flushOnce])

  /**
   * Render the current selection to a PNG blob.
   *
   * `selectionElements` pulls in the labels and the connectors the selection
   * implies, so an ungrouped box keeps its text and its arrows.
   * `exportToBlob` crops to the elements it is given, so this is the selection
   * and nothing else; it honours the pixel multiplier only through
   * `getDimensions`, the same nuance the full export documents.
   * @param api - the Excalidraw imperative api.
   * @param multiplier - pixel scale, 2 for a crisp chat picture.
   * @returns the PNG blob.
   */
  async function renderSelection(api, multiplier) {
    const ids = new Set(Object.keys(api.getAppState()?.selectedElementIds ?? {}))
    const elements = selectionElements(api.getSceneElements(), ids)
    const known = api.getFiles?.() ?? {}
    const files = {}
    for (const element of elements) {
      if (element.type === 'image' && typeof element.fileId === 'string' && known[element.fileId] !== undefined) {
        files[element.fileId] = known[element.fileId]
      }
    }
    return exportToBlob({
      elements,
      appState: {
        ...api.getAppState(),
        exportBackground: true,
        exportWithDarkMode: false,
        exportScale: multiplier,
      },
      files,
      exportPadding: 16,
      getDimensions: (width, height) => ({
        width: Math.round(width * multiplier),
        height: Math.round(height * multiplier),
        scale: multiplier,
      }),
    })
  }

  /**
   * File extension for an accepted image mime type.
   * @param mimeType - the image's mime type.
   * @returns the extension without a dot.
   */
  function extensionOf(mimeType) {
    if (mimeType === 'image/jpeg') return 'jpg'
    if (mimeType === 'image/webp') return 'webp'
    if (mimeType === 'image/gif') return 'gif'
    return 'png'
  }

  /**
   * Original bytes for a selection made only of images.
   *
   * A picture on the canvas keeps its own bytes in `files[fileId].dataURL`, so a
   * selection of images alone can travel at its native resolution and format —
   * re-rasterizing it would soften it and cap it at the export multiplier. Any
   * other selection (text, shapes, a mix) has to be rendered.
   * @param api - the Excalidraw imperative api.
   * @returns one `File` per selected image, or null when the selection is not
   *   exclusively images.
   */
  async function originalFilesOf(api) {
    const ids = new Set(Object.keys(api.getAppState()?.selectedElementIds ?? {}))
    const picked = api.getSceneElements().filter(element => ids.has(element.id))
    if (picked.length === 0) return null
    if (!picked.every(element => element.type === 'image' && typeof element.fileId === 'string')) return null
    const known = api.getFiles?.() ?? {}
    const files = []
    for (const element of picked) {
      const entry = known[element.fileId]
      if (entry === undefined || typeof entry.dataURL !== 'string' || !String(entry.mimeType).startsWith('image/')) {
        return null
      }
      // A data URL that will not decode falls back to rendering rather than
      // failing the whole send.
      let blob
      try {
        blob = await (await fetch(entry.dataURL)).blob()
      } catch {
        return null
      }
      files.push(new File([blob], `excalidraw-image-${Date.now()}-${files.length}.${extensionOf(entry.mimeType)}`, { type: entry.mimeType }))
    }
    return files.length > 0 ? files : null
  }

  /**
   * Hand image files to the conversation composer exactly as a drop would.
   *
   * DSH's attachment layer listens for drops on `document` and reads
   * `dataTransfer.files`, so a synthetic drop is the supported public path —
   * there is no "insert into composer" service to call.
   * @param files - `File` objects to attach.
   * @returns whether a drop event was dispatched.
   */
  function dropIntoComposer(files) {
    try {
      const data = new DataTransfer()
      for (const file of files) data.items.add(file)
      const card = document.querySelector('[data-composer-card]')
      const target = card ?? document.body
      target.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: data }))
      return true
    } catch {
      return false
    }
  }

  /**
   * Watch the composer for a moment to see whether the drop landed.
   * @param timeoutMs - how long to watch.
   * @returns whether the composer grew any children.
   */
  function composerChanged(timeoutMs) {
    // The whole input area first: attachment chips may mount beside the card,
    // not inside it. Watching `body` would false-positive on streaming text.
    const area = document.querySelector('[data-composer-seat]')
      ?? document.querySelector('[data-composer-card]')
    if (area === null) return Promise.resolve(false)
    return new Promise(resolve => {
      let seen = false
      const observer = new MutationObserver(() => {
        seen = true
        observer.disconnect()
        resolve(true)
      })
      observer.observe(area, { childList: true, subtree: true })
      setTimeout(() => {
        observer.disconnect()
        resolve(seen)
      }, timeoutMs)
    })
  }

  /**
   * Put a PNG blob on the clipboard as a fallback when the composer is absent.
   * @param blob - the PNG.
   * @returns whether the copy succeeded.
   */
  async function copyImage(blob) {
    try {
      if (typeof ClipboardItem === 'undefined' || navigator.clipboard?.write === undefined) return false
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })])
      return true
    } catch {
      return false
    }
  }

/**
 * Everything that belongs to a selection, given the ids the user actually clicked.
 *
 * Two things are implied by a selection and are separate elements in the scene:
 * a container's label (a `text` element pointing back through `containerId`
 * and sharing the container's `groupIds`) and a connector whose two ends are
 * both selected. Selecting a grouped shape happens to include them because the
 * group selects every member, so without this a picture of two labelled boxes
 * comes out with the labels missing as soon as the group is dissolved.
 * @param all - every element on the canvas.
 * @param ids - the selected ids.
 * @returns the elements to render.
 */
function selectionElements(all, ids) {
  const wanted = new Set(ids)
  for (const element of all) {
    if (element.type === 'text' && element.containerId !== undefined && ids.has(element.containerId)) {
      wanted.add(element.id)
    }
  }
  for (const element of all) {
    if (element.type !== 'arrow' && element.type !== 'line') continue
    const from = element.startBinding?.elementId
    const to = element.endBinding?.elementId
    if (from !== undefined && to !== undefined && ids.has(from) && ids.has(to)) wanted.add(element.id)
  }
  return all.filter(element => !element.isDeleted && wanted.has(element.id))
}

  /**
   * The elements a save or a download should contain.
   *
   * Selecting two boxes and hitting save almost always means "these two", not
   * "the whole drawing"; with nothing selected the picture is the whole canvas.
   * Labels are separate elements bound to their container, so they come along
   * even though the user only selected the box.
   */
  function exportScope(honourSelection = true) {
    const api = apiRef.current
    if (api === null) return null
    const all = api.getSceneElements()
    const selected = honourSelection ? Object.keys(api.getAppState()?.selectedElementIds ?? {}) : []
    if (selected.length === 0) return { elements: all, scoped: false }
    const elements = selectionElements(all, new Set(selected))
    return elements.length > 0 ? { elements, scoped: true } : { elements: all, scoped: false }
  }

  /**
   * Render one exported image and hand it to the Host.
   *
   * Excalidraw renders at one CSS pixel per scene unit unless
   * `appState.exportScale` says otherwise, which is why a hand drawing exported
   * once looked soft next to the editor.
   * @param format - `png` or `svg`.
   * @param scale - pixel multiplier, 1 to 4.
   */
  const renderCanvasBlob = useCallback(async (format, scale = EXPORT_SCALE, honourSelection = true) => {
    const api = apiRef.current
    if (api === null) return null
    const multiplier = Math.min(4, Math.max(1, Math.round(scale)))
    const scope = exportScope(honourSelection)
    if (scope === null) return null
    const options = {
      elements: scope.elements,
      appState: {
        ...api.getAppState(),
        // No paint behind the drawing: a saved or downloaded PNG should carry
        // alpha so it can sit on any background without a white box around it.
        exportBackground: false,
        exportWithDarkMode: false,
        // SVG reads the scale from app state; PNG only honours it through
        // `getDimensions`, which is why a PNG exported here used to be 1x.
        exportScale: multiplier,
      },
      files: api.getFiles(),
      // Not a single unit of margin: the crop is the drawing itself.
      exportPadding: 0,
    }
    const blob = format === 'svg'
      ? new Blob([(await exportToSvg(options)).outerHTML], { type: 'image/svg+xml' })
      : await exportToBlob({
        ...options,
        mimeType: 'image/png',
        getDimensions: (width, height) => ({
          width: Math.round(width * multiplier),
          height: Math.round(height * multiplier),
          scale: multiplier,
        }),
      })
    return { blob, scoped: scope.scoped }
  }, [])

  /** Save the rendered picture beside the document, where the agent can read it. */
  const exportCanvas = useCallback(async (format, scale = EXPORT_SCALE, honourSelection = true) => {
    const rendered = await renderCanvasBlob(format, scale, honourSelection)
    if (rendered === null) return false
    await canvasApi.asset(latestRef.current.target, format, await base64Of(rendered.blob), sessionRef.current)
    return rendered.scoped
  }, [renderCanvasBlob, sessionId])

  /**
   * Hand the same bytes to the browser as a download.
   *
   * Saving beside the document keeps the picture next to its canvas, which is
   * what the agent needs; a download lands in the user's own Downloads folder,
   * which is what they need when they are about to paste it somewhere else.
   */
  const downloadCanvas = useCallback(async (format = 'png', scale = EXPORT_SCALE) => {
    const rendered = await renderCanvasBlob(format, scale)
    if (rendered === null) return false
    const blob = rendered.blob
    const label = targetLabel(latestRef.current.target) || 'canvas'
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = `${label}.${format}`
    document.body.appendChild(link)
    link.click()
    link.remove()
    // The browser needs the URL alive until the download starts.
    window.setTimeout(() => URL.revokeObjectURL(url), 10000)
    return rendered.scoped
  }, [renderCanvasBlob])

  /**
   * Send the selection to the conversation as an image.
   *
   * The picture is a rendered PNG rather than a path, so it lands in the
   * composer as an ordinary pending attachment: the user reviews it and sends
   * it with their own words, which is how they 'attach' anything else.
   */
  const sendSelection = useCallback(async (scale = 3) => {
    const api = apiRef.current
    if (api === null) return
    const selected = Object.keys(api.getAppState()?.selectedElementIds ?? {}).length
    if (selected === 0) {
      flash(t('send.none'), 'info')
      return
    }
    try {
      // A selection of images alone goes as the originals; everything else has
      // to be rasterized, and 3x keeps a diagram legible when zoomed.
      const originals = await originalFilesOf(api)
      const multiplier = Math.min(4, Math.max(1, Math.round(scale)))
      const payload = originals ?? [
        new File([await renderSelection(api, multiplier)], `excalidraw-selection-${Date.now()}.png`, { type: 'image/png' }),
      ]
      // Watch before dropping, or a fast composer update happens unobserved.
      const watched = composerChanged(900)
      const dropped = dropIntoComposer(payload)
      const landed = dropped && await watched
      const bytes = payload.reduce((sum, file) => sum + file.size, 0)
      if (landed) {
        flash(originals === null ? t('send.done') : t('send.original'))
      } else if (await copyImage(payload[0])) {
        flash(t('send.copied'), 'info')
      } else {
        setFailure(t('send.failed'))
      }
      reportToHost('send-selection', null, {
        selected,
        mode: originals === null ? 'rendered' : 'original',
        count: payload.length,
        scale: multiplier,
        bytes,
        dropped,
        landed,
      })
    } catch (error) {
      setFailure(`${t('send.failed')}: ${error.message}`)
    }
  }, [flash, t])

  /**
   * Apply the agent operations queued for this canvas.
   *
   * Every operation is accounted for: the batch reports what it changed, or the
   * first failure, so the waiting tool does not claim a drawing that never
   * reached the file.
   * @param entries - `{ id, op }` records from the Host.
   */
  const runOps = useCallback(async (entries) => {
    const api = apiRef.current
    const target = latestRef.current.target
    if (api === null || target === null || entries.length === 0) return
    const ids = []
    const detail = { changed: 0, matched: 0, removed: 0, added: 0, nodes: 0, arrows: 0, error: null }
    let elements = api.getSceneElementsIncludingDeleted()
    let changed = false
    const drawing = { text: t('agent.drawing'), kind: 'info' }
    // An in-flight indicator, not a result: it must go away however the batch
    // ends, because a batch that only exports (or throws) never reaches the
    // `flash` below, and a `setHint` without a timer stays on screen forever.
    setHint(drawing)
    for (const entry of entries) {
      ids.push(entry.id)
      const op = entry.op ?? {}
      try {
        if (op.kind === 'draw') {
          const live = elements.filter(element => !element.isDeleted)
          elements = op.mode === 'merge' ? mergeDiagram(live, op, latestRef.current.theme) : buildDiagram(op, latestRef.current.theme)
          detail.nodes += (op.nodes ?? []).length
          detail.arrows += (op.edges ?? []).length
          changed = true
        } else if (op.kind === 'edit') {
          const live = elements.filter(element => !element.isDeleted)
          const result = applyEdit(live, op, latestRef.current.theme)
          elements = result.elements
          detail.changed += result.detail.changed
          detail.matched += result.detail.matched
          detail.removed += result.detail.removed
          detail.added += result.detail.added
          if (typeof result.detail.rerouted === 'number') {
            detail.rerouted = (detail.rerouted ?? 0) + result.detail.rerouted
          }
          changed = true
        } else if (op.kind === 'images') {
          const files = Array.isArray(op.files) ? op.files : []
          const placements = Array.isArray(op.placements) ? op.placements : []
          // The bytes have to be in the editor before the element that points at
          // them, or the image renders as a placeholder until the next reload.
          if (files.length > 0) api.addFiles(files)
          if (placements.length > 0) {
            const added = imageElements(placements)
            elements = [...elements, ...added]
            detail.added += added.length
            changed = true
          }
        } else if (op.kind === 'clear') {
          elements = []
          changed = true
        } else if (op.kind === 'export') {
          // The agent asked for the canvas, not for whatever happens to be selected.
          await exportCanvas(op.format === 'svg' ? 'svg' : 'png', op.scale, false)
        }
      } catch (error) {
        detail.error = String(error?.message ?? error)
        setFailure(`${t('error.ops')}: ${detail.error}`)
      }
    }
    let settled = false
    try {
      let saved = true
      if (changed) {
        // A latched suppression would silently stop saving every later manual
        // edit, so the flag is released even when the update throws.
        suppressRef.current = true
        try {
          api.updateScene({ elements, captureUpdate: CaptureUpdateAction.IMMEDIATELY })
          await new Promise(requestAnimationFrame)
        } finally {
          suppressRef.current = false
        }
        dirtyRef.current = { key: latestRef.current.canvas, target, scene: sceneOf(api), rev: revRef.current }
        saved = await flush()
        if (detail.error === null) {
          api.scrollToContent(undefined, { fitToContent: true, animate: true })
          flash(t('agent.applied'))
          settled = true
        }
      }
      try {
        await canvasApi.ack(target, ids, detail.error === null && saved, [], sessionRef.current, detail)
      } catch {
        // An unacknowledged operation is retried by the Host on the next poll.
      }
    } finally {
      // Whatever happened, the toolbar stops claiming the agent is drawing. A
      // `flash` above already owns the hint then, so only this one is dropped.
      if (!settled) {
        setHint(previous => (previous?.text === drawing.text ? null : previous))
      }
      reportToHost('ops-settled', null, { changed, settled, error: detail.error !== null })
    }
  }, [exportCanvas, flash, flush, t])

  // Keep the polling loop stable while always running the newest handlers.
  latestRef.current = { canvas, target, theme, runOps, flush, t }

  // Ask for agent operations while this canvas is on screen.
  useEffect(() => {
    if (phase !== 'ready' || target === null) return undefined
    let cancelled = false
    let running = false
    const tick = async () => {
      if (cancelled || running) return
      running = true
      try {
        const payload = await canvasApi.ops(target, sessionRef.current)
        if (!cancelled && Array.isArray(payload.ops) && payload.ops.length > 0) {
          await latestRef.current.runOps(payload.ops)
        }
      } catch {
        // Transient network or Host restarts are retried on the next tick.
      } finally {
        running = false
      }
    }
    const timer = setInterval(tick, OPS_INTERVAL_MS)
    void tick()
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [target, phase])

  // Clear pending timers on unmount.
  useEffect(() => () => {
    if (timerRef.current !== null) clearTimeout(timerRef.current)
    if (hintTimerRef.current !== null) clearTimeout(hintTimerRef.current)
  }, [])

  /** Accept an editor change and schedule a save. */
  // Render cadence: a panel that re-renders on a timer looks like a UI glitch
  // (the Excalidraw toolbar restyles itself) but leaves the scene file untouched,
  // so the count is reported, throttled, and read back from /api/state.
  const renderCountRef = useRef(0)
  const renderedAtRef = useRef(0)
  renderCountRef.current += 1
  useEffect(() => {
    const now = Date.now()
    if (now - renderedAtRef.current < 1500) return
    const gap = renderedAtRef.current === 0 ? 0 : now - renderedAtRef.current
    renderedAtRef.current = now
    reportToHost('panel-render', null, { renders: renderCountRef.current, gap })
  })

  /** Stable API handle: a new function per render re-mounts Excalidraw's UI. */
  const onApi = useCallback((instance) => {
    apiRef.current = instance
  }, [])

  const onChange = useCallback((elements, appState) => {
    if (suppressRef.current) return
    // A pointer move fires this dozens of times a second; the change stamp is
    // O(elements) with no string building, so a drag stays cheap on a stroked
    // canvas, while the exact fingerprint is only built when a save is due.
    const stamp = sceneStamp(elements, appState?.viewBackgroundColor)
    if (stamp === stampRef.current) return
    stampRef.current = stamp
    const api = apiRef.current
    if (api === null) return
    dirtyRef.current = { key: latestRef.current.canvas, target: latestRef.current.target, scene: sceneOf(api), rev: revRef.current }
    setStatus('saving')
    if (timerRef.current !== null) clearTimeout(timerRef.current)
    timerRef.current = setTimeout(() => {
      timerRef.current = null
      void flush()
    }, SAVE_DELAY_MS)
  }, [flush])

  /** Create a canvas document and show it. */
  const createCanvas = useCallback(async (name) => {
    const clean = name.trim().replace(/\.excalidraw$/i, '')
    if (clean === '') return
    if ([...clean].length > 64 || /[\\/:*?"<>|]/.test(clean) || clean.startsWith('.')) {
      setFailure(t('prompt.invalid'))
      return
    }
    if (inventory.canvases.some(entry => entry.name === clean)) {
      setFailure(t('prompt.exists'))
      return
    }
    try {
      await canvasApi.save({ name: clean }, { type: 'excalidraw', version: 2, source: 'dsh-excalidraw-canvas', elements: [], files: {} }, '0:0', sessionRef.current, true)
      setCreating(false)
      setDraftName('')
      setFailure(null)
      setTarget({ name: clean })
      await refreshInventory()
    } catch (error) {
      setFailure(`${t('error.save')}: ${error.message}`)
    }
  }, [inventory.canvases, refreshInventory, t])

  /** Overwrite the disk version with this canvas after a conflict. */
  const keepMyCanvas = useCallback(() => {
    const api = apiRef.current
    setConflict(null)
    if (api === null) return
    revRef.current = conflict?.rev ?? revRef.current
    dirtyRef.current = { key: latestRef.current.canvas, target: latestRef.current.target, scene: sceneOf(api), rev: revRef.current }
    setFailure(null)
    void flush()
  }, [conflict, flush])

  /** Reload from disk after a conflict or an external change. */
  const reloadFromDisk = useCallback(async () => {
    setConflict(null)
    await load(latestRef.current.target)
    const payload = await canvasApi.scene(latestRef.current.target, sessionRef.current)
    const api = apiRef.current
    if (api !== null && payload.scene !== null) {
      suppressRef.current = true
      try {
        api.updateScene({ elements: payload.scene.elements ?? [], captureUpdate: CaptureUpdateAction.IMMEDIATELY })
        await new Promise(requestAnimationFrame)
      } finally {
        suppressRef.current = false
      }
      api.scrollToContent(undefined, { fitToContent: true, animate: true })
    }
  }, [load, sessionId])

  const initialData = useMemo(() => {
    if (scene === null) return null
    return {
      elements: scene.elements ?? [],
      appState: {
        ...(scene.appState ?? {}),
        // A document that carries a background keeps it; a new one follows the theme.
        viewBackgroundColor: typeof scene.appState?.viewBackgroundColor === 'string'
          ? scene.appState.viewBackgroundColor
          : (theme ? '#121212' : '#ffffff'),
        gridSize: null,
      },
      files: scene.files ?? {},
      scrollToContent: true,
    }
    // Recreating this object on every render would reset the editor.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scene])

  // The picker lists the canvas folder; a document opened from a file link is
  // added as its own entry so the strip still names what is on screen.
  const currentKey = targetKey(target)
  const currentLabel = targetLabel(target)
  const listed = inventory.canvases
  const options = listed.some(entry => entry.name === currentLabel) || target === null
    ? listed
    : [{ name: currentLabel, path: target.path }, ...listed]
  const selectedKey = (() => {
    const match = options.find(entry => entry.name === currentLabel)
    return match === undefined ? '' : targetKey({ path: match.path, name: match.name })
  })()

  const showCanvas = phase === 'ready' && scene !== null

  return (
    <div
      className={maximised ? 'dxc-root dxc-root--maximised' : 'dxc-root'}
      ref={panelRootRef}
    >
      <div className="dxc-toolbar">
        <CanvasIcon size={15} />
        <select
          className="dxc-select"
          aria-label={t('toolbar.canvas')}
          value={selectedKey}
          onChange={(event) => {
            const next = options.find(entry => targetKey({ path: entry.path, name: entry.name }) === event.target.value)
            if (next !== undefined) setTarget(next.path !== undefined ? { path: next.path } : { name: next.name })
          }}
          disabled={options.length === 0}
        >
          {options.map(entry => {
            const value = targetKey({ path: entry.path, name: entry.name })
            return <option key={value} value={value}>{entry.name}</option>
          })}
          {options.length === 0 && <option value="">—</option>}
        </select>
        {creating
          ? (
            <CreateForm
              t={t}
              value={draftName}
              onChange={setDraftName}
              onSubmit={() => void createCanvas(draftName)}
              onCancel={() => { setCreating(false); setFailure(null) }}
            />
          )
          : (
            <button
              type="button"
              className="dxc-icon-button"
              title={t('toolbar.new')}
              aria-label={t('toolbar.new')}
              onClick={() => {
                setDraftName(suggestName(inventory.canvases))
                setFailure(null)
                setCreating(true)
              }}
            >
              <PlusIcon size={15} />
            </button>
          )}
        <button
          type="button"
          className="dxc-icon-button"
          title={t('toolbar.reload')}
          aria-label={t('toolbar.reload')}
          onClick={() => void load(canvas)}
          disabled={target === null}
        >
          <ReloadIcon size={15} />
        </button>
        <button
          type="button"
          className="dxc-icon-button"
          title={t('toolbar.fit')}
          aria-label={t('toolbar.fit')}
          onClick={() => apiRef.current?.scrollToContent(undefined, { fitToContent: true, animate: true })}
          disabled={!showCanvas}
        >
          <FitIcon size={15} />
        </button>
        {fullscreenActive || maximised
          ? (
            // The toolbar stays visible in fullscreen, so the way out sits in the
            // same row the way in did - as a word, not a glyph to be guessed.
            <button
              type="button"
              className="dxc-button dxc-exit-fullscreen"
              title={t('toolbar.fullscreenExit')}
              onClick={() => {
                if (maximised) {
                  setMaximised(false)
                  return
                }
                void toggleElementFullscreen(null, null)
              }}
            >
              {t('toolbar.exitFullscreen')}
            </button>
          )
          : (
            <button
              type="button"
              className="dxc-icon-button"
              title={t('toolbar.fullscreen')}
              aria-label={t('toolbar.fullscreen')}
              onClick={() => {
                void (async () => {
                  // The whole panel goes fullscreen, not just the drawing surface,
                  // so the toolbar stays reachable inside the fullscreen element.
                  const entered = await toggleElementFullscreen(panelRootRef.current, onToggleFullscreen)
                  // A desktop shell can refuse element fullscreen; the overlay still
                  // gives the drawing the whole window, which is what was asked for.
                  if (!entered) setMaximised(true)
                })()
              }}
              disabled={!showCanvas}
            >
              <MaximizeIcon size={15} />
            </button>
          )}
        <button
          type="button"
          className="dxc-icon-button"
          title={t('toolbar.export')}
          aria-label={t('toolbar.export')}
          onClick={() => {
            void exportCanvas('png').then(
              scoped => flash(t(scoped ? 'export.doneSelection' : 'export.done')),
              error => setFailure(`${t('error.export')}: ${error.message}`),
            )
          }}
          disabled={!showCanvas}
        >
          <ImageIcon size={15} />
        </button>
        <button
          type="button"
          className="dxc-icon-button"
          title={t('toolbar.download')}
          aria-label={t('toolbar.download')}
          onClick={() => {
            void downloadCanvas('png').then(
              scoped => flash(t(scoped ? 'export.downloadedSelection' : 'export.downloaded')),
              error => setFailure(`${t('error.export')}: ${error.message}`),
            )
          }}
          disabled={!showCanvas}
        >
          <DownloadIcon size={15} />
        </button>
        <button
          type="button"
          className="dxc-icon-button"
          title={t('toolbar.send')}
          aria-label={t('toolbar.send')}
          onClick={event => void sendSelection(event.shiftKey ? 4 : 3)}
          disabled={!showCanvas}
        >
          <SendIcon size={15} />
        </button>
        <span className={`dxc-status dxc-status-${status}`} role="status" aria-live="polite">
          {hint?.text ?? failure ?? t(`status.${status}`)}
        </span>
      </div>

      {failure !== null && (
        <div className="dxc-banner dxc-banner-error">
          <div className="dxc-banner-text">
            <span>{failure}</span>
          </div>
          <button type="button" className="dxc-button dxc-quiet" onClick={() => setFailure(null)}>{t('prompt.dismiss')}</button>
        </div>
      )}

      {conflict !== null && (
        <div className="dxc-banner">
          <div className="dxc-banner-text">
            <strong>{t('conflict.title')}</strong>
            <span>{t('conflict.body')}</span>
          </div>
          <button type="button" className="dxc-button" onClick={() => void reloadFromDisk()}>{t('conflict.reload')}</button>
          <button type="button" className="dxc-button dxc-quiet" onClick={keepMyCanvas}>{t('conflict.keep')}</button>
        </div>
      )}

      {showCanvas && (
        <div className="dxc-canvas">
          <Excalidraw
            key={currentKey}
            excalidrawAPI={onApi}
            initialData={initialData}
            theme={theme ? 'dark' : 'light'}
            langCode={lang}
            onChange={onChange}
            UIOptions={UI_OPTIONS}
          />
          <CanvasMinimap apiRef={apiRef} />
        </div>
      )}

      {phase === 'empty' && (
        <div className="dxc-empty">
          <CanvasIcon size={28} />
          <strong>{t('empty.title')}</strong>
          <span>{t('empty.body')}</span>
          {creating
            ? (
              <CreateForm
                t={t}
                value={draftName}
                onChange={setDraftName}
                onSubmit={() => void createCanvas(draftName)}
                onCancel={() => { setCreating(false); setFailure(null) }}
                inline
              />
            )
            : (
              <button
                type="button"
                className="dxc-button dxc-primary"
                onClick={() => { setDraftName(suggestName(inventory.canvases)); setFailure(null); setCreating(true) }}
              >
                {t('empty.create')}
              </button>
            )}
        </div>
      )}

      {phase === 'loading' && <div className="dxc-empty"><span>{t('status.loading')}</span></div>}

      {phase === 'error' && (
        <div className="dxc-empty">
          <strong>{t('error.load')}</strong>
          <span>{failure}</span>
          <button type="button" className="dxc-button" onClick={() => void load(canvas)}>{t('toolbar.reload')}</button>
        </div>
      )}
    </div>
  )
}
