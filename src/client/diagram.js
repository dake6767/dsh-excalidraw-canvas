/**
 * Scene construction for the canvas panel: turns the compact diagram spec the
 * agent sends into real Excalidraw elements, and applies surgical edits.
 *
 * Excalidraw owns measurement, so every element the agent asked for is created
 * through `convertToExcalidrawElements` and normalised by `restoreElements`; this
 * module only decides where things go.
 *
 * @module dsh-excalidraw-canvas/client/diagram
 */
import { convertToExcalidrawElements, restoreElements } from '@excalidraw/excalidraw'

/** Fill and stroke of one named accent. */
export const PALETTE = {
  blue: { fill: '#a5d8ff', stroke: '#1971c2' },
  green: { fill: '#b2f2bb', stroke: '#2f9e44' },
  red: { fill: '#ffc9c9', stroke: '#e03131' },
  yellow: { fill: '#ffec99', stroke: '#f08c00' },
  violet: { fill: '#d0bfff', stroke: '#6741d9' },
  orange: { fill: '#ffd8a8', stroke: '#e8590c' },
  teal: { fill: '#99e9f2', stroke: '#0c8599' },
  gray: { fill: '#e9ecef', stroke: '#868e96' },
  white: { fill: '#ffffff', stroke: '#1e1e1e' },
}

/** Gap between two nodes of one rank, and between ranks. */
const SIBLING_GAP = 56
const RANK_GAP = 96
/** Ink used for edges, bare text, and labels: readable on both canvas themes. */
const inkOf = theme => (theme === 'dark' ? '#e9ecef' : '#1e1e1e')

/**
 * Rough size of a node from its label, with CJK characters counted wider.
 * @param label - node text, possibly multi-line.
 * @returns width and height in scene pixels.
 */
function measure(label) {
  const lines = String(label ?? '').split('\n')
  let longest = 0
  for (const line of lines) {
    let width = 0
    for (const character of line) {
      width += character.codePointAt(0) > 0x2e80 ? 17 : 9
    }
    longest = Math.max(longest, width)
  }
  return {
    width: Math.min(380, Math.max(150, Math.round(longest + 56))),
    height: Math.round(Math.max(64, 34 + lines.length * 26)),
  }
}

/**
 * Rank every node on the acyclic part of the graph, and report the edges that
 * close a cycle.
 *
 * A depth-first pass colours nodes as it walks; an edge whose target is still on
 * the stack is a back edge and is left out of the ranking, so a retry arrow does
 * not drag its target to the bottom of the picture. The ranking itself is then a
 * plain longest-path pass over the remaining edges.
 * @param nodes - spec nodes.
 * @param edges - spec edges.
 * @returns the rank per node and the set of back edges as `from\u0000to`.
 */
function ranksOf(nodes, edges) {
  const known = new Set(nodes.map(node => node.id))
  const forward = edges.filter(edge => known.has(edge.from) && known.has(edge.to) && edge.from !== edge.to)
  const outgoing = new Map(nodes.map(node => [node.id, []]))
  for (const edge of forward) outgoing.get(edge.from).push(edge.to)
  const back = new Set()
  const state = new Map()
  const stack = []
  const walk = (start) => {
    stack.push({ id: start, index: 0 })
    state.set(start, 'open')
    while (stack.length > 0) {
      const frame = stack[stack.length - 1]
      const targets = outgoing.get(frame.id) ?? []
      if (frame.index >= targets.length) {
        state.set(frame.id, 'closed')
        stack.pop()
        continue
      }
      const next = targets[frame.index]
      frame.index += 1
      const seen = state.get(next)
      if (seen === 'open') {
        back.add(`${frame.id}\u0000${next}`)
        continue
      }
      if (seen === 'closed') continue
      state.set(next, 'open')
      stack.push({ id: next, index: 0 })
    }
  }
  for (const node of nodes) if (state.get(node.id) === undefined) walk(node.id)

  // Longest path over the acyclic remainder: a node sits one rank below its
  // furthest upstream neighbour.
  const parents = new Map(nodes.map(node => [node.id, []]))
  for (const edge of forward) {
    if (back.has(`${edge.from}\u0000${edge.to}`)) continue
    parents.get(edge.to).push(edge.from)
  }
  const ranks = new Map()
  const visiting = new Set()
  const visit = (id) => {
    if (ranks.has(id)) return ranks.get(id)
    if (visiting.has(id)) return 0
    visiting.add(id)
    const upstream = parents.get(id) ?? []
    const rank = upstream.length === 0 ? 0 : Math.max(...upstream.map(parent => visit(parent) + 1))
    visiting.delete(id)
    ranks.set(id, rank)
    return rank
  }
  for (const node of nodes) visit(node.id)
  return { ranks, back }
}

