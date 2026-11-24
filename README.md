# dsh-excalidraw-canvas

[English](README.md) | [中文](README.zh.md)

Excalidraw in the DeepSeek Harness right sidebar, plus agent tools that read and
edit the same canvas you drag by hand. Clicking a `.excalidraw` file — in the
conversation, or in the right panel's Files tree — opens it here.

```
you:  "draw a checkout architecture: web → auth → orders, orders → events → worker"
agent: excalidraw_draw(...)  →  the panel opens and draws it
you:  drag a box, retype a label                       → autosaved
agent: excalidraw_read("checkout")  →  sees your manual edit
agent: excalidraw_add_images([shot-1.png, shot-2.png])  →  a row, equal gaps
agent: excalidraw_edit(rename "auth" to "Auth service")
```

## Install

Requires DeepSeek Harness **0.2.2-rc.5** (declared as `engines.dsh`) and Node
`>=20` to build from source. Nothing is fetched at runtime: the browser bundle is
prebuilt and React comes from the page's module table.

```sh
# Web profile
dsh plugin --profile web add dsh-excalidraw-canvas@latest

# Desktop app profile
dsh plugin --profile desktop add dsh-excalidraw-canvas@latest
```

Then restart DSH and **hard-refresh the browser** (Cmd/Ctrl+Shift+R): the client
bundle id changed from the pre-rename build, so an open tab keeps the old one.

From inside DSH, **Plugins → Add plugin** (the `plugin_manager` tool's
`install_bundle`) accepts the same npm name or a path.

<details>
<summary><strong>Other install routes</strong></summary>

```sh
# Local checkout, live-linked; edit sources, then `npm run build` and re-enable
dsh plugin --profile web add /path/to/dsh-excalidraw-canvas

# A tarball built with `npm pack`
dsh plugin --profile web add ./dsh-excalidraw-canvas-0.1.0.tgz

# Straight from a repository
dsh plugin --profile web add github:you/dsh-excalidraw-canvas
```

`dsh plugin` forwards its arguments to pnpm inside the profile directory, so
`remove`, `update` and the rest work the same way:
`dsh plugin --profile web remove dsh-excalidraw-canvas`.

The bundle row lives in `cordis.patch.yml` (plugin id `excalidraw-canvas`); a
profile's own `cordis.patch.yml` can override its config, for example
`directory: plans` to keep canvases somewhere other than `excalidraw/`.

</details>

## What is in here

| Path | Role |
|---|---|
| `index.js` | Host half: canvas storage, operation queue, HTTP routes, five agent tools |
| `src/client/` | Browser half: the panel, tab-type registration, scene building |
| `lib/client.js` | Built browser bundle (`scripts/build.mjs`) |
| `lib/host-runtime.js` | Vendored `defineTool` + config schema (`scripts/build-host.mjs`) |
| `assets/fonts/` | Excalidraw's handwriting fonts, served by the Host |
| `locale/`, `icon.svg`, `docs/DETAIL.md` | Plugin Manager metadata |
| `skills/excalidraw-diagrams.md` | Authoring guide, registered at runtime as the `excalidraw-diagrams` skill |

## Build

```sh
npm install
npm run build          # client bundle + host runtime
npm run check:layout   # layout maths self-check
npm run check:selection # selection expansion self-check
```

Then install the directory from DSH: **Plugins → Add plugin**, or point
`plugin_manager install_bundle` at this directory. The bundle row lives in
`cordis.patch.yml`.

## Configuration

| Field | Default | Meaning |
|---|---|---|
| `directory` | `excalidraw` | Canvas folder inside the session's working directory |
| `openOnDraw` | `true` | Open the panel when the agent draws |
| `applyTimeoutMs` | `8000` | How long a tool call waits for the open panel to apply |
| `exportTimeoutMs` | `20000` | How long an export waits for the browser to render |

## How the two halves talk

The Host owns the documents and an in-memory queue of pending operations. The
panel polls that queue, applies each operation through the Excalidraw API, saves,
and acknowledges. A tool call reports "drawn" when the panel is open and "queued"
when it is not; a queued operation survives until the canvas is opened.

Canvas files are ordinary `.excalidraw` documents: they open in excalidraw.com,
the VS Code extension, or Obsidian.

## Authoring conventions

Arrows attach to shape edges, and a cycle edge is routed around the outside, but
the readable way to draw a retry is a terminal node whose label states the
action. `skills/excalidraw-diagrams.md` holds the full set — diamonds as
single-line questions, `是`/`否` branch labels, `direction` choice, and the
draw → export → `read_image` inspection loop — and the Host half registers it as
a runtime skill so agents get it automatically.

## Limits

- Nothing is applied in the background; exports need the panel open.
- PNG exports render at 2x by default (the panel button and `excalidraw_export`);
  pass `scale: 1–4` for a different multiplier. A 1x PNG is one pixel per scene
  unit, which is why a hand drawing can look soft.
- Mermaid paste is not bundled (saves ~3.4 MiB); the dialog reports it.
- Conflicts are reported, not merged.
- The package ships Excalidraw's fonts (~16 MB, 209 Xiaolai shards for CJK handwriting): a 14.8 MB tarball buys offline rendering with no network call at draw time.
