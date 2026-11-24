/**
 * Inline glyphs for the canvas panel and its guide card. They inherit
 * `currentColor`, so the host theme decides their colour.
 *
 * @module dsh-excalidraw-canvas/client/icons
 */
import { createElement as h } from 'react'

/**
 * The shared 16px stroked frame.
 * @param props - icon props carrying a size.
 * @param children - paths.
 * @returns an inline SVG element.
 */
function frame(props, children) {
  const size = props?.size ?? props?.width ?? 16
  return h('svg', {
    width: size,
    height: size,
    viewBox: '0 0 16 16',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.35,
    strokeLinecap: 'round',
    strokeLinejoin: 'round',
    'aria-hidden': true,
    style: { display: 'block' },
  }, children)
}

/**
 * Canvas glyph: a frame with two connected nodes.
 * @param props - icon props.
 * @returns the glyph.
 */
export function CanvasIcon(props) {
  return frame(props, [
    h('rect', { key: 'frame', x: 1.4, y: 2.6, width: 13.2, height: 10.8, rx: 2 }),
    h('circle', { key: 'a', cx: 5.2, cy: 8, r: 1.5 }),
    h('circle', { key: 'b', cx: 11, cy: 8, r: 1.5 }),
    h('path', { key: 'edge', d: 'M6.7 8h2.6' }),
  ])
}

/**
 * Plus glyph.
 * @param props - icon props.
 * @returns the glyph.
 */
export function PlusIcon(props) {
  return frame(props, [h('path', { key: 'plus', d: 'M8 3.2v9.6M3.2 8h9.6' })])
}

/**
 * Reload glyph.
 * @param props - icon props.
 * @returns the glyph.
 */
export function ReloadIcon(props) {
  return frame(props, [
    h('path', { key: 'arc', d: 'M13 8a5 5 0 1 1-1.6-3.7' }),
    h('path', { key: 'head', d: 'M13.1 2.4v3h-3' }),
  ])
}

/**
 * Image / export glyph.
 * @param props - icon props.
 * @returns the glyph.
 */
export function ImageIcon(props) {
  return frame(props, [
    h('rect', { key: 'frame', x: 2, y: 3, width: 12, height: 10, rx: 1.6 }),
    h('circle', { key: 'sun', cx: 5.8, cy: 6.4, r: 1.1 }),
    h('path', { key: 'hill', d: 'M2.6 11.4l3.4-3.6 2.6 2.6 2-1.8 3 2.8' }),
  ])
}

/**
 * Fit-to-content glyph.
 * @param props - icon props.
 * @returns the glyph.
 */
export function FitIcon(props) {
  // Arrows pointing IN: "shrink the view until the content fits". Pointing them
  // the other way is the fullscreen glyph, and the two read as opposites.
  return frame(props, [
    h('path', { key: 'tl', d: 'M2.6 2.6h2.6M2.6 2.6v2.6M5.2 5.2L8 8' }),
    h('path', { key: 'tr', d: 'M13.4 2.6h-2.6M13.4 2.6v2.6M10.8 5.2L8 8' }),
    h('path', { key: 'br', d: 'M13.4 13.4h-2.6M13.4 13.4v-2.6M10.8 10.8L8 8' }),
    h('path', { key: 'bl', d: 'M2.6 13.4h2.6M2.6 13.4v-2.6M5.2 10.8L8 8' }),
  ])
}

/**
 * Fullscreen glyph: the frame's arrows point OUT, the opposite of `FitIcon`.
 * @param props - icon props.
 * @returns the glyph.
 */
export function MaximizeIcon(props) {
  return frame(props, [
    h('path', { key: 'tl', d: 'M2.6 6V2.6H6M8 8L2.6 2.6' }),
    h('path', { key: 'tr', d: 'M10 2.6h3.4V6M8 8l5.4-5.4' }),
    h('path', { key: 'br', d: 'M13.4 10v3.4H10M8 8l5.4 5.4' }),
    h('path', { key: 'bl', d: 'M6 13.4H2.6V10M8 8l-5.4 5.4' }),
  ])
}

/**
 * Download glyph: an arrow into a tray, for "put the PNG in my Downloads folder".
 * @param props - icon props.
 * @returns the glyph.
 */
export function DownloadIcon(props) {
  return frame(props, [
    h('path', { key: 'shaft', d: 'M8 2.4v7' }),
    h('path', { key: 'head', d: 'M5 6.6L8 9.6l3-3' }),
    h('path', { key: 'tray', d: 'M3 12.6h10' }),
  ])
}

/**
 * Send glyph: an arrow leaving a frame, for "put this in the conversation".
 * @param props - icon props.
 * @returns the glyph.
 */
export function SendIcon(props) {
  // A speech bubble with a plus: "put this into the conversation", which is what
  // the button does. An arrow leaving a box reads as sharing instead.
  return frame(props, [
    h('path', {
      key: 'bubble',
      d: 'M4.6 2.8h6.8a2 2 0 0 1 2 2v4a2 2 0 0 1-2 2H8.2L5.2 13.6v-2.8H4.6a2 2 0 0 1-2-2v-4a2 2 0 0 1 2-2z',
    }),
    h('path', { key: 'plus-h', d: 'M6.5 6.8h3' }),
    h('path', { key: 'plus-v', d: 'M8 5.3v3' }),
  ])
}
