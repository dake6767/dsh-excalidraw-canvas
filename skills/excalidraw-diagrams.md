---
name: excalidraw-diagrams
description: Author readable Excalidraw diagrams in the DSH canvas panel with the excalidraw_* tools - layered flow, decision diamonds, retries written as terminal nodes, edge-attached arrows, and the draw/export/inspect loop.
whenToUse: The user asks to draw, sketch, diagram, or update a flow, architecture, sequence, or mind map in the Excalidraw canvas panel, or refers to an existing canvas.
---

# Diagramming with the Excalidraw canvas

The generator lays the diagram out for you: you describe nodes and arrows, it
ranks them, sizes boxes from their labels, and attaches every arrow to a shape
edge. Your job is to describe structure, not coordinates.

## The four tools

| Tool | Use it for |
|---|---|
| `excalidraw_draw` | A new diagram, or a full redraw (`mode: replace`) / addition (`mode: merge`) |
| `excalidraw_read` | Learn the current nodes, ids, labels, and arrows before editing |
| `excalidraw_edit` | Rename, move, recolor, delete, add nodes/arrows, or `reroute: true` to re-attach every arrow |
| `excalidraw_add_images` | Screenshots, photos or exported charts, embedded from a file path or a conversation attachment |
| `excalidraw_export` | PNG or SVG next to the document, for a document or a visual check |

## Rules that keep the picture readable

1. **No retry loops.** A cycle edge is routed around the outside of the diagram
   and reads poorly. Model a retry as the terminal node of that branch and put
   the action in the label:
   - good: `{ id: "fmt_err", label: "提示：格式错误\n返回重试", color: "red" }`
   - avoid: an arrow from `fmt_err` back to `input`
2. **Diamonds are questions.** Only for a yes/no branch, one line, and give it
   room: `shape: "diamond", width: 320, height: 150`. A wrapped two-line label
   in a diamond wastes most of the shape.
3. **Label the branches.** `{ from: "fmt", to: "submit", label: "是" }` and
   `{ from: "fmt", to: "fmt_err", label: "否" }`. Order the "否" edge before the
   "是" edge when the error path should read first.
4. **Let the layout place things.** Send `x`/`y` only when the user asked for a
   specific arrangement, or when a dense diagram needs an error branch nudged
   aside. Send `width`/`height` when a label needs more room than the default.
5. **Direction follows the reading order.** `direction: "TB"` for a process,
   `"LR"` for a pipeline or a request path.
6. **Stay in one language.** Node labels, edge labels, and the title should use
   the user's language; ids stay short ASCII.

7. **Images are placed, not positioned.** Pass file paths (or `attachmentId`
   for an image the user pasted) and let `excalidraw_add_images` pick the
   coordinates: it gives every image the same height, one gap between them, and
   anchors the block below what is already drawn. Use `layout: "grid"` with
   `columns` when one row would be wider than the canvas is tall, and raise
   `height` past the default 420 when the screenshots carry small text.

## Workflow

1. `excalidraw_read` when the canvas may already exist.
2. `excalidraw_draw` with nodes and edges. The panel opens by itself.
3. `excalidraw_export` to PNG, then `read_image` the file to check what a person
   will actually see: overlaps, a cramped diamond, a label that wrapped.
4. Fix with `excalidraw_edit` (by id) rather than redrawing the whole scene,
   unless the structure changed.
5. Leave the `.excalidraw` file in place; it is the deliverable.

## Limits

- A panel that is not open only queues the operation; say so if a tool answers
  "Queued".
- Layout is layered and straight-edged. A diagram that needs hand-placed boxes
  is edited with explicit `x`/`y` in `excalidraw_edit`.
- Mermaid text is not supported by this build.