/**
 * Place nodes in rank order and return their boxes.
 * @param spec - `{ nodes, edges, direction }`.
 * @returns node id to `{ x, y, width, height }`, already normalised to the origin.
 */
export function layoutNodes(spec) {
  const nodes = spec.nodes ?? []
  const edges = spec.edges ?? []
  const { ranks } = ranksOf(nodes, edges)
  const rows = new Map()
  for (const node of nodes) {
    const rank = ranks.get(node.id) ?? 0
    if (!rows.has(rank)) rows.set(rank, [])
    rows.get(rank).push(node)
  }
  const boxes = new Map()
  const orderedRanks = [...rows.keys()].sort((left, right) => left - right)
  const vertical = spec.direction !== 'LR'
  let cursor = 0
  for (const rank of orderedRanks) {
    const members = rows.get(rank)
    let cross = 0
    let depth = 0
    for (const node of members) {
      const size = measure(node.label)
      const width = node.width ?? size.width
      const height = node.height ?? size.height
      if (vertical) {
        boxes.set(node.id, { x: cross, y: cursor, width, height })
        cross += width + SIBLING_GAP
        depth = Math.max(depth, height)
      } else {
        boxes.set(node.id, { x: cursor, y: cross, width, height })
        cross += height + SIBLING_GAP
        depth = Math.max(depth, width)
      }
    }
    cursor += depth + RANK_GAP
  }
  // Centre every rank on the widest one, then move the whole diagram to (0, 0).
  let extent = 0
  for (const box of boxes.values()) extent = Math.max(extent, vertical ? box.x + box.width : box.y + box.height)
  for (const rank of orderedRanks) {
    const members = rows.get(rank)
    let span = 0
    for (const node of members) {
      const box = boxes.get(node.id)
      span = Math.max(span, vertical ? box.x + box.width : box.y + box.height)
    }
    const shift = (extent - span) / 2
    for (const node of members) {
      const box = boxes.get(node.id)
      if (vertical) box.x += shift
      else box.y += shift
    }
  }
  let minX = Infinity
  let minY = Infinity
  for (const box of boxes.values()) {
    minX = Math.min(minX, box.x)
    minY = Math.min(minY, box.y)
  }
  if (!Number.isFinite(minX)) return boxes
  for (const box of boxes.values()) {
    box.x -= minX
    box.y -= minY
  }
  // Explicit coordinates are absolute scene coordinates, so they are applied
  // AFTER the automatic pass: the normalisation above exists only to start an
  // auto-laid diagram at the origin, and it must not drag a hand-placed node
  // along with it.
  for (const node of nodes) {
    const placedX = typeof node.x === 'number' && Number.isFinite(node.x) ? node.x : undefined
    const placedY = typeof node.y === 'number' && Number.isFinite(node.y) ? node.y : undefined
    if (placedX === undefined && placedY === undefined) continue
    const box = boxes.get(node.id)
    if (box === undefined) continue
    if (placedX !== undefined) box.x = placedX
    if (placedY !== undefined) box.y = placedY
  }
  return boxes
}

/**
 * Bounding box of the live elements, or null for an empty scene.
 * @param elements - scene elements.
 * @returns min/max coordinates.
 */
