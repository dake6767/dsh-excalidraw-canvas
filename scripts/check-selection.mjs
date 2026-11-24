/**
 * Guard the rule that a selection implies its labels and its connectors.
 *
 * Clicking an ungrouped box selects only the box: the label lives in a separate
 * `text` element that points back through `containerId`, so a picture of the
 * selection used to come out with no text at all. Grouping hid the bug, because
 * a group selects every member. This loads the real function out of panel.jsx
 * and runs it against a scene built here, so the check cannot drift when a
 * canvas in the workspace is edited.
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))

/** Pull one top-level `function name(...) { ... }` out of a source file. */
function extractFunction(source, name) {
  const start = source.indexOf(`function ${name}(`)
  if (start === -1) throw new Error(`${name} not found in panel.jsx`)
  const open = source.indexOf('{', start)
  let depth = 0
  for (let i = open; i < source.length; i++) {
    if (source[i] === '{') depth++
    else if (source[i] === '}') {
      depth--
      if (depth === 0) return source.slice(start, i + 1)
    }
  }
  throw new Error(`unbalanced braces in ${name}`)
}

const panel = readFileSync(join(root, 'src/client/panel.jsx'), 'utf8')
const selectionElements = new Function(`${extractFunction(panel, 'selectionElements')}; return selectionElements`)()

// The shape Excalidraw writes: two labelled boxes joined by a bound arrow. The
// labels are separate elements, and none of the three is grouped.
const elements = [
  { id: 'start', type: 'rectangle', isDeleted: false, boundElements: [{ type: 'text', id: 'start-label' }, { type: 'arrow', id: 'edge' }] },
  { id: 'start-label', type: 'text', isDeleted: false, containerId: 'start', text: '开始' },
  { id: 'end', type: 'rectangle', isDeleted: false, boundElements: [{ type: 'text', id: 'end-label' }, { type: 'arrow', id: 'edge' }] },
  { id: 'end-label', type: 'text', isDeleted: false, containerId: 'end', text: '结束' },
  { id: 'edge', type: 'arrow', isDeleted: false, startBinding: { elementId: 'start' }, endBinding: { elementId: 'end' } },
  { id: 'bystander', type: 'rectangle', isDeleted: false, boundElements: [] },
]

const picked = selectionElements(elements, new Set(['start', 'end']))
const ids = picked.map(element => element.id).sort()
const labels = picked.filter(element => element.type === 'text').map(element => element.text)

const problems = []
if (!ids.includes('start-label') || !ids.includes('end-label')) problems.push('the container labels were dropped from the selection')
if (!ids.includes('edge')) problems.push('the arrow whose two ends are selected was dropped')
if (ids.includes('bystander')) problems.push('an element outside the selection was pulled in')

const deleted = selectionElements(
  [...elements, { id: 'gone', type: 'text', isDeleted: true, containerId: 'start', text: 'x' }],
  new Set(['start', 'end']),
)
if (deleted.some(element => element.id === 'gone')) problems.push('a deleted element leaked into the selection')

if (problems.length > 0) {
  console.error('selection check failed:')
  for (const line of problems) console.error(`  - ${line}`)
  console.error(`  returned: ${ids.join(', ')}`)
  process.exit(1)
}

console.log(`selection check: picking start+end yields ${ids.join(', ')}`)
console.log(`  labels: ${labels.join(', ')}`)
