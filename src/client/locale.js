/**
 * Copy for the canvas panel, registered in the Client locale service so the
 * panel follows the application language.
 *
 * @module dsh-excalidraw-canvas/client/locale
 */

/** Namespace registered with the Client locale service. */
export const NAMESPACE = 'excalidraw'

/** Simplified Chinese copy. */
const ZH = {
  'panel.title': 'Excalidraw 画布',
  'guide.description': '在右侧面板里画流程图，和 Agent 一起改',
  'toolbar.canvas': '画布',
  'toolbar.new': '新建',
  'toolbar.reload': '重新载入',
  'toolbar.fit': '适应内容',
  'toolbar.fullscreen': '全屏（画布独占屏幕）',
  'toolbar.fullscreenExit': '退出全屏（Esc）',
  'toolbar.exitFullscreen': '退出全屏',
  'toolbar.fullscreenFailed': '这个环境没有可用的全屏面板',
  'toolbar.export': '保存 PNG（2×）· 有选中就只保存选中',
  'toolbar.download': '下载 PNG（2×）· 有选中就只下载选中',
  'toolbar.send': '把选区发到对话框',
  'send.none': '先在画布上选中要发送的元素',
  'send.original': '已投递原图（保持原始分辨率）',
  'send.done': '选区已放进对话框',
  'send.copied': '没投进对话框，已复制为图片，可直接粘贴',
  'send.failed': '发送选区失败',
  'export.done': '已保存 PNG 到画布旁边（2×）',
  'export.doneSelection': '已保存选中元素 PNG（2×）',
  'export.downloaded': '已开始下载 PNG（2×）',
  'export.downloadedSelection': '已开始下载选中元素 PNG（2×）',
  'status.saved': '已保存',
  'status.saving': '保存中…',
  'status.loading': '载入中…',
  'status.error': '出错',
  'status.conflict': '文件已在别处被修改',
  'agent.applied': 'Agent 更新了画布',
  'agent.drawing': 'Agent 正在绘制…',
  'conflict.title': '磁盘上的文件已改变',
  'conflict.body': '保存会覆盖别人的修改。先载入最新版本，或继续保留当前画布。',
  'conflict.reload': '载入磁盘版本',
  'conflict.keep': '保留我的画布',
  'empty.title': '还没有画布',
  'empty.body': '让 Agent 画一张，或者现在新建一张空白画布。',
  'empty.create': '新建画布',
  'viewer.handoff': '这个文件在画布标签里打开，这里不再重复加载它。',
  'viewer.reopen': '切到画布标签',
  'prompt.name': '新画布的名称',
  'prompt.ok': '创建',
  'prompt.cancel': '取消',
  'prompt.dismiss': '知道了',
  'prompt.invalid': '画布名称只能包含字母、数字、空格和 . _ -',
  'prompt.exists': '同名画布已经存在',
  'error.load': '无法载入画布',
  'error.save': '无法保存画布',
  'error.ops': '应用 Agent 的改动失败',
  'error.export': '导出失败',
}

/** English copy. */
const EN = {
  'panel.title': 'Excalidraw canvas',
  'guide.description': 'Draw diagrams in the right panel, together with the agent',
  'toolbar.canvas': 'Canvas',
  'toolbar.new': 'New',
  'toolbar.reload': 'Reload',
  'toolbar.fit': 'Fit',
  'toolbar.export': 'Save PNG (2x) - only the selection if anything is selected',
  'toolbar.download': 'Download PNG (2x) - only the selection if anything is selected',
  'toolbar.send': 'Send selection to the conversation',
  'send.none': 'Select the elements to send first',
  'send.original': 'Original image sent at its own resolution',
  'send.done': 'Selection added to the conversation',
  'send.copied': 'Could not reach the composer, so the selection is on the clipboard',
  'send.failed': 'Could not send the selection',
  'export.done': 'Saved PNG beside the canvas (2x)',
  'export.doneSelection': 'Saved the selected elements as PNG (2x)',
  'export.downloaded': 'Downloading PNG (2x)',
  'export.downloadedSelection': 'Downloading the selected elements as PNG (2x)',
  'status.saved': 'Saved',
  'status.saving': 'Saving…',
  'status.loading': 'Loading…',
  'status.error': 'Error',
  'status.conflict': 'The file changed on disk',
  'agent.applied': 'The agent updated the canvas',
  'agent.drawing': 'The agent is drawing…',
  'conflict.title': 'The file changed on disk',
  'conflict.body': 'Saving now would overwrite that change. Load the disk version, or keep this canvas.',
  'conflict.reload': 'Load disk version',
  'conflict.keep': 'Keep my canvas',
  'empty.title': 'No canvas yet',
  'empty.body': 'Ask the agent to draw one, or create an empty canvas now.',
  'empty.create': 'New canvas',
  'viewer.handoff': 'This file is open in the canvas tab, so it is not loaded twice.',
  'viewer.reopen': 'Go to the canvas tab',
  'prompt.name': 'Name for the new canvas',
  'prompt.ok': 'Create',
  'prompt.cancel': 'Cancel',
  'prompt.dismiss': 'Dismiss',
  'prompt.invalid': 'Use letters, digits, spaces and . _ - in a canvas name',
  'prompt.exists': 'A canvas with that name already exists',
  'error.load': 'Could not load the canvas',
  'error.save': 'Could not save the canvas',
  'error.ops': 'Applying the agent change failed',
  'error.export': 'Export failed',
}

/** Every dictionary by locale id. */
export const DICTIONARIES = { zh: ZH, en: EN }

/**
 * The dictionary for one active locale.
 * @param active - locale id such as `zh` or `en`.
 * @returns its dictionary, falling back to English.
 */
export function dictionaryFor(active) {
  const id = String(active ?? '')
  if (id.startsWith('zh') && /(tw|hk|mo|hant)/i.test(id)) return ZH
  return DICTIONARIES[id.slice(0, 2)] ?? EN
}

/**
 * Register the copy with the locale service.
 * @param locale - the Client locale service, when present.
 * @returns disposers for the registrations.
 */
export function registerLocale(locale) {
  const disposers = []
  if (locale === undefined || typeof locale.register !== 'function') return disposers
  for (const [id, dictionary] of Object.entries(DICTIONARIES)) {
    try {
      disposers.push(locale.register(NAMESPACE, id, dictionary))
    } catch {
      // A locale service with a different shape leaves the built-in copy in place.
    }
  }
  return disposers
}

/**
 * Build the translate function the panel uses.
 * @param locale - the Client locale service, when present.
 * @returns a `t(key)` reader with the current language applied.
 */
export function createTranslate(locale) {
  const snapshot = () => {
    try {
      return locale?.getSnapshot?.() ?? locale?.getLocale?.() ?? {}
    } catch {
      return {}
    }
  }
  return (key) => {
    const state = snapshot()
    const active = state?.active ?? state?.preference ?? state?.id
    const dictionary = dictionaryFor(active)
    return dictionary[key] ?? EN[key] ?? key
  }
}
