/**
 * Dev check for the layout maths: bundle the diagram module against a stub
 * Excalidraw, then assert that ranked nodes do not overlap and that edges bind.
 *
 * Usage: `node scripts/check-layout.mjs`
 */
import { build } from 'esbuild'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const stub = `
export function convertToExcalidrawElements(skeletons) {
  const out = []
  for (const skeleton of skeletons) {
    const element = { ...skeleton, width: skeleton.width ?? 120, height: skeleton.height ?? 60, isDeleted: false }
    out.push(element)
    if (skeleton.label) {
      out.push({ id: 'text:' + skeleton.id, type: 'text', containerId: skeleton.id, text: skeleton.label.text, originalText: skeleton.label.text, isDeleted: false })
    }
  }
  return out
}
export function restoreElements(elements) { return elements }
`

const workspace = await mkdtemp(join(tmpdir(), 'dsh-excalidraw-canvas-check-'))
try {
  const stubFile = join(workspace, 'excalidraw-stub.mjs')
  await writeFile(stubFile, stub, 'utf8')
  const outFile = join(workspace, 'diagram.mjs')
  await build({
    entryPoints: [new URL('../src/client/diagram.js', import.meta.url).pathname],
    bundle: true,
    format: 'esm',
    platform: 'neutral',
    write: false,
    outfile: outFile,
    logLevel: 'silent',
    plugins: [{
      name: 'stub',
      setup(build) {
        build.onResolve({ filter: /^@excalidraw\/excalidraw$/ }, () => ({ path: stubFile }))
      },
    }],
  }).then(async (result) => writeFile(outFile, result.outputFiles[0].text, 'utf8'))

  const { buildDiagram, layoutNodes, mergeDiagram } = await import(pathToFileURL(outFile).href)

  const spec = {
    direction: 'TB',
    nodes: [
      { id: 'browser', label: 'Browser' },
      { id: 'api', label: 'API 网关', shape: 'diamond' },
      { id: 'db', label: 'Postgres' },
      { id: 'worker', label: 'Background worker with a longer label' },
    ],
    edges: [
      { from: 'browser', to: 'api' },
      { from: 'api', to: 'db', label: 'sql' },
      { from: 'api', to: 'worker', dashed: true },
    ],
  }

  const boxes = layoutNodes(spec)
  const values = [...boxes.entries()].map(([id, box]) => ({ id, ...box }))
  const overlaps = []
  for (let i = 0; i < values.length; i += 1) {
    for (let j = i + 1; j < values.length; j += 1) {
      const a = values[i]
      const b = values[j]
      const hit = a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height
      if (hit) overlaps.push(`${a.id} / ${b.id}`)
    }
  }
  if (overlaps.length > 0) throw new Error(`overlapping nodes: ${overlaps.join(', ')}`)
  if (Math.min(...values.map(box => box.x)) !== 0 || Math.min(...values.map(box => box.y)) !== 0) {
    throw new Error('layout is not normalised to the origin')
  }
  const rank = id => values.find(box => box.id === id).y
  if (!(rank('browser') < rank('api') && rank('api') < rank('db'))) throw new Error('ranks do not follow the edges')

  // A merge offsets its AUTO nodes into place, but a node with explicit
  // coordinates is already in scene space and must not be moved by that offset.
  const merged = mergeDiagram(
    [{ id: 'existing', type: 'rectangle', x: 900, y: 900, width: 100, height: 60, isDeleted: false }],
    { direction: 'TB', nodes: [{ id: 'auto', label: 'Auto' }, { id: 'pinned', label: 'Pinned', shape: 'text', x: -234, y: 803 }], edges: [] },
    'light',
  )
  const pinnedElement = merged.find(element => element.id === 'pinned')
  const autoElement = merged.find(element => element.id === 'auto')
  if (pinnedElement === undefined || pinnedElement.x !== -234 || pinnedElement.y !== 803) {
    throw new Error(`pinned node moved during merge: ${pinnedElement?.x},${pinnedElement?.y}`)
  }
  if (autoElement === undefined || autoElement.x === -234) {
    throw new Error('auto node did not receive the merge offset')
  }

  const elements = buildDiagram(spec, 'light')
  const bound = elements.filter(element => element.type === 'arrow' && element.start?.id && element.end?.id)
  if (bound.length !== 3) throw new Error(`expected 3 bound arrows, got ${bound.length}`)
  if (!elements.some(element => element.type === 'rectangle' && element.label)) {
    throw new Error('containers did not carry labels')
  }

  const side = layoutNodes({ ...spec, direction: 'LR' })
  if (!(side.get('browser').x < side.get('api').x && side.get('api').x < side.get('db').x)) {
    throw new Error('left-to-right ranks do not follow the edges')
  }

  // Explicit coordinates are final: the automatic pass must not drag a node the
  // caller placed, and its siblings keep their auto-laid positions.
  const pinned = layoutNodes({
    direction: 'TB',
    nodes: [
      { id: 'above', label: 'Above' },
      { id: 'caption', label: '一行标题', shape: 'text', x: -318, y: 801 },
    ],
    edges: [],
  })
  const caption = pinned.get('caption')
  if (caption.x !== -318 || caption.y !== 801) {
    throw new Error(`explicit coordinates were moved: ${caption.x},${caption.y}`)
  }

  // Arrows meet their shapes at the boundary, never at the centre.
  const rect = elements.find(element => element.id === 'browser')
  const diamond = elements.find(element => element.id === 'api')
  const shapeEdge = (element) => {
    const arrow = elements.find(item => item.type === 'arrow' && item.start?.id === element.id)
    if (arrow === undefined) throw new Error(`no arrow leaves ${element.id}`)
    const cx = element.x + element.width / 2
    const cy = element.y + element.height / 2
    const distance = Math.hypot(arrow.x - cx, arrow.y - cy)
    if (distance < 20) throw new Error(`arrow starts at the centre of ${element.id}`)
    return { arrow, distance }
  }
  const fromRect = shapeEdge(rect)
  const fromDiamond = shapeEdge(diamond)
  if (Math.abs(fromRect.distance - rect.height / 2) > 1.5) {
    throw new Error(`rect attachment is not on the boundary: ${fromRect.distance}`)
  }
  const diamondCentre = { x: diamond.x + diamond.width / 2, y: diamond.y + diamond.height / 2 }
  const diamondNormalised =
    Math.abs(fromDiamond.arrow.x - diamondCentre.x) / (diamond.width / 2)
    + Math.abs(fromDiamond.arrow.y - diamondCentre.y) / (diamond.height / 2)
  // The attachment sits exactly on the diamond edge.
  if (diamondNormalised < 0.99 || diamondNormalised > 1.05) {
    throw new Error(`diamond attachment is not on the diamond edge: ${diamondNormalised}`)
  }

  // A cycle survives: the back edge is routed outside the content, not across it.
  const cycle = {
    direction: 'TB',
    nodes: [
      { id: 'a', label: 'A' },
      { id: 'b', label: 'B' },
      { id: 'c', label: 'C' },
    ],
    edges: [
      { from: 'a', to: 'b' },
      { from: 'b', to: 'c' },
      { from: 'c', to: 'a', label: 'retry', dashed: true },
    ],
  }
  const cycled = buildDiagram(cycle, 'light')
  const backArrow = cycled.find(element => element.type === 'arrow' && element.start?.id === 'c')
  if (backArrow === undefined) throw new Error('back edge was dropped')
  if (!Array.isArray(backArrow.points) || backArrow.points.length < 4) {
    throw new Error('back edge was not routed around the content')
  }
  const shapesIn = scene => scene.filter(element => ['rectangle', 'ellipse', 'diamond'].includes(element.type))
  const spans = cycled
  const rightMost = Math.max(...shapesIn(spans).map(element => element.x + element.width))
  const leftMost = Math.min(...shapesIn(spans).map(element => element.x))
  const laneX = backArrow.x + backArrow.points[1][0]
  if (laneX < rightMost && laneX > leftMost) throw new Error('back edge lane is inside the diagram')
  // A wide middle rank must not be crossed by the back edge lane.
  const wide = {
    direction: 'TB',
    nodes: [
      { id: 'top', label: 'top' },
      { id: 'wide1', label: 'wide one' },
      { id: 'wide2', label: 'wide two' },
      { id: 'bottom', label: 'bottom' },
    ],
    edges: [
      { from: 'top', to: 'wide1' },
      { from: 'wide1', to: 'bottom' },
      { from: 'wide2', to: 'bottom' },
      { from: 'bottom', to: 'top', dashed: true },
    ],
  }
  const wideScene = buildDiagram(wide, 'light')
  const laneArrow = wideScene.find(element => element.type === 'arrow' && element.start?.id === 'bottom')
  const wideShapes = wideScene.filter(element => ['rectangle', 'ellipse', 'diamond'].includes(element.type))
  const anyRight = Math.max(...wideShapes.map(element => element.x + element.width))
  const anyLeft = Math.min(...wideShapes.map(element => element.x))
  const wideLaneX = laneArrow === undefined ? 0 : laneArrow.x + laneArrow.points[1][0]
  if (laneArrow === undefined || (wideLaneX < anyRight && wideLaneX > anyLeft)) {
    throw new Error('back edge lane crosses a neighbouring box')
  }

  const ranks = new Map(cycled
    .filter(element => element.type === 'rectangle')
    .map(element => [element.id, element.y]))
  if (!(ranks.get('a') < ranks.get('b') && ranks.get('b') < ranks.get('c'))) {
    throw new Error('a cycle reordered the nodes that do not form it')
  }

  console.log(`layout ok: ${values.length} nodes, ${bound.length} bound arrows, LR ok, boundary + back-edge routing ok`)
} finally {
  await rm(workspace, { recursive: true, force: true })
}