function boundsOf(elements) {
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const element of elements) {
    if (element.isDeleted) continue
    minX = Math.min(minX, element.x)
    minY = Math.min(minY, element.y)
    maxX = Math.max(maxX, element.x + (element.width ?? 0))
    maxY = Math.max(maxY, element.y + (element.height ?? 0))
  }
  return Number.isFinite(minX) ? { minX, minY, maxX, maxY } : null
}

/**
 * Space kept between a shape's edge and the arrow that meets it.
 *
 * Zero: a bound arrow's head is drawn where the binding meets the shape, so a
 * non-zero gap leaves the head detached and draws a second one at the path end.
 */
const EDGE_GAP = 0
/** How far outside the content a back edge runs before turning back in. */
const BACK_EDGE_LANE = 72

/**
 * Centre of one layout box in scene coordinates.
 * @param box - layout box.
 * @returns its centre point.
 */
function centreOf(box) {
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 }
}

/**
 * Where the ray from a shape's centre towards `from` leaves the shape,
 * pushed out by the shared gap so the line never touches the outline or the
 * text inside it. Rectangles, rounded rectangles, ellipses, and diamonds each
 * use their own boundary.
 * @param box - the shape's box.
 * @param from - the point the arrow comes from.
 * @param shape - `rect`, `round`, `ellipse`, `diamond`, or `text`.
 * @param gap - extra distance beyond the boundary.
 * @returns the attachment point.
 */
function boundaryPoint(box, from, shape, gap = EDGE_GAP) {
  const centre = centreOf(box)
  const dx = from.x - centre.x
  const dy = from.y - centre.y
  const length = Math.hypot(dx, dy)
  if (length < 1e-6) return { x: centre.x, y: centre.y + box.height / 2 + gap }
  const ux = dx / length
  const uy = dy / length
  const halfWidth = Math.max(box.width / 2, 8)
  const halfHeight = Math.max(box.height / 2, 8)
  let radius
  if (shape === 'ellipse') {
    radius = 1 / Math.hypot(ux / halfWidth, uy / halfHeight)
  } else if (shape === 'diamond') {
    radius = 1 / (Math.abs(ux) / halfWidth + Math.abs(uy) / halfHeight)
  } else if (shape === 'text') {
    radius = Math.min(halfWidth, halfHeight)
  } else {
    const toVertical = Math.abs(ux) > 1e-9 ? halfWidth / Math.abs(ux) : Number.POSITIVE_INFINITY
    const toHorizontal = Math.abs(uy) > 1e-9 ? halfHeight / Math.abs(uy) : Number.POSITIVE_INFINITY
    radius = Math.min(toVertical, toHorizontal)
  }
  return { x: centre.x + ux * (radius + gap), y: centre.y + uy * (radius + gap) }
}

/**
 * Count the boxes a straight run passes through.
 *
 * Used to pick which side of the picture a back edge leaves from: the run from
 * the shape to the outside lane must not cross anything, or the lane is no
 * better than the straight line it replaced.
 * @param boxes - every layout box keyed by node id.
 * @param axis - `x` for a horizontal run, `y` for a vertical one.
 * @param at - the fixed coordinate of the run.
 * @param from - one end of the run.
 * @param to - the other end.
 * @param skip - node ids the run may touch (its own endpoints).
 * @returns how many boxes it crosses.
 */
function crossings(boxes, axis, at, from, to, skip) {
  const low = Math.min(from, to)
  const high = Math.max(from, to)
  let count = 0
  for (const [id, box] of boxes) {
    if (skip.has(id)) continue
    if (axis === 'x') {
      if (at < box.y - 1 || at > box.y + box.height + 1) continue
      if (box.x + box.width > low + 1 && box.x < high - 1) count += 1
    } else {
      if (at < box.x - 1 || at > box.x + box.width + 1) continue
      if (box.y + box.height > low + 1 && box.y < high - 1) count += 1
    }
  }
  return count
}

