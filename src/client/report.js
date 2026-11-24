/**
 * Report a browser-half stage to the Host so activation and panel failures are
 * observable from the Host side instead of only in the page console.
 *
 * @module dsh-excalidraw-canvas/client/report
 */

/**
 * Post one report.
 * @param stage - what the browser half was doing.
 * @param error - failure, when there was one.
 * @param notes - extra JSON-serializable detail.
 */
export function reportToHost(stage, error, notes) {
  try {
    void fetch('plugins/dsh-excalidraw-canvas/api/hello', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        stage,
        error: error === undefined || error === null ? null : String(error?.stack ?? error),
        notes: notes ?? null,
      }),
    }).catch(() => {})
  } catch {
    // Reporting is best effort and must never affect the panel.
  }
}
