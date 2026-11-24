/**
 * Client half of `dsh-excalidraw-canvas`: contributes the canvas tab type to the right
 * sidebar, the panel body that renders it, and the background watcher that opens
 * the panel when the agent draws on a canvas.
 *
 * @module dsh-excalidraw-canvas/client
 */
import excalidrawCss from '@excalidraw/excalidraw/index.css'
import { useEffect, useState } from 'react'
import { canvasApi } from './api.js'
import { CanvasIcon } from './icons.jsx'
import { PANEL_CSS } from './styles.js'
import { Panel } from './panel.jsx'
import { createTranslate, registerLocale } from './locale.js'
import { reportToHost } from './report.js'

/**
 * Services this plugin needs on its own context. `slots` must be declared here:
 * inside an `ctx.inject(...)` callback only injected services are reachable, and
 * a slot registration touches `slots` from there.
 */
export const inject = ['slots']

/** Tab-type identity: the key the body, title, and guide card register under. */
const PANEL_ID = 'dsh-excalidraw-canvas/panel'
/** Page kind the sidebar dispatches for this tab type. */
export const PANEL_KIND = 'excalidraw'
/** How often the background watcher asks for agent open requests. */
const OPEN_INTERVAL_MS = 3000

/** Addresses already handed from the file viewer to the canvas tab. */
const handedOver = new Set()

/**
 * Insert one stylesheet, removing it when the plugin unloads.
 * @param css - stylesheet text.
 * @returns the cleanup function.
 */
function insertStyles(css) {
  const element = document.createElement('style')
  element.dataset.dshExcalidraw = ''
  element.textContent = css
  document.head.appendChild(element)
  return () => element.remove()
}

/**
 * Component-encode one id or path segment, keeping `:` literal.
 *
 * Mirrors the sidebar's own encoder so an address built here is byte-identical
 * to the one a conversation file link produces: the two then dedupe onto the
 * same tab instead of opening a second one.
 * @param segment - raw segment.
 * @returns the encoded segment.
 */
function encodeSegment(segment) {
  return encodeURIComponent(segment).replace(/%3A/gi, ':')
}

/**
 * Build the `dsh-resource://file/...` address of a document.
 *
 * A path inside the session's workspace is spelled relative to it, as the
 * sidebar does, so both entry points name the same resource.
 * @param sessionId - the session whose workspace resolves the path.
 * @param cwd - that session's workspace root, when known.
 * @param path - absolute or workspace-relative path.
 * @returns the address.
 */
function fileAddressFor(sessionId, cwd, path) {
  const normalized = String(path).replace(/\\/g, '/').replace(/^(?:\.\/)+/, '')
  const absolute = normalized.startsWith('/') || /^[A-Za-z]:[/\\]/.test(normalized) || normalized.startsWith('\\\\')
  const root = typeof cwd === 'string' && cwd !== '' ? cwd.replace(/\\/g, '/').replace(/\/+$/, '') : ''
  let relative = normalized
  if (absolute && root !== '' && normalized === root) relative = ''
  else if (absolute && root !== '' && normalized.startsWith(`${root}/`)) relative = normalized.slice(root.length + 1)
  const encoded = relative.split('/').map(encodeSegment).join('/')
  return `dsh-resource://file/session/${encodeSegment(sessionId)}/${encoded}`
}

/**
 * The active application language, for Excalidraw's own UI copy.
 * @param locale - the Client locale service, when present.
 * @returns a language code such as `zh-CN`.
 */
function activeLanguage(locale) {
  try {
    const snapshot = locale?.getSnapshot?.() ?? locale?.getLocale?.() ?? {}
    const active = snapshot?.active ?? snapshot?.preference ?? 'en'
    return String(active).startsWith('zh') ? 'zh-CN' : String(active).startsWith('ja') ? 'ja-JP' : 'en'
  } catch {
    return 'en'
  }
}

/**
 * Register the canvas type, its body, and the open-request watcher.
 * @param ctx - Client plugin context.
 */
export function apply(ctx) {
  try {
    applyPlugin(ctx)
    reportToHost('applied')
  } catch (error) {
    reportToHost('apply-failed', error)
    throw error
  }
}

/**
 * Register everything this browser half contributes.
 * @param ctx - Client plugin context.
 */