/**
 * One skeleton per node and one per edge, using the layout boxes.
 *
 * Edges are drawn from boundary to boundary, so a line meets a box at its side
 * instead of running across the label. An edge that closes a cycle keeps its
 * meaning but is routed down an outside lane, clear of the boxes between its
 * ends, because a straight line there would cut through the diagram.
 * @param spec - `{ nodes, edges, direction }`.
 * @param theme - canvas theme, for ink colour.
 * @param offset - translation applied to every element.
 * @param taken - ids already used in the scene; colliding new nodes are suffixed.
 * @returns Excalidraw skeletons.
 */
function skeletonsOf(spec, theme, offset, taken) {
  const boxes = layoutNodes(spec)
  const { ranks, back } = ranksOf(spec.nodes ?? [], spec.edges ?? [])
  const ink = inkOf(theme)
  const skeletons = []
  const usedIds = new Set(taken)
  const shapes = new Map()
  const idMap = new Map()
  const uniqueId = (wanted) => {
    let candidate = String(wanted)
    let index = 2
    while (usedIds.has(candidate)) candidate = `${wanted}-${index++}`
    usedIds.add(candidate)
    return candidate
  }
  // A node the caller placed is already in scene coordinates, so the merge
  // offset — which exists to move an AUTO-laid diagram beside existing content —
  // must not be added to that axis.
  const placedOn = new Map((spec.nodes ?? []).map(node => [node.id, {
    x: typeof node.x === 'number' && Number.isFinite(node.x),
    y: typeof node.y === 'number' && Number.isFinite(node.y),
  }]))
  const sceneCoord = (id, axis, value) => {
    const placed = placedOn.get(id)
    return placed?.[axis] === true ? value : value + offset[axis]
  }
  /** Layout box translated into scene coordinates, or undefined when unknown. */
  const sceneBox = (id) => {
    const box = boxes.get(id)
    if (box === undefined) return undefined
    return {
      x: sceneCoord(id, 'x', box.x),
      y: sceneCoord(id, 'y', box.y),
      width: box.width,
      height: box.height,
    }
  }
  for (const node of spec.nodes ?? []) {
    const box = boxes.get(node.id)
    if (box === undefined) continue
    const id = uniqueId(node.id)
    idMap.set(node.id, id)
    const shape = node.shape ?? 'rect'
    shapes.set(node.id, shape)
    const accent = PALETTE[node.color] ?? PALETTE.gray
    const base = {
      id,
      x: sceneCoord(node.id, 'x', box.x),
      y: sceneCoord(node.id, 'y', box.y),
      strokeColor: shape === 'text' ? ink : accent.stroke,
      backgroundColor: shape === 'text' ? 'transparent' : accent.fill,
      fillStyle: 'solid',
      strokeWidth: shape === 'text' ? 1 : 2,
      roughness: 1,
      opacity: 100,
    }
    if (shape === 'text') {
      skeletons.push({ ...base, type: 'text', text: node.label, fontSize: 20, fontFamily: 2, strokeColor: ink })
      continue
    }
    const type = shape === 'ellipse' ? 'ellipse' : shape === 'diamond' ? 'diamond' : 'rectangle'
    skeletons.push({
      ...base,
      type,
      width: box.width,
      height: box.height,
      ...(shape === 'round' ? { roundness: { type: 3 } } : {}),
      label: { text: node.label, strokeColor: '#1e1e1e', fontSize: 20, fontFamily: 2 },
    })
  }
  // A back edge runs outside everything, not merely outside its own endpoints.
  let contentMinX = Number.POSITIVE_INFINITY
  let contentMinY = Number.POSITIVE_INFINITY
  let contentMaxX = 0
  let contentMaxY = 0
  for (const box of boxes.values()) {
    contentMinX = Math.min(contentMinX, box.x + offset.x)
    contentMinY = Math.min(contentMinY, box.y + offset.y)
    contentMaxX = Math.max(contentMaxX, box.x + box.width + offset.x)
    contentMaxY = Math.max(contentMaxY, box.y + box.height + offset.y)
  }
  const sceneBoxes = new Map([...boxes.entries()].map(([id, box]) => [id, {
    x: box.x + offset.x,
    y: box.y + offset.y,
    width: box.width,
    height: box.height,
  }]))
  const skipFor = edge => new Set([edge.from, edge.to])
  const verticalFlow = spec.direction !== 'LR'
  let laneDepth = 0
  for (const edge of spec.edges ?? []) {
    const from = idMap.get(edge.from) ?? edge.from
    const to = idMap.get(edge.to) ?? edge.to
    const startBox = sceneBox(edge.from)
    const endBox = sceneBox(edge.to)
    const skeleton = {
      id: uniqueId(`edge:${edge.from}->${edge.to}`),
      type: 'arrow',
      x: startBox?.x ?? offset.x,
      y: startBox?.y ?? offset.y,
      strokeColor: ink,
      strokeWidth: 2,
      strokeStyle: edge.dashed === true ? 'dashed' : 'solid',
      roughness: 1,
      start: { id: from },
      end: { id: to },
      endArrowhead: edge.arrow === 'none' ? null : 'arrow',
      startArrowhead: edge.arrow === 'both' ? 'arrow' : null,
    }
    if (startBox !== undefined && endBox !== undefined) {
      const isLoop = edge.from === edge.to
      const isBack = !isLoop && back.has(`${edge.from}\u0000${edge.to}`)
      if (isLoop) {
        // A loop leaves and returns to the same side, so it is drawn unbound.
        const anchor = boundaryPoint(startBox, { x: startBox.x + startBox.width, y: startBox.y }, shapes.get(edge.from))
        const reach = 54
        skeleton.x = anchor.x
        skeleton.y = anchor.y
        skeleton.points = [[0, 0], [reach, -26], [reach, 26], [0, 0]]
        skeleton.start = undefined
        skeleton.end = undefined
        skeleton.startArrowhead = null
        skeleton.endArrowhead = edge.arrow === 'none' ? null : 'arrow'
      } else if (isBack && ranks.get(edge.to) <= ranks.get(edge.from)) {
        // One outside lane per back edge, clear of every box in the diagram.
        laneDepth += 1
        const startCentre = centreOf(startBox)
        const endCentre = centreOf(endBox)
        const skip = skipFor(edge)
        if (verticalFlow) {
          // Leave towards the side that the run crosses least; the target's own
          // side wins a tie, so the line approaches from where the reader looks.
          const outward = endCentre.x < startCentre.x ? -1 : 1
          const sides = [outward, -outward].map((direction) => {
            const laneX = direction > 0
              ? contentMaxX + BACK_EDGE_LANE * laneDepth
              : contentMinX - BACK_EDGE_LANE * laneDepth
            const exitCost = crossings(sceneBoxes, 'x', startCentre.y, laneX, startCentre.x, skip)
            const entryCost = crossings(sceneBoxes, 'x', endCentre.y, laneX, endCentre.x, skip)
            return { direction, laneX, cost: exitCost + entryCost }
          }).sort((left, right) => left.cost - right.cost)
          const laneX = sides[0].laneX
          const exit = boundaryPoint(startBox, { x: laneX, y: startCentre.y }, shapes.get(edge.from))
          const entry = boundaryPoint(endBox, { x: laneX, y: endCentre.y }, shapes.get(edge.to))
          skeleton.x = exit.x
          skeleton.y = exit.y
          skeleton.points = [
            [0, 0],
            [laneX - exit.x, 0],
            [laneX - exit.x, entry.y - exit.y],
            [entry.x - exit.x, entry.y - exit.y],
          ]
        } else {
          const laneY = contentMaxY + BACK_EDGE_LANE * laneDepth
          const exit = boundaryPoint(startBox, { x: startCentre.x, y: laneY }, shapes.get(edge.from))
          const entry = boundaryPoint(endBox, { x: endCentre.x, y: laneY }, shapes.get(edge.to))
          skeleton.x = exit.x
          skeleton.y = exit.y
          skeleton.points = [
            [0, 0],
            [0, laneY - exit.y],
            [entry.x - exit.x, laneY - exit.y],
            [entry.x - exit.x, entry.y - exit.y],
          ]
        }
        skeleton.startArrowhead = edge.arrow === 'both' ? 'arrow' : null
        skeleton.endArrowhead = edge.arrow === 'none' ? null : 'arrow'
      } else {
        const startCentre = centreOf(startBox)
        const endCentre = centreOf(endBox)
        const from = boundaryPoint(startBox, endCentre, shapes.get(edge.from))
        const to = boundaryPoint(endBox, startCentre, shapes.get(edge.to))
        skeleton.x = from.x
        skeleton.y = from.y
        skeleton.points = [[0, 0], [to.x - from.x, to.y - from.y]]
      }
    }
    if (edge.label) skeleton.label = { text: edge.label, strokeColor: ink, fontSize: 16, fontFamily: 2 }
    skeletons.push(skeleton)
  }
  return skeletons
}

