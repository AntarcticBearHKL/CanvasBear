# OpenCanvas feature checklist

This checklist tracks the OpenCanvas app. The old browser frontend and the Rust/Slint prototype have been removed; they are no longer references.

Status legend: `[x]` verified in Electron, `[~]` partial, `[ ]` not migrated.

## Global shell

- [~] Frameless window, custom window controls.
- [~] Frosted glass tiers, light/dark theme, opacity/blur settings.
- [~] Settings modal: tabbed shell and Providers/Appearance content; backend behaviors still partial.
- [~] Plugin manager modal: Official/Local/Third-party tabs, URL install records, enable/disable and two-click uninstall; no runtime/execution.
- [ ] Toasts and shared tooltip layer.
- [ ] Data directory + autosave/flush behavior.
- [ ] Typed path prompts for import/export.

## Library

- [x] Project sidebar, canvas table, 44px rows, 40/28/32 columns.
- [x] Create project/canvas, inline rename, duplicate/delete canvas.
- [x] Two-click delete arm/confirm.
- [x] Project and canvas drag reorder.
- [x] Project double-click opens latest canvas.
- [x] New canvas opens editor; new project creates Canvas 1.
- [~] Settings gear opens tabbed Settings modal.
- [ ] Empty states and persistence via Rust-compatible JSON model.

## Canvas Editor

- [x] Side panel shell, dot grid, rulers, sample draggable image cards, floating dock.
- [~] Canvas side panel resize/toggle, canvas rows select/create/move/delete and drag reorder.
- [~] Five built-in node cards, legacy Text card, selection and Smart Canvas → Image Studio route; legacy generation/video nodes missing.
- [~] Dock creation, click/shift selection, drag, source/target handles and basic wires; resize and full validation missing.
- [ ] Bezier wires, wire selection, cut stroke, connection validation.
- [ ] Marquee selection, selection toolbar align/distribute/delete.
- [~] Node hover toolbar shell and Duplicate/Delete actions; layer popover missing.
- [~] Info modal and image preview modal; stack gallery/quick-tool/AI modals missing.
- [~] Attempt Workbench with real OpenRouter image generation through the Electron IPC proxy; trace/cost/video/text workflows missing.
- [~] Canvas Delete/Ctrl+A/Escape and Image Studio tool hotkeys/Ctrl+Z; clipboard/file-drop missing.
- [ ] Generation workflows and persistence.
- [ ] Plugin node rendering and plugin actions.

## Image Studio

- [x] Menu bar, tool rail, board/checkerboard, status bar, right dock shell, floating options, basic brush/eraser/selection/pen.
- [~] Menu shell; PNG export, undo/redo, select all/deselect, grid/rulers/zoom, layer add and panel switching wired.
- [~] All 15 rail tools present; brush/eraser, selection preview, pen/path and eyedropper/bucket basics wired.
- [~] Layers/Properties/Paths panels wired; remaining panels still placeholders.
- [~] Multi-layer canvases with visibility/opacity/16 blend modes/render composite, text layers, masks, rename/reorder and basic FX; groups/full effects missing.
- [~] Channels save/load selection, action recording/save/play, history/assets/color/gradients/patterns/brushes panels, path fill/stroke/selection; full backend still partial.
- [~] Numeric Transform dialog and Free Transform corner/rotate handles (Ctrl+T); skew/distort/perspective/warp handles missing.
- [~] Filter/adjustment dialog with blur, pixelate, noise, brightness, contrast, grayscale and invert applied to the active layer; full catalog missing.
- [~] Image Size/Canvas Size dialogs, rotate 90/180 and crop to selection; trim and arbitrary rotation missing.
- [~] PNG/JPEG/BMP/PSD export and bitmap import into the active layer; PSD import missing.
- [~] Board Settings (ratio/resolution/background), image/canvas size and guides; persistence/opacity application partial.
- [ ] Keyboard shortcuts and rulers/guides.

## Verification

- [~] Library, Canvas and Image Studio screenshots captured during migration; per-screen parity still open.
- [ ] Interaction checklist for every Rust handler.
- [ ] Data round-trip tests.
- [ ] Packaging and launch verification.
