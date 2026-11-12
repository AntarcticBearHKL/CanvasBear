# OpenCanvas

The standalone Electron desktop implementation of OpenCanvas. This repository is now the only active implementation.

The old browser frontend and the Rust/Slint desktop prototype have been removed. They are no longer design or code references.

## Current migration slice

- Frameless, rounded Electron window with a CSS gradient glass fallback. Desktop capture is no longer on the startup path.
- Canvas library: project groups, canvas table, rename, duplicate, delete, create, settings.
- Canvas workspace: project sidebar, light-gray dot grid, dynamic rulers, draggable image-node cards, floating dock, window controls.
- Canvas navigation: left-drag pans the canvas, middle-drag or Space+left-drag also pans, right-drag moves the frameless window, wheel zooms at the cursor with CSS zoom for crisp text, `Ctrl+0` reset, `Ctrl+1` fit, shift+left marquee, right-click toggles the project rail, and holding right for 500ms still returns to the library.
- Canvas editing: node select/drag/resize, undo/redo (`Ctrl+Z` / `Ctrl+Shift+Z` / `Ctrl+Y`), add/duplicate/delete, align/distribute.
- Shared design tokens in `src/styles/tokens.css`.
- Image Studio shell with tool rail, menus, canvas, layers/properties/paths dock, tool options and status bar.

## Run

```powershell
cd D:\Dev\opencanvas
npm install
npm run dev
```

## Build and update

```powershell
npm run build
npm run update:desktop
```

`update:desktop` rebuilds the unpacked app, replaces the installed desktop
app's `app.asar` directly, updates the shortcut, and restarts OpenCanvas. No
installer run is required for normal development updates.

## Structure

- `electron/main.cjs` — frameless window, custom `app://` protocol, loopback agent bridge, window controls.
- `electron/preload.cjs` — inert desktop bridge.
- `src/` — React UI; CanvasScreen and ImageStudioScreen are lazy-loaded so the library paints first.
- `src/styles/tokens.css` — design tokens migrated from the Rust theme.
- `src/styles/app.css` — shared flat surfaces, layout and motion.
- `mcp/` — stdio MCP server for the live OpenCanvas canvas.

## MCP

The MCP server drives the running OpenCanvas window through the main-process
bridge on `127.0.0.1:3213` and the renderer's `window.openCanvasAgent` API.
It is registered in opencode as `opencanvas`:

```powershell
cd D:\Dev\opencanvas\mcp
uv sync
uv run opencanvas-mcp
```

Tools include `app_get_state`, `app_apply_ops`, `app_screenshot`, the
`canvas_*` library/node/content tools, and live viewport/selection updates.
The OpenCanvas desktop app must be running.

## Next migration stages

1. Canvas node graph parity: node kinds, connections, context menus, drag/drop, generation cards.
2. Image Studio parity: tools, menus, dock panels, paths/selection, filters, export.
3. Native file dialogs and local project persistence.
