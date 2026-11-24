/**
 * Stand-in for `@excalidraw/mermaid-to-excalidraw`.
 *
 * Excalidraw imports that package dynamically only when someone pastes Mermaid
 * text into the "insert" dialog. Bundling Mermaid, Cytoscape and KaTeX would add
 * about 3.4 MiB to every page load, so the feature is left out and reports why.
 */

/**
 * Refuse a Mermaid conversion with an actionable message.
 * @returns never; the conversion is unavailable.
 */
export function parseMermaidToExcalidraw() {
  throw new Error('Mermaid import is not included in this canvas build; draw the diagram or ask the agent to draw it instead.')
}

export default { parseMermaidToExcalidraw }