/**
 * Convert skeletons and repair bindings, keeping supplied ids.
 * @param skeletons - Excalidraw skeletons.
 * @returns live elements.
 */
function materialize(skeletons) {
  if (skeletons.length === 0) return []
  const converted = convertToExcalidrawElements(skeletons, { regenerateIds: false })
  return restoreElements(converted, null, { repairBindings: true, refreshDimensions: true })
}

/**
 * Build a whole canvas from a spec.
 * @param spec - `{ nodes, edges, direction, title }`.
 * @param theme - canvas theme.
 * @returns the new element list.
 */
export function buildDiagram(spec, theme) {
  const skeletons = skeletonsOf({ ...spec, direction: spec.direction ?? 'TB' }, theme, { x: 0, y: 0 }, new Set())
  const styled = spec.title
    ? [{
      id: `title:${Date.now()}`,
      type: 'text',
      text: spec.title,
      x: 0,
      y: -72,
      fontSize: 28,
      fontFamily: 2,
      strokeColor: inkOf(theme),
    }, ...skeletons]
    : skeletons
  return materialize(styled)
}

/**
 * Add a spec beside the existing content.
 * @param elements - current live elements.
 * @param spec - `{ nodes, edges, direction }`.
 * @param theme - canvas theme.
 * @returns the new element list.
 */
