/**
 * Panel chrome. Only theme tokens are used, so the panel follows light and dark
 * themes and every future token rename degrades appearance, never layout.
 *
 * @module dsh-excalidraw-canvas/client/styles
 */

/** Stylesheet for the canvas panel. */
export const PANEL_CSS = `
.dxc-root {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  overflow: hidden;
  background: var(--dsw-specific-sidebar-fill, var(--dsw-alias-bg-base));
  color: var(--dsw-alias-label-primary);
  font-size: 12px;
  line-height: 1.4;
}
.dxc-toolbar {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 4px;
  padding: 6px 8px;
  border-bottom: 1px solid var(--dsw-alias-border-l1);
}
.dxc-select {
  flex: 0 1 auto;
  max-width: 42%;
  height: 24px;
  padding: 0 4px;
  border-radius: 6px;
  border: 1px solid var(--dsw-alias-border-l1);
  background: var(--dsw-alias-bg-layer-1);
  color: var(--dsw-alias-label-primary);
  font: inherit;
  font-size: 12px;
}
.dxc-select:focus-visible,
.dxc-input:focus-visible {
  outline: 2px solid var(--dsw-alias-brand-primary);
  outline-offset: 1px;
}
.dxc-create {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  min-width: 0;
}
.dxc-create-inline {
  flex-wrap: wrap;
  justify-content: center;
  margin-top: 4px;
}
.dxc-create-inline .dxc-input {
  width: 180px;
}
.dxc-input {
  width: 130px;
  height: 24px;
  padding: 0 6px;
  border-radius: 6px;
  border: 1px solid var(--dsw-alias-border-l2);
  background: var(--dsw-alias-bg-layer-1);
  color: var(--dsw-alias-label-primary);
  font: inherit;
  font-size: 12px;
}
.dxc-icon-button {
  flex: 0 0 auto;
  width: 24px;
  height: 24px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 0;
  border: 1px solid transparent;
  border-radius: 6px;
  background: transparent;
  color: var(--dsw-alias-label-secondary);
  cursor: pointer;
}
.dxc-icon-button:hover:not(:disabled) {
  background: var(--dsw-alias-bg-layer-2);
  color: var(--dsw-alias-label-primary);
}
.dxc-icon-button:disabled {
  opacity: 0.45;
  cursor: default;
}
.dxc-button {
  flex: 0 0 auto;
  height: 24px;
  padding: 0 8px;
  border-radius: 6px;
  border: 1px solid var(--dsw-alias-border-l1);
  background: var(--dsw-alias-bg-layer-1);
  color: var(--dsw-alias-label-primary);
  font: inherit;
  font-size: 12px;
  cursor: pointer;
}
.dxc-button:hover {
  background: var(--dsw-alias-bg-layer-2);
}
.dxc-button.dxc-primary {
  border-color: transparent;
  background: var(--dsw-alias-brand-primary);
  color: #ffffff;
}
.dxc-button.dxc-quiet {
  border-color: transparent;
  background: transparent;
  color: var(--dsw-alias-label-secondary);
}
.dxc-status {
  margin-left: auto;
  min-width: 0;
  max-width: 100%;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
  color: var(--dsw-alias-label-secondary);
  font-size: 12px;
}
.dxc-status-error { color: var(--dsw-alias-state-error-primary); }
.dxc-status-conflict { color: var(--dsw-alias-state-warn-primary); }
.dxc-status-saving { color: var(--dsw-alias-label-secondary); }
.dxc-status-saved { color: var(--dsw-alias-state-success-primary); }
.dxc-banner-error {
  background: var(--dsw-alias-bg-layer-2);
  border-bottom-color: var(--dsw-alias-state-error-primary);
}
.dxc-banner {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px;
  border-bottom: 1px solid var(--dsw-alias-border-l1);
  background: var(--dsw-alias-bg-layer-2);
}
.dxc-banner-text {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
  color: var(--dsw-alias-label-secondary);
}
.dxc-banner-text strong {
  color: var(--dsw-alias-label-primary);
  font-weight: 600;
}
.dxc-canvas {
  flex: 1 1 auto;
  min-height: 0;
  position: relative;
}
/* Excalidraw forces its onboarding overlay onto an empty scene; inside a dock
   pane it is a branded wall covering the canvas the user just created. */
.dxc-canvas .welcome-screen-center,
.dxc-canvas .welcome-screen-decor {
  display: none !important;
}
.dxc-canvas > .excalidraw {
  height: 100%;
}
/* Fullscreen is the canvas element itself, so the browser paints its own black
   backdrop; give it the panel background instead of a transparent hole. */
.dxc-root:fullscreen {
  background: var(--dsw-alias-bg-layer-1);
}
/* Fallback for a shell that refuses element fullscreen: cover the viewport. */
/* The fullscreen exit is a word, not a glyph, so it reads as an action. */
.dxc-exit-fullscreen {
  border-color: var(--dsw-alias-border-strong);
}
.dxc-root--maximised {
  position: fixed;
  inset: 0;
  z-index: 2147483000;
  width: 100vw;
  height: 100vh;
  background: var(--dsw-alias-bg-layer-1);
}
/* Navigator thumbnail: a pointer target floating over the canvas, small enough
   to stay out of the drawing area of a narrow pane. */
.dxc-minimap {
  position: absolute;
  right: 10px;
  /* clear of Excalidraw's own footer buttons, which own the bottom edge */
  bottom: 48px;
  border-radius: 6px;
  border: 1px solid var(--dsw-alias-border-default);
  background: color-mix(in srgb, var(--dsw-alias-bg-layer-1) 82%, transparent);
  box-shadow: 0 2px 8px rgb(0 0 0 / 12%);
  cursor: crosshair;
  touch-action: none;
  z-index: 4;
}
.dxc-minimap:hover {
  border-color: var(--dsw-alias-border-strong);
}
.dxc-empty {
  flex: 1 1 auto;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 24px;
  text-align: center;
  color: var(--dsw-alias-label-secondary);
}
.dxc-empty strong {
  color: var(--dsw-alias-label-primary);
  font-size: 13px;
  font-weight: 600;
}
.dxc-empty span {
  max-width: 260px;
}
.dxc-handoff {
  flex: 1 1 auto;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 10px;
  padding: 24px;
  text-align: center;
  color: var(--dsw-alias-label-secondary);
}
.dxc-handoff span {
  max-width: 280px;
}
`
