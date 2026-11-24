# Excalidraw canvas

An Excalidraw editor docked in the DeepSeek Harness right sidebar. The agent and
the person edit the same `.excalidraw` document: the agent draws through tools,
you drag shapes and retype labels by hand, and each side sees the other's work.

## What it adds

- **A canvas tab in the right sidebar.** Open it from the panel's add control
  (the guide card "Excalidraw 画布"), let the agent open it by drawing, or click
  any `.excalidraw` file: a file link in the conversation and a row in the Files
  tree both open this panel at that document, anywhere in the workspace, instead
  of a text preview.

  Two registrations make that click land here, because a profile may run either
  sidebar. The tab type claims the resource address with
  `patterns: ['dsh-resource://file/**/*.excalidraw', '*.excalidraw']` — the glob
  is matched against the whole address (or the URI path), never a bare basename,
  which is why a plain `*.excalidraw` claims nothing. With
  `dsh-better-sidebar` installed the click is decided by its own file-viewer
  registry instead, so the plugin also registers an `excalidraw` viewer; its
  native-claim probe then hands the address to this panel whenever the tab type
  outranks that sidebar's editor, and the viewer takes over when it does not.
- **Selection → conversation.** The toolbar's send button renders whatever is
  selected (a group counts as all its members, and a connector whose two ends
  are both selected travels with them) to a 2× PNG and hands it to the
  conversation composer as an ordinary pending attachment, so it can be sent
  with a message. DSH's attachment layer listens for drops on `document`, so the
  picture arrives through the same path as a drag; when the composer cannot be
  reached the PNG is copied to the clipboard instead.

  A selection made **only of images** is sent as the original bytes rather than
  re-rendered: a dropped picture keeps its own `files[fileId].dataURL`, so it
  travels at its native resolution and format (png/jpeg/webp/gif — the types DSH
  accepts). Anything else is rasterized at 3×, or 4× on a Shift-click.
- **Five agent tools.** `excalidraw_read` lists canvases and reads a scene as
  nodes and arrows, `excalidraw_draw` draws a diagram from a node/arrow
  description, and `excalidraw_edit` renames, moves, recolors, deletes, and adds
  to an existing canvas. `excalidraw_add_images` embeds png/jpeg/webp/gif files - by workspace
  path or as a conversation attachment - scaling them to one shared height and keeping an
  equal gap, so a set of screenshots reads as one row or grid.
- **One document, one editor.** Both entry points - the agent opening a canvas and
  a file link or the Files tree - open the tab by its `dsh-resource://file/...`
  address, and a tab is keyed by that address. Two different keys for one file
  would mount two editors and each would save it, so the agent's open request
  carries the address and the file viewer hands a stale tab over to the canvas
  tab instead of loading a second copy.
- **Fullscreen from the toolbar.** The 全屏 button asks the right column to take
  over the window - the same pane fullscreen the sidebar's own chrome offers,
  through `sidebarRight.commandTarget()` + `toggleFullscreen`, with
  `layout.openRightbar(true, fullscreen)` as the fallback. Nothing here fakes it
  with a fixed-position overlay, so the native shortcuts and the exit path keep
  working. The toolbar's fit glyph points *in* and this one points *out*, because
  the old corner brackets read as "maximize".
- **A navigator thumbnail.** The pane is narrow, so a wide canvas is easy to get
  lost in. The bottom-right thumbnail draws blocks and polylines only - never the
  real strokes - and rebuilds only when the scene's change stamp moves, so
  following the viewport costs one rectangle. Click or drag inside it to centre
  the editor; the move is applied with `CaptureUpdateAction.NEVER`, so it never
  enters the undo stack. (Borrowed from the Obsidian plugin
  `changxi4848/excalidraw-canvas-optimizer`.)
- **Cheap change detection.** `onChange` fires once per pointer move, and the
  panel used to serialise the whole scene there to decide whether a save was
  due. It now mixes each element's `version`/`versionNonce` into one number
  (constant work per element, no allocation) and only builds the exact
  fingerprint when a save actually happens.
- **Exports are scaled.** `excalidraw_export` writes a PNG or SVG beside the
  document, at 2x by default (1x to 4x through `scale`): Excalidraw draws one
  pixel per scene unit unless it is told otherwise, so a 1x export looks soft.
- **Automatic layout.** The agent describes nodes and arrows; the browser sizes
  boxes from their labels (CJK-aware) and places them in ranked rows or columns,
  then lets Excalidraw bind and route the arrows.
- **Arrows meet the shape, not its centre.** Every endpoint is placed exactly on
  the rectangle, rounded-rectangle, ellipse, or diamond boundary, so a line never
  runs across the label it belongs to. `excalidraw_edit` with `reroute: true`
  applies the same geometry to a scene drawn earlier.
- **Loops are the exception.** A cycle edge leaves the shape towards whichever
  outer side it crosses least, runs down that lane, and turns back in, so it never
  cuts through a box; the ranking ignores it, so a retry arrow cannot drag its
  target to the bottom. The recommended modeling is still to end the branch in a
  node whose label states the action ("提示：格式错误 / 返回重试") — the shipped
  skill says so, and the tool description repeats the short version.
- **A shipped skill.** The Host half registers `excalidraw-diagrams` as a runtime
  skill, so the authoring conventions (no retry loops, diamonds as questions,
  branch labels, draw → export → inspect) reach every agent that has the skill
  registry, without depending on `skill-filesystem` or a skills directory.
- **Two-way editing.** Manual edits autosave about half a second after you stop.
  An agent operation is applied to the live editor and saved the same way.

## Files

Documents live in `excalidraw/` inside the session's working directory — the
project folder DSH shows for that conversation — so a canvas belongs to the
project it describes. Change the folder with the `directory` config field.

```
excalidraw/
  checkout-architecture.excalidraw     the scene, a standard Excalidraw file
  checkout-architecture.png            only after excalidraw_export
```

The `.excalidraw` file is the only source of truth. It opens in excalidraw.com,
the VS Code extension, or Obsidian. Exports are plain PNG/SVG.

## How the two sides talk

The Host half owns the documents and a queue of pending operations. The browser
half polls that queue about once a second, applies each operation through the
Excalidraw API, saves the result, and acknowledges it. An agent draw therefore
reports "drawn" when the panel is open, and "queued" when it is not — the
operation is kept until the canvas is opened.

## Limits

- The panel must be open for the agent's change to appear and for exports; a
  queued change applies as soon as it opens, but nothing is applied in the
  background.
- Mermaid text pasted into Excalidraw's insert dialog is not supported: Mermaid,
  Cytoscape, and KaTeX are left out of the bundle, which saves about 3.4 MiB.
- Scene conflicts are reported, not merged. When another program rewrites the
  file, the panel offers "load the disk version" or "keep my canvas".
- Only straight layered layouts are computed. Ask the agent to move nodes when a
  diagram needs a hand-placed arrangement.