export function mergeDiagram(elements, spec, theme) {
  const taken = new Set(elements.filter(element => !element.isDeleted).map(element => element.id))
  const bounds = boundsOf(elements)
  const offset = bounds === null ? { x: 0, y: 0 } : { x: bounds.maxX + 160, y: bounds.minY }
  const skeletons = skeletonsOf(spec, theme, offset, taken)
  if (skeletons.length === 0) return elements
  return restoreElements([...elements, ...materialize(skeletons)], null, { repairBindings: true, refreshDimensions: true })
}

/**
 * Re-apply one element's colours and geometry to itself and to its bound label.
 * @param element - the element to change.
 * @param patch - requested changes.
 * @param theme - canvas theme.
 * @returns a replacement element, or null when the request means "rebuild it".
 */
function patchElement(element, patch) {
  const next = { ...element }
  let rebuild = false
  const accent = patch.color !== undefined ? PALETTE[patch.color] : undefined
  if (accent !== undefined) {
    next.backgroundColor = accent.fill
    next.strokeColor = accent.stroke
  }
  for (const key of ['x', 'y', 'width', 'height']) {
    if (typeof patch[key] === 'number') next[key] = patch[key]
  }
  if (typeof patch.fontSize === 'number') next.fontSize = patch.fontSize
  if (typeof patch.label === 'string' && patch.label !== '') {
    if (element.type === 'text') {
      next.text = patch.label
      next.originalText = patch.label
    } else {
      rebuild = true
    }
  }
  if (rebuild) return null
  return next
}

/**
 * Apply an edit operation to the live element list.
 * @param elements - current live elements.
 * @param op - `{ edits, remove, addNodes, addEdges }`.
 * @param theme - canvas theme.
 * @returns the new element list and what actually changed.
 */