function applyPlugin(ctx) {
  ctx.effect(() => insertStyles(`${excalidrawCss}\n${PANEL_CSS}`), 'dsh-excalidraw-canvas: styles')

  const locale = ctx.get('locale')
  const t = createTranslate(locale)
  ctx.effect(() => {
    const disposers = registerLocale(locale)
    return () => {
      for (const dispose of disposers) {
        try {
          dispose()
        } catch {
          // A locale service already torn down needs no cleanup.
        }
      }
    }
  }, 'dsh-excalidraw-canvas: copy')

  ctx.inject(['sidebarRightTabs'], (owner) => {
    try {
      const tabs = owner.get('sidebarRightTabs')
      if (tabs === undefined) return

      // Claiming the extension is what puts a clicked `.excalidraw` file in
      // this panel: a Conversation link and a Files-tree row both open by
      // resource address, and the registry picks the type whose pattern ranks
      // highest. The glob is matched against the whole address when it carries
      // a `:`, and against the address's URL path (basename mode) when it does
      // not — a bare basename pattern is not enough, hence both forms.
      let disposeTabType = () => {}
      try {
        disposeTabType = tabs.register({
          id: PANEL_ID,
          kind: PANEL_KIND,
          priority: 'extension',
          keepMounted: true,
          patterns: ['dsh-resource://file/**/*.excalidraw', '*.excalidraw'],
          title: address => {
            const file = String(address ?? '').split('/').pop() ?? ''
            const name = file.replace(/\.excalidraw$/i, '')
            return name === '' ? t('panel.title') : name
          },
          guide: [{
            id: 'canvas',
            order: 120,
            title: () => t('panel.title'),
            description: () => t('guide.description'),
            icon: CanvasIcon,
          }],
        })
      } catch (error) {
        reportToHost('tab-type-failed', error, { id: PANEL_ID, kind: PANEL_KIND })
        return
      }
      // The registry keeps its own reactive bookkeeping; this ties the disposer
      // to THIS plugin's fiber, so disabling the plugin drops the type.
      ctx.effect(() => disposeTabType, 'dsh-excalidraw-canvas: canvas tab type')

      reportToHost('tab-type-registered', null, {
        mine: typeof tabs.get === 'function' && tabs.get(PANEL_KIND) !== undefined ? 'yes' : 'no',
      })

      const slots = ctx.slots
      const register = slots.register.bind(slots)
      slots.inject('sidebar.right.pane.tab', () => {
        reportToHost('slot-callback-ran')
        return register({
          name: 'sidebar.right.pane.tab',
          key: PANEL_ID,
          // The framework binds this tab to a session; the panel needs it to
          // resolve the same workspace directory the session's tools write to.
          inject: sessionId => ({
            t,
            lang: activeLanguage(locale),
            sessionId,
            onToggleFullscreen: toggleFullscreen,
          }),
        }, Panel)
      })
      reportToHost('body-registration-requested')
    } catch (error) {
      reportToHost('tabs-block-failed', error)
    }
  })

  // Better Sidebar replaces the native right column with its own tab bar and
  // resolves every file click through its file-viewer registry, keyed by
  // extension. Registering the extension is what makes a `.excalidraw` file in
  // the conversation or in the Files tree open the canvas editor instead of a
  // text preview. Absent, the native tab type above keeps working.
  /**
   * The body of the file-viewer entry for `.excalidraw` files.
   *
   * The canvas tab type claims every such address already, so this body exists
   * for the tabs that predate that claim: it forwards the file to the canvas tab
   * and shows a signpost instead of a second Excalidraw. Two live editors on one
   * document would each save it, and whichever saved last would win.
   * @param props - the file viewer's props (`path`, `sessionId`, `t`, `lang`).
   * @returns the signpost, or the panel when no canvas tab can be reached.
   */
  const FileViewerBody = (props) => {
    const [mode, setMode] = useState('pending')
    const [address, setAddress] = useState(null)

    const openInCanvas = () => {
      if (address === null) return
      try {
        ctx.get('sidebarRight')?.openResource?.(address)
      } catch (error) {
        reportToHost('viewer-handoff-failed', error, { path: props.path })
      }
    }

    useEffect(() => {
      let cancelled = false
      let built = null
      try {
        if (typeof props.sessionId === 'string' && props.sessionId !== '') {
          built = fileAddressFor(props.sessionId, props.cwd, props.path)
        }
      } catch {
        built = null
      }
      const reachable = built !== null && typeof ctx.get('sidebarRight')?.openResource === 'function'
      if (!reachable) {
        if (!cancelled) setMode('local')
        return () => { cancelled = true }
      }
      if (!cancelled) {
        setAddress(built)
        setMode('handoff')
      }
      // Hand over once: a tab switch back to this one must not steal focus again.
      if (!handedOver.has(built)) {
        handedOver.add(built)
        try {
          ctx.get('sidebarRight').openResource(built)
          reportToHost('viewer-handed-over', null, { path: props.path })
        } catch (error) {
          reportToHost('viewer-handoff-failed', error, { path: props.path })
        }
      }
      return () => { cancelled = true }
    }, [props.path, props.sessionId, props.cwd])

    if (mode === 'local') {
      return (
        <Panel
          path={props.path}
          sessionId={props.sessionId}
          t={props.t}
          lang={props.lang}
          onToggleFullscreen={toggleFullscreen}
        />
      )
    }
    if (mode === 'handoff') {
      return (
        <div className="dxc-handoff">
          <CanvasIcon size={28} />
          <span>{props.t('viewer.handoff')}</span>
          <button type="button" className="dxc-button" onClick={openInCanvas}>
            {props.t('viewer.reopen')}
          </button>
        </div>
      )
    }
    return null
  }

  /**
   * Toggle the slideshow-style fullscreen of the pane holding this canvas.
   *
   * The right column already knows how to take over the window; the panel only
   * needs a button that asks it, so nothing here fakes an overlay with CSS. The
   * pane-level toggle is preferred because it flips back; without it, the
   * layout's right-bar presentation is the fallback and is tracked locally.
   * @returns whether a fullscreen surface was found.
   */
  const fullscreenRef = { current: false }
  const toggleFullscreen = () => {
    try {
      const sidebar = ctx.get('sidebarRight')
      const target = sidebar?.commandTarget?.()
      if (target !== undefined && typeof sidebar.toggleFullscreen === 'function') {
        sidebar.toggleFullscreen(target)
        reportToHost('fullscreen-toggle', null, { via: 'pane' })
        return true
      }
    } catch (error) {
      reportToHost('fullscreen-failed', error, { via: 'pane' })
    }
    try {
      const layout = ctx.get('layout')
      if (typeof layout?.openRightbar === 'function') {
        fullscreenRef.current = !fullscreenRef.current
        layout.openRightbar(true, fullscreenRef.current)
        reportToHost('fullscreen-toggle', null, { via: 'layout', fullscreen: fullscreenRef.current })
        return true
      }
    } catch (error) {
      reportToHost('fullscreen-failed', error, { via: 'layout' })
    }
    return false
  }

  ctx.inject(['betterSidebar'], (owner) => {
    try {
      const better = owner.get('betterSidebar')
      reportToHost('better-sidebar-inject', null, { service: typeof better })
      if (better === undefined) return
      ctx.effect(() => better.registerFileViewer({
        id: `${PANEL_ID}:file`,
        title: () => t('panel.title'),
        icon: size => <CanvasIcon size={size} />,
        exts: ['excalidraw'],
        priority: 100,
        // The viewer reads the document through this plugin's own routes, so
        // the host has no bytes to fetch for it.
        fetchStrategy: 'none',
        // One document, one editor. The canvas tab above already claims every
        // `.excalidraw` address, so this viewer is reached only by a tab that
        // predates that claim; mounting a second editor there would let two
        // panels save the same file from underneath each other, so the body
        // hands the file to the canvas tab and stays a signpost.
        component: props => (
          <FileViewerBody
            path={props.path}
            sessionId={props.scope?.sessionId}
            cwd={props.scope?.repoRoot ?? props.scope?.cwd}
            t={t}
            lang={activeLanguage(locale)}
          />
        ),
      }), 'dsh-excalidraw-canvas: canvas file viewer')
      reportToHost('file-viewer-registered', null, {
        viewers: (better.getFileViewers?.() ?? [])
          .map(viewer => `${viewer.id}:${(viewer.exts ?? []).join('/')}@${viewer.priority ?? 0}`)
          .join(' '),
      })
    } catch (error) {
      reportToHost('viewer-block-failed', error)
    }
  })

  // The agent cannot push, so the panel is opened from a poll it can observe.
  ctx.inject(['sidebarRight'], (owner) => {
    const sidebar = owner.get('sidebarRight')
    reportToHost('sidebar-inject', null, { sidebar: typeof sidebar })
    // The pane's fullscreen toggle is what the canvas toolbar's button drives; a
    // stripped-down host may expose only the layout face, so the two candidates
    // are reported once instead of failing silently on the first click.
    reportToHost('fullscreen-capability', null, {
      paneTarget: typeof sidebar?.commandTarget,
      paneToggle: typeof sidebar?.toggleFullscreen,
      layout: typeof ctx.get('layout')?.openRightbar,
    })
    if (sidebar === undefined) return
    const handled = new Set()
    owner.effect(() => {
      let cancelled = false
      let running = false
      const timer = setInterval(async () => {
        if (cancelled || running) return
        running = true
        try {
          const payload = await canvasApi.state()
          const requests = Array.isArray(payload.open) ? payload.open : []
          const fresh = requests.filter(request => !handled.has(request.id))
          if (fresh.length > 0) {
            const latest = fresh[fresh.length - 1]
            try {
              // Opening by address keeps this tab and a file-link tab the same
              // tab: the sidebar keys a tab by its content address, so naming the
              // canvas instead would mount a second editor on one document.
              if (typeof latest.address === 'string' && latest.address !== '') {
                sidebar.openResource(latest.address)
                reportToHost('open-ok', null, { name: latest.name, via: 'address', address: latest.address })
              } else {
                sidebar.openTab(PANEL_KIND, { params: { name: latest.name, session: latest.session ?? null } })
                reportToHost('open-ok', null, { name: latest.name, via: 'name' })
              }
            } catch (error) {
              reportToHost('open-failed', error, { name: latest.name })
            }
            // Acknowledged either way: a request that opened its tab is done, and
            // one this page cannot open must not be retried on every tick.
            for (const request of fresh) handled.add(request.id)
            await canvasApi.ack(
              { name: latest.name },
              [],
              true,
              fresh.map(request => request.id),
              latest.session ?? undefined,
            )
          }
        } catch {
          // A closed Host or a restarting page simply retries next tick.
        } finally {
          running = false
        }
      }, OPEN_INTERVAL_MS)
      return () => {
        cancelled = true
        clearInterval(timer)
      }
    }, 'dsh-excalidraw-canvas: open-request watcher')
  })
}