export function applyEdit(elements, op, theme) {
  const live = elements.filter(element => !element.isDeleted)
  const byId = new Map(live.map(element => [element.id, element]))
  const removed = new Set((op.remove ?? []).map(String))
  /** Ids that leave the array only to be re-added under the same id. */
  const rebuilt = new Set()
  const replacements = new Map()
  const extra = []
  /** Per-batch accounting reported back to the agent. */
  const detail = { changed: 0, matched: 0, removed: 0, added: 0 }
  /** Labels that leave the array only because their container is rebuilt. */
  const rebuiltLabels = new Set()
  for (const edit of op.edits ?? []) {
    const element = byId.get(edit.id)
    if (element === undefined) continue
    detail.matched += 1
    const patched = patchElement(element, edit)
    if (patched !== null) {
      replacements.set(element.id, patched)
      detail.changed += 1
      continue
    }
    detail.changed += 1
    // A label change on a container is rebuilt so Excalidraw re-measures it.
    const label = edit.label
    const regenerated = materialize([{
      id: element.id,
      type: element.type === 'rectangle' || element.type === 'ellipse' || element.type === 'diamond' ? element.type : 'rectangle',
      x: typeof edit.x === 'number' ? edit.x : element.x,
      y: typeof edit.y === 'number' ? edit.y : element.y,
      width: typeof edit.width === 'number' ? edit.width : element.width,
      height: typeof edit.height === 'number' ? edit.height : element.height,
      strokeColor: edit.color !== undefined ? (PALETTE[edit.color]?.stroke ?? element.strokeColor) : element.strokeColor,
      backgroundColor: edit.color !== undefined ? (PALETTE[edit.color]?.fill ?? element.backgroundColor) : element.backgroundColor,
      fillStyle: 'solid',
      strokeWidth: 2,
      roughness: 1,
      roundness: element.roundness ?? undefined,
      label: { text: label, strokeColor: '#1e1e1e', fontSize: edit.fontSize ?? 20, fontFamily: 2 },
    }])
    removed.add(element.id)
    rebuilt.add(element.id)
    for (const generated of regenerated) extra.push(generated)
  }
  // A deleted container takes its label with it, and arrows bound to a deleted
  // element go too — but an element rebuilt under the same id keeps its arrows.
  const gone = id => removed.has(id) && !rebuilt.has(id)
  for (const element of live) {
    // A rebuilt container gets a fresh label element, so the old one goes.
    if (element.containerId !== undefined && rebuilt.has(element.containerId)) {
      removed.add(element.id)
      rebuiltLabels.add(element.id)
      continue
    }
    if (element.containerId !== undefined && gone(element.containerId)) removed.add(element.id)
    if (element.startBinding?.elementId !== undefined && gone(element.startBinding.elementId)) removed.add(element.id)
    if (element.endBinding?.elementId !== undefined && gone(element.endBinding.elementId)) removed.add(element.id)
  }
  const kept = []
  for (const element of live) {
    if (removed.has(element.id)) continue
    kept.push(replacements.get(element.id) ?? element)
  }
  const taken = new Set([...kept.map(element => element.id), ...extra.map(element => element.id)])
  if ((op.addNodes ?? []).length > 0 || (op.addEdges ?? []).length > 0) {
    const bounds = boundsOf(kept)
    const offset = bounds === null ? { x: 0, y: 0 } : { x: bounds.maxX + 160, y: bounds.minY }
    extra.push(...materialize(skeletonsOf(
      { nodes: op.addNodes ?? [], edges: op.addEdges ?? [], direction: 'TB' },
      theme,
      offset,
      taken,
    )))
  }
  detail.removed = [...removed].filter(id => !rebuilt.has(id) && !rebuiltLabels.has(id)).length
  detail.added = (op.addNodes ?? []).length + (op.addEdges ?? []).length
  const merged = restoreElements([...kept, ...extra], null, { repairBindings: true, refreshDimensions: true })
  if (op.reroute === true) {
    const repaired = rerouteArrows(merged)
    detail.rerouted = repaired.rerouted
    return { elements: repaired.elements, detail }
  }
  return { elements: merged, detail }
}

/**
 * Recompute every bound arrow of an existing scene so it meets its shapes at
 * their edges, and re-centre the labels of both containers and arrows.
 *
 * Scenes drawn before boundary attachment existed have arrows from centre to
 * centre: the line runs across the label it belongs to. This walks the scene and
 * fixes that in place, without touching anything the user moved.
 * @param elements - live scene elements.
 * @returns the repaired elements and how many arrows were re-attached.
 */
export function rerouteArrows(elements) {
  const byId = new Map(elements.map(element => [element.id, element]))
  const boxes = new Map()
  for (const element of elements) {
    if (element.isDeleted) continue
    if (element.type === 'rectangle' || element.type === 'ellipse' || element.type === 'diamond') {
      boxes.set(element.id, { x: element.x, y: element.y, width: element.width ?? 0, height: element.height ?? 0 })
    }
  }
  const shapeOf = (element) => {
    if (element?.type === 'ellipse') return 'ellipse'
    if (element?.type === 'diamond') return 'diamond'
    if (element?.type === 'text') return 'text'
    return 'rect'
  }
  const labels = new Map()
  for (const element of elements) {
    if (element.type === 'text' && element.containerId !== undefined) labels.set(element.containerId, element)
  }
  let rerouted = 0
  const next = elements.map((element) => {
    if (element.isDeleted) return element
    if (element.type !== 'arrow') {
      // Container labels keep their centre when the box was resized.
      if (labels.has(element.id) === false) return element
      const label = labels.get(element.id)
      if (label === undefined) return element
      return element
    }
    const startId = element.startBinding?.elementId
    const endId = element.endBinding?.elementId
    const startBox = startId === undefined ? undefined : boxes.get(startId)
    const endBox = endId === undefined ? undefined : boxes.get(endId)
    if (startBox === undefined || endBox === undefined) return element
    const from = boundaryPoint(startBox, centreOf(endBox), shapeOf(byId.get(startId)))
    const to = boundaryPoint(endBox, centreOf(startBox), shapeOf(byId.get(endId)))
    rerouted += 1
    return {
      ...element,
      x: from.x,
      y: from.y,
      points: [[0, 0], [to.x - from.x, to.y - from.y]],
      width: Math.abs(to.x - from.x),
      height: Math.abs(to.y - from.y),
    }
  })
  // Arrow labels sit at the midpoint of the new segment.
  const arrows = new Map(next.filter(element => element.type === 'arrow').map(element => [element.id, element]))
  const repaired = next.map((element) => {
    if (element.type !== 'text' || element.containerId === undefined) return element
    const owner = arrows.get(element.containerId)
    if (owner === undefined || !Array.isArray(owner.points) || owner.points.length < 2) return element
    const last = owner.points[owner.points.length - 1]
    const mid = { x: owner.x + last[0] / 2, y: owner.y + last[1] / 2 }
    return {
      ...element,
      x: mid.x - (element.width ?? 0) / 2,
      y: mid.y - (element.height ?? 0) / 2,
    }
  })
  return { elements: repaired, rerouted }
}

/**
 * Materialise image elements whose bytes were already handed to the editor.
 *
 * The file must be in the editor (via `addFiles`) before this runs, or the
 * element has nothing to draw; `materialize` still gives it the same shape a
 * hand-inserted image has, including the restored defaults Excalidraw expects.
 * @param placements - `{ id, fileId, x, y, width, height }`.
 * @returns live elements.
 */
export function imageElements(placements) {
  const skeletons = placements.map(placement => ({
    id: placement.id,
    type: 'image',
    fileId: placement.fileId,
    x: placement.x,
    y: placement.y,
    width: placement.width,
    height: placement.height,
    status: 'saved',
    scale: [1, 1],
    crop: null,
    angle: 0,
    strokeColor: '#1e1e1e',
    backgroundColor: 'transparent',
    fillStyle: 'solid',
    strokeWidth: 1,
    strokeStyle: 'solid',
    roughness: 1,
    opacity: 100,
  }))
  return materialize(skeletons)
}
