import { useEffect, useMemo, useRef, useState } from "react";
import { writePsd } from "ag-psd";
import type { BlendMode } from "ag-psd";
import { CloseIcon, MaximizeIcon, MinimizeIcon, PencilIcon, PlusIcon, TrashIcon } from "./Icons";
import { FilterGallery } from "./FilterGallery";
import { AIPanel } from "./AIPanel";
import { StudioIcon } from "./StudioIcons";
import { FILTERS, defaultFilterParams, getFilter, type FilterDefinition, type FilterValue } from "../lib/filters";

type Tool =
  | "hand"
  | "pen"
  | "direct-select"
  | "marquee"
  | "ellipse-marquee"
  | "lasso"
  | "polygon-lasso"
  | "wand"
  | "quick-select"
  | "brush"
  | "eraser"
  | "bucket"
  | "gradient"
  | "shape"
  | "eyedropper";

const TOOLS: { id: Tool; label: string }[] = [
  { id: "brush", label: "Brush" },
];

const MENUS: Record<string, { label: string; items: string[] }> = {
  file: { label: "File", items: ["Open Image…", "Export as PNG...", "Export as JPEG...", "Export as BMP...", "Export as PSD..."] },
  edit: { label: "Edit", items: ["Undo", "Redo", "Free Transform", "Numeric Transform…"] },
  image: { label: "Image", items: ["Image Size...", "Canvas Size...", "Rotate 90° CW", "Rotate 90° CCW", "Rotate 180°", "Crop to Selection"] },
  layer: { label: "Layer", items: ["New Layer", "New Text Layer", "Delete Layer"] },
  select: { label: "Select", items: ["All", "Deselect"] },
  filter: { label: "Filter", items: ["AI Studio…", "Filter Gallery…", "Blur", "Sharpen", "Noise", "Distort", "Pixelate", "Stylize", "Artistic", "Brush Strokes", "Sketch", "Texture", "Render", "Other", "Color"] },
  view: { label: "View", items: ["Rulers", "Grid", "Guides", "Clear Guides", "Zoom In", "Zoom Out", "Actual Size", "Fit on Screen"] },
  dock: { label: "Window", items: ["Layers", "Properties", "Paths", "History", "Reset Layout"] },
};

const COLOR_FILTER_IDS: Record<string, string> = {
  "Brightness / Contrast": "brightness-contrast",
  Levels: "levels",
  Curves: "curves",
  Exposure: "exposure",
  Vibrance: "vibrance",
  "Hue / Saturation": "hue-saturation",
  "Color Balance": "color-balance",
  "Black & White": "black-white",
  "Photo Filter": "photo-filter",
  "Channel Mixer": "channel-mixer",
  "Gradient Map": "gradient-map",
  Invert: "invert",
  Posterize: "posterize",
  Threshold: "threshold",
  "Selective Color": "selective-color",
};

type LayerEffect = { id: string; kind: "stroke" | "shadow" | "glow" | "color"; enabled: boolean };
type Layer = { id: string; name: string; visible: boolean; opacity: number; blend: string; effects: LayerEffect[]; text?: string };
type HistorySnapshot = {
  layers: Layer[];
  activeLayer: string;
  boardW: number;
  boardH: number;
  canvases: Record<string, ImageData>;
  masks: Record<string, ImageData>;
};
type PathPoint = { x: number; y: number };

type Props = {
  title: string;
  onHome: () => void;
};

function studioHoldArc(progress: number) {
  const value = Math.min(1, Math.max(0, progress));
  if (value <= 0.001) return "";
  if (value >= 0.999) return "M 26 5 A 21 21 0 1 1 25.99 5";
  const angle = -Math.PI / 2 + Math.PI * 2 * value;
  const x = 26 + 21 * Math.cos(angle);
  const y = 26 + 21 * Math.sin(angle);
  return `M 26 5 A 21 21 0 ${value > 0.5 ? 1 : 0} 1 ${x.toFixed(2)} ${y.toFixed(2)}`;
}

export function ImageStudioScreen({ title, onHome }: Props) {
  const [tool, setTool] = useState<Tool>("brush");
  const [menu, setMenu] = useState("");
  const [menuAnchor, setMenuAnchor] = useState({ left: 0, top: 40 });
  const [studioHold, setStudioHold] = useState<{ x: number; y: number; progress: number } | null>(null);
  const studioHoldRef = useRef<{ startX: number; startY: number; moved: boolean } | null>(null);
  const studioHoldRaf = useRef<number | null>(null);
  const studioHoldStart = useRef(0);
  const [color, setColor] = useState("#d85c3a");
  const [brushSize, setBrushSize] = useState(24);
  const [brushOpacity, setBrushOpacity] = useState(100);
  const [optionsOpen, setOptionsOpen] = useState(false);
  const [layers, setLayers] = useState<Layer[]>([
    { id: "layer-1", name: "Layer 1", visible: true, opacity: 100, blend: "normal", effects: [] },
  ]);
  const [activeLayer, setActiveLayer] = useState("layer-1");
  const [panel, setPanel] = useState("layers");
  const [pathPoints, setPathPoints] = useState<PathPoint[]>([]);
  const [selection, setSelection] = useState<{ x: number; y: number; w: number; h: number; ellipse: boolean } | null>(null);
  const [lassoPoints, setLassoPoints] = useState<{ x: number; y: number }[]>([]);
  const [drawing, setDrawing] = useState(false);
  const [movingSelection, setMovingSelection] = useState<{ x: number; y: number; startX: number; startY: number } | null>(null);
  const [showGrid, setShowGrid] = useState(false);
  const [showRulers, setShowRulers] = useState(false);
  const [zoom, setZoom] = useState(100);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [panning, setPanning] = useState<{ startX: number; startY: number; originX: number; originY: number } | null>(null);
  const [boardW, setBoardW] = useState(640);
  const [boardH, setBoardH] = useState(360);
  const [sizeDialog, setSizeDialog] = useState<{ kind: "image" | "canvas"; width: number; height: number } | null>(null);
  const [transformDialog, setTransformDialog] = useState<{ dx: number; dy: number; scale: number; rotation: number; skew: number } | null>(null);
  const [filterDialog, setFilterDialog] = useState<{ category: string; filterId: string } | null>(null);
  const [freeTransform, setFreeTransform] = useState(false);
  const [boardSettingsOpen, setBoardSettingsOpen] = useState(false);
  const [boardBackground, setBoardBackground] = useState("transparent");
  const [backgroundOpacity, setBackgroundOpacity] = useState(100);
  const [guides, setGuides] = useState<{ x: number[]; y: number[] }>({ x: [], y: [] });
  const [showGuides, setShowGuides] = useState(true);
  const [ftDrag, setFtDrag] = useState<{ mode: string; startX: number; startY: number; snapshot: HTMLCanvasElement } | null>(null);
  const [channels, setChannels] = useState<{ id: string; name: string; selection: { x: number; y: number; w: number; h: number; ellipse: boolean } }[]>([]);
  const [recording, setRecording] = useState(false);
  const [recordedActions, setRecordedActions] = useState<{ menu: string; item: string }[]>([]);
  const [savedActions, setSavedActions] = useState<{ id: string; name: string; actions: { menu: string; item: string }[] }[]>([]);
  const [maskVersion, setMaskVersion] = useState(0);
  const [editingLayer, setEditingLayer] = useState("");
  const [layerDraft, setLayerDraft] = useState("");
  const [aiOpen, setAiOpen] = useState(false);
  const [aiSource, setAiSource] = useState("");
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const importRef = useRef<HTMLInputElement>(null);
  const layerCanvases = useRef<Map<string, HTMLCanvasElement>>(new Map());
  const maskCanvases = useRef<Map<string, HTMLCanvasElement>>(new Map());
  const historyRef = useRef<HistorySnapshot[]>([]);
  const historyIndexRef = useRef(-1);
  const stageRef = useRef<HTMLDivElement>(null);
  const lastPoint = useRef<{ x: number; y: number } | null>(null);
  const dragOrigin = useRef<{ x: number; y: number } | null>(null);
  const zoomRef = useRef(zoom);
  const panRef = useRef(pan);
  zoomRef.current = zoom;
  panRef.current = pan;

  const activeTool = useMemo(() => TOOLS.find((item) => item.id === tool)?.label ?? "Brush", [tool]);

  useEffect(() => {
    setOptionsOpen(tool === "brush" || tool === "eraser" || tool === "marquee" || tool === "ellipse-marquee" || tool === "shape" || tool === "gradient");
  }, [tool]);

  useEffect(() => {
    if (!historyRef.current.length) remember();
  }, []);

  useEffect(() => {
    if (!menu) return;
    const closeOnOutside = (event: PointerEvent) => {
      const target = event.target as Element | null;
      if (target?.closest(".studio-menubar") || target?.closest(".studio-menu-popup")) return;
      setMenu("");
    };
    document.addEventListener("pointerdown", closeOnOutside, true);
    return () => document.removeEventListener("pointerdown", closeOnOutside, true);
  }, [menu]);

  function zoomAt(clientX: number, clientY: number, factor: number) {
    const stage = stageRef.current;
    if (!stage) return;
    const rect = stage.getBoundingClientRect();
    const oldScale = zoomRef.current / 100;
    const nextZoom = Math.max(10, Math.min(800, zoomRef.current * factor));
    const nextScale = nextZoom / 100;
    if (nextScale === oldScale) return;
    const centerX = rect.left + rect.width / 2;
    const centerY = rect.top + rect.height / 2;
    const pointX = (clientX - centerX - panRef.current.x) / oldScale;
    const pointY = (clientY - centerY - panRef.current.y) / oldScale;
    setPan({
      x: clientX - centerX - pointX * nextScale,
      y: clientY - centerY - pointY * nextScale,
    });
    setZoom(nextZoom);
  }

  function zoomBy(factor: number) {
    const stage = stageRef.current;
    if (!stage) return;
    const rect = stage.getBoundingClientRect();
    zoomAt(rect.left + rect.width / 2, rect.top + rect.height / 2, factor);
  }

  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const delta = event.deltaMode === 1 ? event.deltaY * 16 : event.deltaY;
      zoomAt(event.clientX, event.clientY, Math.exp(-delta * 0.0015));
    };
    stage.addEventListener("wheel", onWheel, { passive: false });
    return () => stage.removeEventListener("wheel", onWheel);
  }, []);

  function ensureLayerCanvas(id: string) {
    let layer = layerCanvases.current.get(id);
    if (!layer) {
      layer = document.createElement("canvas");
      layer.width = boardW;
      layer.height = boardH;
      layerCanvases.current.set(id, layer);
    }
    return layer;
  }

  function renderComposite() {
    const canvas = canvasRef.current;
    const context = canvas?.getContext("2d");
    if (!canvas || !context) return;
    context.clearRect(0, 0, canvas.width, canvas.height);
    for (const layer of [...layers].reverse()) {
      if (!layer.visible) continue;
      const source = ensureLayerCanvas(layer.id);
      const mask = maskCanvases.current.get(layer.id);
      let rendered: HTMLCanvasElement = source;
      if (mask) {
        const temp = document.createElement("canvas");
        temp.width = source.width;
        temp.height = source.height;
        const tempContext = temp.getContext("2d");
        if (tempContext) {
          tempContext.drawImage(source, 0, 0);
          tempContext.globalCompositeOperation = "destination-in";
          tempContext.drawImage(mask, 0, 0);
          rendered = temp;
        }
      }
      if (layer.effects.length) {
        const effectCanvas = document.createElement("canvas");
        effectCanvas.width = source.width;
        effectCanvas.height = source.height;
        const effectContext = effectCanvas.getContext("2d");
        if (effectContext) {
          for (const effect of layer.effects) {
            if (!effect.enabled) continue;
            if (effect.kind === "shadow" || effect.kind === "glow") {
              effectContext.save();
              effectContext.shadowColor = effect.kind === "glow" ? "rgba(216,92,58,0.9)" : "rgba(0,0,0,0.45)";
              effectContext.shadowBlur = effect.kind === "glow" ? 18 : 12;
              effectContext.shadowOffsetY = effect.kind === "shadow" ? 6 : 0;
              effectContext.drawImage(rendered, 0, 0);
              effectContext.restore();
            }
          }
          effectContext.drawImage(rendered, 0, 0);
          for (const effect of layer.effects) {
            if (!effect.enabled) continue;
            if (effect.kind === "stroke") {
              effectContext.globalCompositeOperation = "source-atop";
              effectContext.strokeStyle = "#d85c3a";
              effectContext.lineWidth = 4;
              effectContext.strokeRect(2, 2, source.width - 4, source.height - 4);
              effectContext.globalCompositeOperation = "source-over";
            } else if (effect.kind === "color") {
              effectContext.globalCompositeOperation = "source-atop";
              effectContext.fillStyle = "rgba(216,92,58,0.24)";
              effectContext.fillRect(0, 0, source.width, source.height);
              effectContext.globalCompositeOperation = "source-over";
            }
          }
          rendered = effectCanvas;
        }
      }
      context.save();
      context.globalAlpha = layer.opacity / 100;
      const blendMap: Record<string, GlobalCompositeOperation> = {
        normal: "source-over", multiply: "multiply", screen: "screen", overlay: "overlay", add: "lighter",
        darken: "darken", lighten: "lighten", "color-dodge": "color-dodge", "color-burn": "color-burn",
        "hard-light": "hard-light", "soft-light": "soft-light", difference: "difference", exclusion: "exclusion",
        hue: "hue", saturation: "saturation", color: "color", luminosity: "luminosity",
      };
      context.globalCompositeOperation = blendMap[layer.blend] || "source-over";
      context.drawImage(rendered, 0, 0);
      context.restore();
    }
  }

  useEffect(() => {
    ensureLayerCanvas("layer-1");
    renderComposite();
  }, []);

  useEffect(() => {
    renderComposite();
  }, [layers]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    canvas.width = boardW;
    canvas.height = boardH;
    renderComposite();
  }, [boardW, boardH]);

  function resizeBoard(width: number, height: number) {
    const nextWidth = Math.max(1, Math.round(width));
    const nextHeight = Math.max(1, Math.round(height));
    for (const [id, source] of layerCanvases.current) {
      const next = document.createElement("canvas");
      next.width = nextWidth;
      next.height = nextHeight;
      next.getContext("2d")?.drawImage(source, 0, 0);
      layerCanvases.current.set(id, next);
    }
    for (const [id, mask] of maskCanvases.current) {
      const next = document.createElement("canvas");
      next.width = nextWidth;
      next.height = nextHeight;
      next.getContext("2d")?.drawImage(mask, 0, 0);
      maskCanvases.current.set(id, next);
    }
    setBoardW(nextWidth);
    setBoardH(nextHeight);
    setSelection(null);
    setSizeDialog(null);
  }

  function rotateBoard(degrees: number) {
    const radians = (degrees * Math.PI) / 180;
    const nextWidth = degrees === 180 ? boardW : boardH;
    const nextHeight = degrees === 180 ? boardH : boardW;
    for (const [id, source] of layerCanvases.current) {
      const next = document.createElement("canvas");
      next.width = nextWidth;
      next.height = nextHeight;
      const context = next.getContext("2d");
      if (!context) continue;
      context.translate(nextWidth / 2, nextHeight / 2);
      context.rotate(radians);
      context.drawImage(source, -source.width / 2, -source.height / 2);
      layerCanvases.current.set(id, next);
    }
    for (const [id, mask] of maskCanvases.current) {
      const next = document.createElement("canvas");
      next.width = nextWidth;
      next.height = nextHeight;
      const context = next.getContext("2d");
      if (!context) continue;
      context.translate(nextWidth / 2, nextHeight / 2);
      context.rotate(radians);
      context.drawImage(mask, -mask.width / 2, -mask.height / 2);
      maskCanvases.current.set(id, next);
    }
    setBoardW(nextWidth);
    setBoardH(nextHeight);
    setSelection(null);
  }

  function addMask() {
    const mask = document.createElement("canvas");
    mask.width = boardW;
    mask.height = boardH;
    const context = mask.getContext("2d");
    if (!context) return;
    context.fillStyle = "#fff";
    context.fillRect(0, 0, mask.width, mask.height);
    if (selection) {
      context.fillStyle = "#000";
      context.fillRect(0, 0, mask.width, mask.height);
      context.fillStyle = "#fff";
      const left = Math.min(selection.x, selection.x + selection.w);
      const top = Math.min(selection.y, selection.y + selection.h);
      const width = Math.abs(selection.w);
      const height = Math.abs(selection.h);
      if (selection.ellipse) {
        context.beginPath();
        context.ellipse(left + width / 2, top + height / 2, width / 2, height / 2, 0, 0, Math.PI * 2);
        context.fill();
      } else {
        context.fillRect(left, top, width, height);
      }
    }
    maskCanvases.current.set(activeLayer, mask);
    setMaskVersion((value) => value + 1);
    renderComposite();
  }

  function deleteMask() {
    maskCanvases.current.delete(activeLayer);
    setMaskVersion((value) => value + 1);
    renderComposite();
  }

  function moveLayer(direction: number) {
    setLayers((current) => {
      const index = current.findIndex((layer) => layer.id === activeLayer);
      const target = index + direction;
      if (index < 0 || target < 0 || target >= current.length) return current;
      const next = [...current];
      [next[index], next[target]] = [next[target], next[index]];
      return next;
    });
  }

  function createTextLayer() {
    const id = `layer-${Date.now()}`;
    const canvas = ensureLayerCanvas(id);
    const context = canvas.getContext("2d");
    if (context) {
      context.fillStyle = color;
      context.font = "48px 'Baloo 2', sans-serif";
      context.textAlign = "center";
      context.textBaseline = "middle";
      context.fillText("Text", canvas.width / 2, canvas.height / 2);
    }
    setLayers((current) => [...current, { id, name: `Text ${current.length + 1}`, visible: true, opacity: 100, blend: "normal", effects: [], text: "Text" }]);
    setActiveLayer(id);
    setPanel("properties");
  }

  function updateTextLayer(text: string) {
    const canvas = ensureLayerCanvas(activeLayer);
    const context = canvas.getContext("2d");
    if (!context) return;
    context.clearRect(0, 0, canvas.width, canvas.height);
    context.fillStyle = color;
    context.font = "48px 'Baloo 2', sans-serif";
    context.textAlign = "center";
    context.textBaseline = "middle";
    context.fillText(text || "Text", canvas.width / 2, canvas.height / 2);
    setLayers((current) => current.map((layer) => layer.id === activeLayer ? { ...layer, text } : layer));
    remember();
    renderComposite();
  }

  function applyMask() {
    const source = ensureLayerCanvas(activeLayer);
    const mask = maskCanvases.current.get(activeLayer);
    if (!mask) return;
    const context = source.getContext("2d");
    if (!context) return;
    context.globalCompositeOperation = "destination-in";
    context.drawImage(mask, 0, 0);
    context.globalCompositeOperation = "source-over";
    maskCanvases.current.delete(activeLayer);
    setMaskVersion((value) => value + 1);
    remember();
    renderComposite();
  }

  function applyNumericTransform(transform: { dx: number; dy: number; scale: number; rotation: number; skew: number }) {
    const source = ensureLayerCanvas(activeLayer);
    const next = document.createElement("canvas");
    next.width = source.width;
    next.height = source.height;
    const context = next.getContext("2d");
    if (!context) return;
    context.translate(source.width / 2 + transform.dx, source.height / 2 + transform.dy);
    context.rotate((transform.rotation * Math.PI) / 180);
    context.transform(1, 0, Math.tan((transform.skew * Math.PI) / 180), 1, 0, 0);
    context.scale(transform.scale / 100, transform.scale / 100);
    context.drawImage(source, -source.width / 2, -source.height / 2);
    layerCanvases.current.set(activeLayer, next);
    remember();
    renderComposite();
    setTransformDialog(null);
  }

  function beginFreeTransform(event: React.PointerEvent, mode: string) {
    event.stopPropagation();
    const snapshot = document.createElement("canvas");
    snapshot.width = boardW;
    snapshot.height = boardH;
    snapshot.getContext("2d")?.drawImage(ensureLayerCanvas(activeLayer), 0, 0);
    event.currentTarget.setPointerCapture(event.pointerId);
    setFtDrag({ mode, startX: event.clientX, startY: event.clientY, snapshot });
  }

  function moveFreeTransform(event: React.PointerEvent) {
    if (!ftDrag) return;
    const source = ensureLayerCanvas(activeLayer);
    const context = source.getContext("2d");
    if (!context) return;
    const dx = event.clientX - ftDrag.startX;
    const dy = event.clientY - ftDrag.startY;
    context.clearRect(0, 0, source.width, source.height);
    context.save();
    context.translate(source.width / 2 + dx / 2, source.height / 2 + dy / 2);
    if (ftDrag.mode === "rotate") {
      context.rotate(dx / 120);
      context.drawImage(ftDrag.snapshot, -source.width / 2, -source.height / 2);
    } else {
      const scale = Math.max(0.1, 1 + (dx + dy) / 420);
      context.scale(scale, scale);
      context.drawImage(ftDrag.snapshot, -source.width / 2, -source.height / 2);
    }
    context.restore();
    renderComposite();
  }

  function endFreeTransform() {
    if (ftDrag) remember();
    setFtDrag(null);
  }

  function cropToSelection() {
    if (!selection) return;
    const x = Math.max(0, Math.round(Math.min(selection.x, selection.x + selection.w)));
    const y = Math.max(0, Math.round(Math.min(selection.y, selection.y + selection.h)));
    const width = Math.max(1, Math.round(Math.abs(selection.w)));
    const height = Math.max(1, Math.round(Math.abs(selection.h)));
    for (const [id, source] of layerCanvases.current) {
      const next = document.createElement("canvas");
      next.width = width;
      next.height = height;
      next.getContext("2d")?.drawImage(source, x, y, width, height, 0, 0, width, height);
      layerCanvases.current.set(id, next);
    }
    setBoardW(width);
    setBoardH(height);
    setSelection(null);
  }

  function remember(override?: { layers?: Layer[]; activeLayer?: string }) {
    const snapshotLayers = override?.layers ?? layers;
    const snapshotActive = override?.activeLayer ?? activeLayer;
    const snapshot: HistorySnapshot = {
      layers: snapshotLayers.map((layer) => ({ ...layer, effects: layer.effects.map((effect) => ({ ...effect })) })),
      activeLayer: snapshotActive,
      boardW,
      boardH,
      canvases: {},
      masks: {},
    };
    for (const layer of snapshotLayers) {
      const source = ensureLayerCanvas(layer.id);
      const context = source.getContext("2d");
      if (context) snapshot.canvases[layer.id] = context.getImageData(0, 0, source.width, source.height);
    }
    for (const [id, mask] of maskCanvases.current) {
      const context = mask.getContext("2d");
      if (context) snapshot.masks[id] = context.getImageData(0, 0, mask.width, mask.height);
    }
    historyRef.current = historyRef.current.slice(0, historyIndexRef.current + 1);
    historyRef.current.push(snapshot);
    if (historyRef.current.length > 30) historyRef.current.shift();
    historyIndexRef.current = historyRef.current.length - 1;
  }

  function restore(index: number) {
    const snapshot = historyRef.current[index];
    if (!snapshot) return;
    const canvasFor = (id: string) => {
      let source = layerCanvases.current.get(id);
      if (!source) {
        source = document.createElement("canvas");
        layerCanvases.current.set(id, source);
      }
      if (source.width !== snapshot.boardW) source.width = snapshot.boardW;
      if (source.height !== snapshot.boardH) source.height = snapshot.boardH;
      return source;
    };
    for (const layer of snapshot.layers) {
      const source = canvasFor(layer.id);
      const context = source.getContext("2d");
      if (!context) continue;
      context.clearRect(0, 0, source.width, source.height);
      const image = snapshot.canvases[layer.id];
      if (image) context.putImageData(image, 0, 0);
    }
    for (const id of [...maskCanvases.current.keys()]) {
      if (!snapshot.masks[id]) maskCanvases.current.delete(id);
    }
    for (const [id, image] of Object.entries(snapshot.masks)) {
      let mask = maskCanvases.current.get(id);
      if (!mask) {
        mask = document.createElement("canvas");
        maskCanvases.current.set(id, mask);
      }
      if (mask.width !== snapshot.boardW) mask.width = snapshot.boardW;
      if (mask.height !== snapshot.boardH) mask.height = snapshot.boardH;
      mask.getContext("2d")?.putImageData(image, 0, 0);
    }
    setBoardW(snapshot.boardW);
    setBoardH(snapshot.boardH);
    setLayers(snapshot.layers.map((layer) => ({ ...layer, effects: layer.effects.map((effect) => ({ ...effect })) })));
    setActiveLayer(snapshot.activeLayer);
    historyIndexRef.current = index;
  }

  function undo() {
    if (historyIndexRef.current > 0) restore(historyIndexRef.current - 1);
  }

  function redo() {
    if (historyIndexRef.current < historyRef.current.length - 1) restore(historyIndexRef.current + 1);
  }

  function exportImage(format: "png" | "jpeg" | "bmp" = "png") {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const link = document.createElement("a");
    if (format === "bmp") {
      const context = canvas.getContext("2d");
      if (!context) return;
      const image = context.getImageData(0, 0, canvas.width, canvas.height);
      const rowSize = Math.ceil((canvas.width * 3) / 4) * 4;
      const pixelSize = rowSize * canvas.height;
      const buffer = new ArrayBuffer(54 + pixelSize);
      const view = new DataView(buffer);
      view.setUint8(0, 0x42); view.setUint8(1, 0x4d);
      view.setUint32(2, 54 + pixelSize, true);
      view.setUint32(10, 54, true);
      view.setUint32(14, 40, true);
      view.setInt32(18, canvas.width, true);
      view.setInt32(22, canvas.height, true);
      view.setUint16(26, 1, true);
      view.setUint16(28, 24, true);
      view.setUint32(34, pixelSize, true);
      for (let y = 0; y < canvas.height; y += 1) {
        for (let x = 0; x < canvas.width; x += 1) {
          const source = ((canvas.height - 1 - y) * canvas.width + x) * 4;
          const target = 54 + y * rowSize + x * 3;
          view.setUint8(target, image.data[source + 2]);
          view.setUint8(target + 1, image.data[source + 1]);
          view.setUint8(target + 2, image.data[source]);
        }
      }
      link.download = `${title || "OpenCanvas"}.bmp`;
      link.href = URL.createObjectURL(new Blob([buffer], { type: "image/bmp" }));
    } else {
      const extension = format === "jpeg" ? "jpg" : "png";
      link.download = `${title || "OpenCanvas"}.${extension}`;
      link.href = canvas.toDataURL(`image/${format}`, 0.92);
    }
    link.click();
  }

  function exportPsd() {
    const children = [...layers].reverse().map((layer) => ({
      name: layer.name,
      canvas: ensureLayerCanvas(layer.id),
      hidden: !layer.visible,
      opacity: layer.opacity / 100,
      blendMode: (layer.blend === "add" ? "linear dodge" : layer.blend) as BlendMode,
    }));
    const buffer = writePsd({ width: boardW, height: boardH, children });
    const link = document.createElement("a");
    link.download = `${title || "OpenCanvas"}.psd`;
    link.href = URL.createObjectURL(new Blob([buffer], { type: "image/vnd.adobe.photoshop" }));
    link.click();
  }

  function importBitmap(file: File) {
    const image = new Image();
    image.onload = () => {
      const source = ensureLayerCanvas(activeLayer);
      const context = source.getContext("2d");
      if (!context) return;
      const scale = Math.min(source.width / image.width, source.height / image.height);
      const width = image.width * scale;
      const height = image.height * scale;
      context.drawImage(image, (source.width - width) / 2, (source.height - height) / 2, width, height);
      remember();
      renderComposite();
    };
    image.src = URL.createObjectURL(file);
  }

  function loadDataUrlImage(dataUrl: string) {
    return new Promise<HTMLImageElement>((resolve, reject) => {
      const image = new Image();
      image.onload = () => resolve(image);
      image.onerror = () => reject(new Error("无法读取 AI 结果图片"));
      image.src = dataUrl;
    });
  }

  function layerHasPixels(id: string) {
    const layer = ensureLayerCanvas(id);
    const context = layer.getContext("2d");
    if (!context) return false;
    const data = context.getImageData(0, 0, layer.width, layer.height).data;
    for (let index = 3; index < data.length; index += 4) {
      if (data[index] > 0) return true;
    }
    return false;
  }

  function openAIPanel() {
    const layer = ensureLayerCanvas(activeLayer);
    const source = layerHasPixels(activeLayer)
      ? layer.toDataURL("image/png")
      : canvasRef.current?.toDataURL("image/png") || layer.toDataURL("image/png");
    setAiSource(source);
    setAiOpen(true);
  }

  async function addAIImageLayers(
    items: Array<{ name: string; dataUrl: string; visible?: boolean; blend?: string; maskDataUrl?: string }>,
    activeName?: string,
    options?: { hideSource?: boolean },
  ) {
    const sourceId = activeLayer;
    const created: Layer[] = [];
    const stamp = Date.now();
    for (let index = 0; index < items.length; index += 1) {
      const item = items[index];
      try {
        const image = await loadDataUrlImage(item.dataUrl);
        const id = `layer-${stamp}-${index}`;
        const canvas = ensureLayerCanvas(id);
        canvas.width = boardW;
        canvas.height = boardH;
        const context = canvas.getContext("2d");
        if (!context) continue;
        const scale = Math.min(boardW / image.width, boardH / image.height);
        const width = image.width * scale;
        const height = image.height * scale;
        context.drawImage(image, (boardW - width) / 2, (boardH - height) / 2, width, height);
        if (item.maskDataUrl) {
          const maskImage = await loadDataUrlImage(item.maskDataUrl);
          const mask = document.createElement("canvas");
          mask.width = boardW;
          mask.height = boardH;
          const maskContext = mask.getContext("2d");
          if (maskContext) {
            maskContext.drawImage(maskImage, 0, 0, boardW, boardH);
            maskCanvases.current.set(id, mask);
          }
        }
        created.push({
          id,
          name: item.name,
          visible: item.visible !== false,
          opacity: 100,
          blend: item.blend || "normal",
          effects: [],
        });
      } catch {
        // Skip unreadable results, keep the rest.
      }
    }
    if (!created.length) return;
    const insertAt = Math.max(0, layers.findIndex((layer) => layer.id === sourceId));
    const base = layers.map((layer) => (options?.hideSource && layer.id === sourceId ? { ...layer, visible: false } : layer));
    const nextLayers = [...base.slice(0, insertAt), ...created, ...base.slice(insertAt)];
    const nextActive = (activeName ? created.find((layer) => layer.name === activeName) : created[0])?.id ?? created[0].id;
    setLayers(nextLayers);
    setActiveLayer(nextActive);
    setMaskVersion((value) => value + 1);
    setPanel("layers");
    remember({ layers: nextLayers, activeLayer: nextActive });
  }

  const PBR_MAP_ORDER = ["baseColor", "height", "normal", "roughness", "metallic", "ao"];
  const PBR_MAP_LABELS: Record<string, string> = {
    baseColor: "Base Color",
    height: "Height",
    normal: "Normal",
    roughness: "Roughness",
    metallic: "Metallic",
    ao: "AO",
  };

  function openFilterGallery(category = "All", filterId?: string) {
    const pool = category === "All" ? FILTERS : FILTERS.filter((filter) => filter.category === category);
    const selectedId = filterId && pool.some((filter) => filter.id === filterId)
      ? filterId
      : pool[0]?.id || FILTERS[0].id;
    setFilterDialog({ category, filterId: selectedId });
  }

  function applyFilterToLayer(filter: FilterDefinition, params: Record<string, FilterValue>) {
    const source = ensureLayerCanvas(activeLayer);
    const context = source.getContext("2d");
    if (!context) return;
    let x = 0;
    let y = 0;
    let width = source.width;
    let height = source.height;
    if (selection) {
      x = Math.max(0, Math.min(source.width - 1, Math.round(Math.min(selection.x, selection.x + selection.w))));
      y = Math.max(0, Math.min(source.height - 1, Math.round(Math.min(selection.y, selection.y + selection.h))));
      width = Math.max(1, Math.min(source.width - x, Math.round(Math.abs(selection.w))));
      height = Math.max(1, Math.min(source.height - y, Math.round(Math.abs(selection.h))));
    }
    const image = context.getImageData(x, y, width, height);
    context.putImageData(filter.apply(image, params), x, y);
    remember();
    renderComposite();
  }

  function runMenuAction(menuId: string, item: string, replay = false) {
    if (recording && !replay) setRecordedActions((current) => [...current, { menu: menuId, item }]);
    if (menuId === "filter" && item === "AI Studio…") {
      openAIPanel();
      setMenu("");
      return;
    }
    if (menuId === "filter") {
      openFilterGallery(item === "Filter Gallery…" ? "All" : item);
      setMenu("");
      return;
    }
    if (menuId === "file" && item.startsWith("Export as PNG")) exportImage("png");
    else if (menuId === "file" && item === "Open Image…") importRef.current?.click();
    else if (menuId === "file" && item.startsWith("Export as JPEG")) exportImage("jpeg");
    else if (menuId === "file" && item.startsWith("Export as BMP")) exportImage("bmp");
    else if (menuId === "file" && item.startsWith("Export as PSD")) exportPsd();
    else if (menuId === "edit" && item === "Undo") undo();
    else if (menuId === "edit" && item === "Redo") redo();
    else if (menuId === "layer" && item === "New Text Layer") {
      createTextLayer();
    } else if (menuId === "layer" && item === "New Layer") {
      const id = `layer-${layers.length + 1}`;
      setLayers((current) => [...current, { id, name: `Layer ${current.length + 1}`, visible: true, opacity: 100, blend: "normal", effects: [] }]);
      setActiveLayer(id);
    } else if (menuId === "layer" && item === "Delete Layer") {
      if (layers.length <= 1) return;
      const remaining = layers.filter((layer) => layer.id !== activeLayer);
      layerCanvases.current.delete(activeLayer);
      maskCanvases.current.delete(activeLayer);
      setLayers(remaining);
      setActiveLayer(remaining[0].id);
    } else if (menuId === "select" && item === "All") {
      setSelection({ x: 0, y: 0, w: boardW, h: boardH, ellipse: false });
    } else if (menuId === "select" && item === "Deselect") setSelection(null);
    else if (menuId === "view" && item === "Grid") setShowGrid((value) => !value);
    else if (menuId === "view" && item === "Guides") setShowGuides((value) => !value);
    else if (menuId === "view" && item === "Clear Guides") setGuides({ x: [], y: [] });
    else if (menuId === "view" && item === "Rulers") setShowRulers((value) => !value);
    else if (menuId === "view" && item === "Zoom In") zoomBy(1.25);
    else if (menuId === "view" && item === "Zoom Out") zoomBy(0.8);
    else if (menuId === "view" && item === "Actual Size") { setZoom(100); setPan({ x: 0, y: 0 }); }
    else if (menuId === "view" && item === "Fit on Screen") { setZoom(100); setPan({ x: 0, y: 0 }); }
    else if (menuId === "image" && item === "Export PNG...") exportImage("png");
    else if (menuId === "image" && item === "Image Size...") setSizeDialog({ kind: "image", width: boardW, height: boardH });
    else if (menuId === "image" && item === "Canvas Size...") setSizeDialog({ kind: "canvas", width: boardW, height: boardH });
    else if (menuId === "image" && item === "Rotate 90° CW") rotateBoard(90);
    else if (menuId === "image" && item === "Rotate 90° CCW") rotateBoard(-90);
    else if (menuId === "image" && item === "Rotate 180°") rotateBoard(180);
    else if (menuId === "image" && item === "Crop to Selection") cropToSelection();
    else if (menuId === "edit" && item === "Numeric Transform…") {
      setTransformDialog({ dx: 0, dy: 0, scale: 100, rotation: 0, skew: 0 });
    } else if (menuId === "edit" && (item === "Free Transform" || item === "Skew" || item === "Distort" || item === "Perspective" || item === "Warp")) {
      setFreeTransform(true);
    } else if (menuId === "dock") {
      if (item === "Reset Layout") setPanel("layers");
      else setPanel(item.toLowerCase());
    }
    setMenu("");
  }

  function guidePoint(event: React.PointerEvent) {
    const board = stageRef.current?.querySelector(".studio-board")?.getBoundingClientRect();
    if (!board) return null;
    return { x: ((event.clientX - board.left) / board.width) * boardW, y: ((event.clientY - board.top) / board.height) * boardH };
  }

  function selectByColor(point: { x: number; y: number }) {
    const canvas = ensureLayerCanvas(activeLayer);
    const context = canvas.getContext("2d");
    if (!context) return;
    const x = Math.max(0, Math.min(canvas.width - 1, Math.floor(point.x)));
    const y = Math.max(0, Math.min(canvas.height - 1, Math.floor(point.y)));
    const target = context.getImageData(x, y, 1, 1).data;
    const image = context.getImageData(0, 0, canvas.width, canvas.height);
    let minX = canvas.width;
    let minY = canvas.height;
    let maxX = 0;
    let maxY = 0;
    for (let py = 0; py < canvas.height; py += 1) {
      for (let px = 0; px < canvas.width; px += 1) {
        const index = (py * canvas.width + px) * 4;
        const distance = Math.abs(image.data[index] - target[0]) + Math.abs(image.data[index + 1] - target[1]) + Math.abs(image.data[index + 2] - target[2]);
        if (distance <= (brushOpacity / 100) * 120 + 8) {
          minX = Math.min(minX, px); minY = Math.min(minY, py);
          maxX = Math.max(maxX, px); maxY = Math.max(maxY, py);
        }
      }
    }
    if (maxX > minX && maxY > minY) {
      setSelection({ x: minX, y: minY, w: maxX - minX, h: maxY - minY, ellipse: tool === "quick-select" });
    }
  }

  function pathShape() {
    const shape = new Path2D();
    pathPoints.forEach((point, index) => {
      if (index === 0) shape.moveTo(point.x, point.y);
      else shape.lineTo(point.x, point.y);
    });
    return shape;
  }

  function fillPath() {
    if (pathPoints.length < 2) return;
    const context = ensureLayerCanvas(activeLayer).getContext("2d");
    if (!context) return;
    context.fillStyle = color;
    context.fill(pathShape());
    remember();
    renderComposite();
  }

  function strokePath() {
    if (pathPoints.length < 2) return;
    const context = ensureLayerCanvas(activeLayer).getContext("2d");
    if (!context) return;
    context.strokeStyle = color;
    context.lineWidth = Math.max(1, brushSize / 6);
    context.stroke(pathShape());
    remember();
    renderComposite();
  }

  function pathToSelection() {
    if (!pathPoints.length) return;
    const xs = pathPoints.map((point) => point.x);
    const ys = pathPoints.map((point) => point.y);
    const x = Math.min(...xs);
    const y = Math.min(...ys);
    setSelection({ x, y, w: Math.max(1, Math.max(...xs) - x), h: Math.max(1, Math.max(...ys) - y), ellipse: false });
  }

  function pointFromEvent(event: React.PointerEvent) {
    const canvas = canvasRef.current;
    if (!canvas) return { x: 0, y: 0 };
    const rect = canvas.getBoundingClientRect();
    return {
      x: ((event.clientX - rect.left) / rect.width) * canvas.width,
      y: ((event.clientY - rect.top) / rect.height) * canvas.height,
    };
  }

  function paint(point: { x: number; y: number }) {
    const canvas = ensureLayerCanvas(activeLayer);
    const context = canvas.getContext("2d");
    if (!context) return;
    const size = brushSize;
    const alpha = brushOpacity / 100;
    context.save();
    context.globalAlpha = alpha;
    context.globalCompositeOperation = tool === "eraser" ? "destination-out" : "source-over";
    context.fillStyle = color;
    if (lastPoint.current) {
      context.strokeStyle = color;
      context.lineWidth = size;
      context.lineCap = "round";
      context.lineJoin = "round";
      context.beginPath();
      context.moveTo(lastPoint.current.x, lastPoint.current.y);
      context.lineTo(point.x, point.y);
      context.stroke();
    }
    context.beginPath();
    context.arc(point.x, point.y, size / 2, 0, Math.PI * 2);
    context.fill();
    context.restore();
    renderComposite();
  }

  function cancelStudioHold() {
    if (studioHoldRaf.current) cancelAnimationFrame(studioHoldRaf.current);
    studioHoldRaf.current = null;
    studioHoldRef.current = null;
    setStudioHold(null);
  }

  function startStudioHold(event: React.PointerEvent) {
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    studioHoldRef.current = { startX: event.clientX, startY: event.clientY, moved: false };
    studioHoldStart.current = performance.now();
    setStudioHold(null);
    const tick = () => {
      const progress = Math.min(1, (performance.now() - studioHoldStart.current) / 500);
      if (progress >= 0.1) setStudioHold({ x: event.clientX, y: event.clientY, progress });
      if (progress >= 1) {
        cancelStudioHold();
        onHome();
        return;
      }
      studioHoldRaf.current = requestAnimationFrame(tick);
    };
    studioHoldRaf.current = requestAnimationFrame(tick);
  }

  function onPointerDown(event: React.PointerEvent) {
    if (menu) {
      setMenu("");
      return;
    }
    if (event.button === 1) {
      event.preventDefault();
      event.currentTarget.setPointerCapture(event.pointerId);
      setPanning({ startX: event.clientX, startY: event.clientY, originX: pan.x, originY: pan.y });
      return;
    }
    if (event.button === 2) {
      startStudioHold(event);
      return;
    }
    if (event.button !== 0) return;
    if (tool === "brush" || tool === "eraser") {
      event.currentTarget.setPointerCapture(event.pointerId);
      setDrawing(true);
      const point = pointFromEvent(event);
      lastPoint.current = point;
      paint(point);
      return;
    }
    if (tool === "eyedropper") {
      const point = pointFromEvent(event);
      const context = canvasRef.current?.getContext("2d");
      if (!context) return;
      const pixel = context.getImageData(Math.floor(point.x), Math.floor(point.y), 1, 1).data;
      setColor(`#${[pixel[0], pixel[1], pixel[2]].map((v) => v.toString(16).padStart(2, "0")).join("")}`);
      return;
    }
    if (tool === "bucket") {
      const context = ensureLayerCanvas(activeLayer).getContext("2d");
      if (!context) return;
      context.fillStyle = color;
      context.fillRect(0, 0, 640, 360);
      renderComposite();
      remember();
      return;
    }
    if (tool === "pen") {
      const point = pointFromEvent(event);
      setPathPoints((points) => [...points, point]);
      return;
    }
    if (tool === "direct-select") {
      setPathPoints((points) => (points.length ? points : []));
      return;
    }
    if (tool === "lasso") {
      const point = pointFromEvent(event);
      event.currentTarget.setPointerCapture(event.pointerId);
      setDrawing(true);
      setLassoPoints([point]);
      return;
    }
    if (tool === "wand" || tool === "quick-select") {
      selectByColor(pointFromEvent(event));
      return;
    }
    if (tool === "shape" || tool === "gradient") {
      const point = pointFromEvent(event);
      event.currentTarget.setPointerCapture(event.pointerId);
      setDrawing(true);
      dragOrigin.current = point;
      lastPoint.current = point;
      return;
    }
    if (tool === "marquee" || tool === "ellipse-marquee") {
      const point = pointFromEvent(event);
      event.currentTarget.setPointerCapture(event.pointerId);
      if (selection) {
        const left = Math.min(selection.x, selection.x + selection.w);
        const top = Math.min(selection.y, selection.y + selection.h);
        const width = Math.abs(selection.w);
        const height = Math.abs(selection.h);
        const inside = selection.ellipse
          ? ((point.x - (left + width / 2)) / Math.max(1, width / 2)) ** 2 + ((point.y - (top + height / 2)) / Math.max(1, height / 2)) ** 2 <= 1
          : point.x >= left && point.x <= left + width && point.y >= top && point.y <= top + height;
        if (inside) {
          setMovingSelection({ x: selection.x, y: selection.y, startX: point.x, startY: point.y });
          setDrawing(true);
          return;
        }
      }
      setDrawing(true);
      setSelection({ x: point.x, y: point.y, w: 0, h: 0, ellipse: tool === "ellipse-marquee" });
    }
  }

  function onPointerMove(event: React.PointerEvent) {
    if (panning) {
      setPan({
        x: panning.originX + event.clientX - panning.startX,
        y: panning.originY + event.clientY - panning.startY,
      });
      return;
    }
    if (studioHoldRef.current) {
      const hold = studioHoldRef.current;
      if (Math.abs(event.clientX - hold.startX) > 3 || Math.abs(event.clientY - hold.startY) > 3) {
        hold.moved = true;
        cancelStudioHold();
      }
      return;
    }
    if (!drawing) return;
    const point = pointFromEvent(event);
    if (tool === "brush" || tool === "eraser") {
      paint(point);
      lastPoint.current = point;
      return;
    }
    if (tool === "lasso" && lassoPoints.length) {
      const last = lassoPoints[lassoPoints.length - 1];
      if (Math.hypot(point.x - last.x, point.y - last.y) > 2) setLassoPoints((current) => [...current, point]);
      return;
    }
    if ((tool === "shape" || tool === "gradient") && dragOrigin.current) {
      lastPoint.current = point;
      return;
    }
    if (movingSelection) {
      setSelection((current) => current ? { ...current, x: movingSelection.x + (point.x - movingSelection.startX), y: movingSelection.y + (point.y - movingSelection.startY) } : current);
      return;
    }
    if ((tool === "marquee" || tool === "ellipse-marquee") && selection) {
      setSelection({
        ...selection,
        w: point.x - selection.x,
        h: point.y - selection.y,
      });
    }
  }

  function onPointerUp(event: React.PointerEvent) {
    if (panning) {
      if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
      setPanning(null);
      return;
    }
    if (studioHoldRef.current) {
      cancelStudioHold();
      return;
    }
    if (tool === "lasso" && lassoPoints.length > 2) {
      const xs = lassoPoints.map((point) => point.x);
      const ys = lassoPoints.map((point) => point.y);
      const left = Math.min(...xs);
      const top = Math.min(...ys);
      setSelection({ x: left, y: top, w: Math.max(1, Math.max(...xs) - left), h: Math.max(1, Math.max(...ys) - top), ellipse: false });
      setLassoPoints([]);
    }
    if (drawing && dragOrigin.current && lastPoint.current && (tool === "shape" || tool === "gradient")) {
      const source = ensureLayerCanvas(activeLayer);
      const context = source.getContext("2d");
      if (context) {
        const start = dragOrigin.current;
        const end = lastPoint.current;
        if (tool === "gradient") {
          const gradient = context.createLinearGradient(start.x, start.y, end.x, end.y);
          gradient.addColorStop(0, color);
          gradient.addColorStop(1, "rgba(255,255,255,0)");
          context.fillStyle = gradient;
          context.fillRect(0, 0, source.width, source.height);
        } else {
          const left = Math.min(start.x, end.x);
          const top = Math.min(start.y, end.y);
          const width = Math.abs(end.x - start.x);
          const height = Math.abs(end.y - start.y);
          context.fillStyle = color;
          context.fillRect(left, top, width, height);
        }
        remember();
        renderComposite();
      }
      dragOrigin.current = null;
    }
    if (drawing && (tool === "brush" || tool === "eraser")) remember();
    setDrawing(false);
    setMovingSelection(null);
    lastPoint.current = null;
  }

  const selectionBox = selection
    ? {
        left: Math.min(selection.x, selection.x + selection.w),
        top: Math.min(selection.y, selection.y + selection.h),
        width: Math.abs(selection.w),
        height: Math.abs(selection.h),
      }
    : null;

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.target instanceof HTMLInputElement) return;
      if (event.ctrlKey && event.key.toLowerCase() === "t") {
        event.preventDefault();
        setFreeTransform((value) => !value);
        return;
      }
      if (event.ctrlKey && event.key.toLowerCase() === "z") {
        event.preventDefault();
        if (event.shiftKey) redo();
        else undo();
        return;
      }
      if (event.key === "[") setBrushSize((value) => Math.max(1, value - 2));
      if (event.key === "]") setBrushSize((value) => Math.min(200, value + 2));
      const key = event.key.toLowerCase();
      if (key === "b") setTool("brush");
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => () => {
    if (studioHoldRaf.current) cancelAnimationFrame(studioHoldRaf.current);
  }, []);

  const pathD = pathPoints.length
    ? pathPoints.map((point, index) => `${index === 0 ? "M" : "L"} ${point.x} ${point.y}`).join(" ")
    : "";

  return (
    <div className="studio-shell">
      <input
        ref={importRef}
        type="file"
        accept="image/png,image/jpeg,image/webp,image/gif,image/bmp"
        style={{ display: "none" }}
        onChange={(event) => {
          const file = event.target.files?.[0];
          if (file) importBitmap(file);
          event.target.value = "";
        }}
      />
      <header className="studio-menubar" onPointerDown={() => menu && setMenu("")}>
        {Object.entries(MENUS).map(([id, entry]) => (
          <button
            key={id}
            className={`studio-menu-tab${menu === id ? " active" : ""}`}
            onClick={(event) => {
              event.stopPropagation();
              const rect = event.currentTarget.getBoundingClientRect();
              setMenuAnchor({ left: rect.left, top: rect.bottom });
              setMenu(menu === id ? "" : id);
            }}
            onMouseEnter={(event) => {
              if (menu && menu !== id) {
                const rect = event.currentTarget.getBoundingClientRect();
                setMenuAnchor({ left: rect.left, top: rect.bottom });
                setMenu(id);
              }
            }}
          >
            {entry.label}
          </button>
        ))}
        <div className="studio-window-controls">
          <button className="studio-ai-launch" title="Local AI Studio" onClick={openAIPanel}>
            <StudioIcon name="sparkle" size={14} />
            <span>AI Studio</span>
          </button>
          <button className="window-btn" aria-label="最小化" onClick={() => window.openCanvasDesktop?.windowControls?.minimize()}>
            <MinimizeIcon />
          </button>
          <button className="window-btn" aria-label="最大化" onClick={() => window.openCanvasDesktop?.windowControls?.toggleMaximize()}>
            <MaximizeIcon />
          </button>
          <button className="window-btn close" aria-label="关闭" onClick={() => window.openCanvasDesktop?.windowControls?.close()}>
            <CloseIcon />
          </button>
        </div>
      </header>

      {menu ? (
        <div
          className="studio-menu-popup"
          style={{ left: Math.max(8, Math.min(menuAnchor.left, window.innerWidth - 224)), top: menuAnchor.top }}
        >
          {MENUS[menu].items.map((item) => (
            <button key={item} className="studio-menu-item" onClick={() => runMenuAction(menu, item)}>
              <span>{item}</span>
            </button>
          ))}
        </div>
      ) : null}

      <div className="studio-body">
        <aside className="studio-rail">
          {TOOLS.map((item, index) => (
            <div key={item.id} className="studio-tool-wrap">
              {[1, 3, 9, 13, 14].includes(index) ? <span className="studio-rail-rule" /> : null}
              <button
                className={`studio-tool${tool === item.id ? " active" : ""}`}
                aria-label={item.label}
                title={item.label}
                onClick={() => setTool(item.id)}
              >
                <StudioIcon name={item.id} size={15} />
              </button>
            </div>
          ))}
          <div className="studio-rail-spacer" />
          <div className="studio-swatches">
            <span className="swatch-bg" />
            <span className="swatch-fg" style={{ background: color }} />
          </div>
        </aside>

        <main
          className={`studio-stage${panning ? " panning" : ""}`}
          ref={stageRef}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
          onAuxClick={(event) => event.preventDefault()}
        >
          {showRulers ? <div className="studio-ruler studio-ruler-x" onPointerDown={(event) => {
            const point = guidePoint(event);
            if (point) setGuides((current) => ({ ...current, y: [...current.y, point.y] }));
          }} /> : null}
          {showRulers ? <div className="studio-ruler studio-ruler-y" onPointerDown={(event) => {
            const point = guidePoint(event);
            if (point) setGuides((current) => ({ ...current, x: [...current.x, point.x] }));
          }} /> : null}
          <div className="studio-board-wrap">
            <div
              className="studio-board"
              style={{
                aspectRatio: `${boardW} / ${boardH}`,
                backgroundColor: boardBackground === "transparent" ? undefined : boardBackground,
                backgroundImage: boardBackground === "transparent" ? undefined : "none",
                opacity: 1,
                transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom / 100})`,
                transformOrigin: "center center",
              }}
            >
              {showGrid ? <div className="studio-grid-overlay" /> : null}
              {showGuides ? guides.x.map((x) => <div key={`x-${x}`} className="studio-guide studio-guide-v" style={{ left: `${(x / boardW) * 100}%` }} />) : null}
              {showGuides ? guides.y.map((y) => <div key={`y-${y}`} className="studio-guide studio-guide-h" style={{ top: `${(y / boardH) * 100}%` }} />) : null}
              <canvas ref={canvasRef} width={boardW} height={boardH} className="studio-canvas" />
              {freeTransform ? (
                <div className="studio-free-transform" onPointerMove={moveFreeTransform} onPointerUp={endFreeTransform} onPointerCancel={endFreeTransform}>
                  {["nw", "ne", "sw", "se"].map((corner) => <button key={corner} className={`ft-handle ${corner}`} onPointerDown={(event) => beginFreeTransform(event, corner)} />)}
                  <button className="ft-handle rotate" onPointerDown={(event) => beginFreeTransform(event, "rotate")} />
                  <button className="ft-done" onClick={() => setFreeTransform(false)}>Done</button>
                </div>
              ) : null}
              {selectionBox ? (
                <div
                  className={`studio-selection${selection?.ellipse ? " ellipse" : ""}`}
                  style={selectionBox}
                />
              ) : null}
              {lassoPoints.length ? (
                <svg className="studio-path-overlay" viewBox={`0 0 ${boardW} ${boardH}`} preserveAspectRatio="none">
                  <path d={lassoPoints.map((point, index) => `${index === 0 ? "M" : "L"} ${point.x} ${point.y}`).join(" ")} />
                </svg>
              ) : null}
              {pathD ? (
                <svg className="studio-path-overlay" viewBox="0 0 640 360" preserveAspectRatio="none">
                  <path d={pathD} />
                  {pathPoints.map((point, index) => (
                    <rect key={index} x={point.x - 3} y={point.y - 3} width={6} height={6} />
                  ))}
                </svg>
              ) : null}
            </div>
          </div>

          {optionsOpen ? (
            <div className="studio-options">
              <div className="studio-options-head">
                <StudioIcon name={tool} size={15} />
                <strong>{activeTool}</strong>
                <button className="row-icon" aria-label="关闭工具选项" onClick={() => setOptionsOpen(false)}>
                  <CloseIcon />
                </button>
              </div>
              <label className="studio-option-row">
                <span>Size</span>
                <input type="range" min={1} max={200} value={brushSize} onChange={(event) => setBrushSize(Number(event.target.value))} />
                <em>{brushSize} px</em>
              </label>
              <label className="studio-option-row">
                <span>Opacity</span>
                <input type="range" min={0} max={100} value={brushOpacity} onChange={(event) => setBrushOpacity(Number(event.target.value))} />
                <em>{brushOpacity}%</em>
              </label>
            </div>
          ) : null}

          <footer className="studio-status">
            <span>{zoom}%</span>
            <span>{boardW} × {boardH} px</span>
            <span>RGB/8</span>
            <span className="studio-status-tool">{activeTool}</span>
            <span className="studio-status-right">Panels</span>
          </footer>
        </main>

        <aside className="studio-dock">
          <div className="studio-dock-tabs">
            {["layers", "properties", "paths"].map((id) => (
              <button key={id} className={panel === id ? "active" : ""} onClick={() => setPanel(id)}>
                {id[0].toUpperCase() + id.slice(1)}
              </button>
            ))}
          </div>
          {panel === "layers" ? (
            <div className="studio-panel-body">
              <div className="studio-panel-actions">
                <button className="row-icon" aria-label="新建图层" title="新建图层" onClick={() => {
                  const id = `layer-${layers.length + 1}`;
                  ensureLayerCanvas(id);
                  setLayers((current) => [...current, { id, name: `Layer ${current.length + 1}`, visible: true, opacity: 100, blend: "normal", effects: [] }]);
                  setActiveLayer(id);
                }}>
                  <PlusIcon size={14} />
                </button>
                <button className="row-icon" aria-label="删除图层" title="删除图层" onClick={() => {
                  if (layers.length < 2) return;
                  layerCanvases.current.delete(activeLayer);
                  setLayers((current) => current.filter((layer) => layer.id !== activeLayer));
                  setActiveLayer(layers.find((layer) => layer.id !== activeLayer)?.id ?? "");
                }}>
                  <TrashIcon size={14} />
                </button>
              </div>
              {layers.map((layer) => (
                <button
                  key={layer.id}
                  className={`studio-layer-row${layer.id === activeLayer ? " active" : ""}`}
                  onClick={() => setActiveLayer(layer.id)}
                >
                  <span
                    className="studio-eye"
                    onClick={(event) => {
                      event.stopPropagation();
                      setLayers((current) => current.map((item) => item.id === layer.id ? { ...item, visible: !item.visible } : item));
                    }}
                  >
                    {layer.visible ? "◉" : "○"}
                  </span>
                  <span className="studio-layer-thumb" />
                  {editingLayer === layer.id ? (
                    <input
                      autoFocus
                      className="studio-layer-name-input"
                      value={layerDraft}
                      onClick={(event) => event.stopPropagation()}
                      onChange={(event) => setLayerDraft(event.target.value)}
                      onBlur={() => {
                        const name = layerDraft.trim();
                        if (name) setLayers((current) => current.map((item) => item.id === layer.id ? { ...item, name } : item));
                        setEditingLayer("");
                      }}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") {
                          const name = layerDraft.trim();
                          if (name) setLayers((current) => current.map((item) => item.id === layer.id ? { ...item, name } : item));
                          setEditingLayer("");
                        }
                        if (event.key === "Escape") setEditingLayer("");
                      }}
                    />
                  ) : (
                    <span className="studio-layer-name" onDoubleClick={(event) => { event.stopPropagation(); setEditingLayer(layer.id); setLayerDraft(layer.name); }}>{layer.name}</span>
                  )}
                  {maskCanvases.current.has(layer.id) ? <span className="studio-mask-badge">mask</span> : null}
                </button>
              ))}
              <label className="studio-option-row studio-layer-opacity">
                <span>Opacity</span>
                <input type="range" min={0} max={100} value={layers.find((layer) => layer.id === activeLayer)?.opacity ?? 100} onChange={(event) => setLayers((current) => current.map((layer) => layer.id === activeLayer ? { ...layer, opacity: Number(event.target.value) } : layer))} />
                <em>{layers.find((layer) => layer.id === activeLayer)?.opacity ?? 100}%</em>
              </label>
              <div className="studio-blend-row">
                {["normal", "multiply", "screen", "overlay", "add", "darken", "lighten", "color-dodge", "color-burn", "hard-light", "soft-light", "difference", "exclusion", "hue", "saturation", "color", "luminosity"].map((blend) => (
                  <button key={blend} className={layers.find((layer) => layer.id === activeLayer)?.blend === blend ? "active" : ""} onClick={() => setLayers((current) => current.map((layer) => layer.id === activeLayer ? { ...layer, blend } : layer))}>{blend}</button>
                ))}
              </div>
            </div>
          ) : panel === "properties" ? (
            <div className="studio-panel-body">
              <div className="studio-property-row"><span>Name</span><strong>{title}</strong></div>
              <div className="studio-property-row"><span>Width</span><strong>{boardW} px</strong></div>
              <div className="studio-property-row"><span>Height</span><strong>{boardH} px</strong></div>
              <div className="studio-property-row"><span>Color mode</span><strong>RGB/8</strong></div>
              {layers.find((layer) => layer.id === activeLayer)?.text !== undefined ? (
                <label className="studio-text-property">
                  <span>Text</span>
                  <textarea value={layers.find((layer) => layer.id === activeLayer)?.text || ""} onChange={(event) => updateTextLayer(event.target.value)} />
                </label>
              ) : null}
            </div>
          ) : panel === "paths" ? (
            <div className="studio-panel-body">
              <div className="studio-panel-actions">
                <button className="row-icon" aria-label="新建路径" onClick={() => setPathPoints([])}>
                  <PlusIcon size={14} />
                </button>
                <button className="row-icon" aria-label="删除路径" onClick={() => setPathPoints([])}>
                  <TrashIcon size={14} />
                </button>
              </div>
              <div className="studio-path-row">
                <PencilIcon size={13} />
                <span>Path 1</span>
                <span className="studio-path-check">{pathPoints.length ? "✓" : ""}</span>
              </div>
              <div className="studio-path-actions">
                <button onClick={pathToSelection}>Selection</button>
                <button onClick={fillPath}>Fill</button>
                <button onClick={strokePath}>Stroke</button>
              </div>
            </div>
          ) : panel === "history" ? (
            <div className="studio-panel-body">
              {["Open", "New Layer", "Brush", "Filter"].map((label, index) => (
                <div className={`studio-history-row${index === 3 ? " current" : ""}`} key={label}>
                  <span>{index + 1}</span>{label}
                </div>
              ))}
            </div>
          ) : panel === "channels" ? (
            <div className="studio-panel-body">
              {["RGB", "Red", "Green", "Blue"].map((label) => (
                <div className="studio-channel-row" key={label}><span className="studio-eye">◉</span><span>{label}</span></div>
              ))}
              {channels.map((channel) => (
                <div className="studio-channel-row" key={channel.id} onClick={() => setSelection(channel.selection)}>
                  <span className="studio-eye">◉</span><span>{channel.name}</span>
                  <button className="row-icon danger" aria-label="删除通道" onClick={(event) => { event.stopPropagation(); setChannels((current) => current.filter((item) => item.id !== channel.id)); }}><TrashIcon size={12} /></button>
                </div>
              ))}
              <button className="settings-action" type="button" onClick={() => {
                if (!selection) return;
                setChannels((current) => [...current, { id: `channel-${Date.now()}`, name: `Alpha ${current.length + 1}`, selection }]);
              }}>Save selection as channel</button>
            </div>
          ) : panel === "fx" ? (
            <div className="studio-panel-body">
              <div className="studio-fx-add">
                {(["stroke", "shadow", "glow", "color"] as const).map((kind) => (
                  <button key={kind} onClick={() => setLayers((current) => current.map((layer) => layer.id === activeLayer ? { ...layer, effects: [...layer.effects, { id: `fx-${Date.now()}-${kind}`, kind, enabled: true }] } : layer))}>{kind}</button>
                ))}
              </div>
              {(layers.find((layer) => layer.id === activeLayer)?.effects ?? []).map((effect) => (
                <div className="studio-fx-row" key={effect.id}>
                  <button onClick={() => setLayers((current) => current.map((layer) => layer.id === activeLayer ? { ...layer, effects: layer.effects.map((item) => item.id === effect.id ? { ...item, enabled: !item.enabled } : item) } : layer))}>{effect.enabled ? "◉" : "○"}</button>
                  <span>{effect.kind}</span>
                  <button className="row-icon danger" onClick={() => setLayers((current) => current.map((layer) => layer.id === activeLayer ? { ...layer, effects: layer.effects.filter((item) => item.id !== effect.id) } : layer))}><TrashIcon size={12} /></button>
                </div>
              ))}
              {!(layers.find((layer) => layer.id === activeLayer)?.effects.length) ? <div className="settings-note">No layer effects on this layer.</div> : null}
            </div>
          ) : panel === "adjustments" ? (
            <div className="studio-adjustment-grid">
              {["Brightness / Contrast", "Levels", "Curves", "Exposure", "Vibrance", "Hue / Saturation", "Color Balance", "Black & White", "Photo Filter", "Channel Mixer", "Gradient Map", "Invert", "Posterize", "Threshold", "Selective Color"].map((label) => (
                <button key={label} onClick={() => openFilterGallery("Color", COLOR_FILTER_IDS[label])}>{label}</button>
              ))}
            </div>
          ) : panel === "assets" ? (
            <div className="studio-panel-body">
              <input className="studio-search" placeholder="Search assets…" />
              {[["Forest references", "Image Studio"], ["Moodboard", "Canvas"], ["Textures", "Assets folder"]].map(([name, source]) => (
                <div className="studio-asset-row" key={name}><span className="studio-asset-thumb" /><span><strong>{name}</strong><small>{source}</small></span></div>
              ))}
            </div>
          ) : panel === "color" ? (
            <div className="studio-panel-body">
              <div className="studio-color-square" />
              <div className="studio-color-strip" />
              <div className="studio-property-row"><span>Hex</span><strong>{color.toUpperCase()}</strong></div>
              <div className="studio-swatch-row">{[...Array(12)].map((_, index) => <span key={index} style={{ background: ["#d85c3a", "#e7a15e", "#c9c05a", "#5aa56b", "#4d9cae", "#5c7fc7", "#9a6bc0", "#c95e9e", "#26221d", "#6b635a", "#b9ae9f", "#fffefc"][index] }} />)}</div>
            </div>
          ) : panel === "gradients" ? (
            <div className="studio-panel-body">
              {["Foreground to Background", "Warm mist", "Forest light"].map((name) => <div className="studio-gradient-row" key={name}><span className="studio-gradient-strip" /><span>{name}</span></div>)}
            </div>
          ) : panel === "patterns" ? (
            <div className="studio-panel-body"><div className="settings-note">No patterns defined. Make a selection and choose Define Pattern.</div></div>
          ) : panel === "brushes" ? (
            <div className="studio-panel-body">
              {["Soft Round", "Hard Round", "Mist"].map((name) => <div className="studio-brush-row" key={name}><span className="studio-brush-dot" /><span>{name}</span></div>)}
            </div>
          ) : panel === "actions" ? (
            <div className="studio-panel-body">
              <div className="studio-actions-row">
                <button className="settings-action" type="button" onClick={() => setRecording((value) => !value)}>{recording ? "Stop" : "Record"}</button>
                <button className="settings-action" type="button" onClick={() => {
                  if (!recordedActions.length) return;
                  setSavedActions((current) => [...current, { id: `action-${Date.now()}`, name: `Action ${current.length + 1}`, actions: recordedActions }]);
                  setRecordedActions([]);
                }}>Save macro</button>
              </div>
              <div className="settings-note">{recordedActions.length} recorded steps</div>
              {recordedActions.map((action, index) => <div className="studio-history-row" key={index}><span>{index + 1}</span>{action.menu} · {action.item}</div>)}
              {savedActions.map((action) => (
                <div className="studio-action-macro" key={action.id}>
                  <span>{action.name} · {action.actions.length} steps</span>
                  <button onClick={() => action.actions.forEach((entry) => runMenuAction(entry.menu, entry.item, true))}>Play</button>
                  <button className="row-icon danger" onClick={() => setSavedActions((current) => current.filter((item) => item.id !== action.id))}>×</button>
                </div>
              ))}
            </div>
          ) : (
            <div className="studio-panel-body"><div className="settings-note">Panel not migrated yet.</div></div>
          )}
        </aside>
      </div>

      {boardSettingsOpen ? (
        <div className="canvas-modal-backdrop" onClick={() => setBoardSettingsOpen(false)}>
          <div className="board-settings" onClick={(event) => event.stopPropagation()}>
            <header><strong>Board Settings</strong><button className="row-icon" onClick={() => setBoardSettingsOpen(false)}><CloseIcon /></button></header>
            <div className="board-setting-label">Ratio</div>
            <div className="board-ratio-grid">
              {[["16:9", 640, 360], ["1:1", 480, 480], ["9:16", 360, 640], ["4:3", 640, 480], ["3:4", 480, 640], ["3:2", 720, 480], ["2:3", 480, 720], ["21:9", 840, 360], ["2.39:1", 860, 360]].map(([label, width, height]) => (
                <button key={String(label)} onClick={() => resizeBoard(Number(width), Number(height))}>{label}</button>
              ))}
            </div>
            <div className="board-setting-label">Resolution</div>
            <div className="quick-chip-row">
              {["1K", "2K", "4K"].map((label) => <button key={label}>{label}</button>)}
            </div>
            <div className="board-setting-label">Background</div>
            <div className="quick-chip-row">
              {[["transparent", "None"], ["#ffffff", "White"], ["#000000", "Black"], ["custom", "Custom"]].map(([value, label]) => (
                <button key={value} className={boardBackground === value ? "active" : ""} onClick={() => setBoardBackground(value)}>{label}</button>
              ))}
            </div>
            {boardBackground === "custom" ? <input className="studio-search" placeholder="#rrggbb" onChange={(event) => setBoardBackground(event.target.value)} /> : null}
            <label className="studio-option-row"><span>Opacity</span><input type="range" min={0} max={100} value={backgroundOpacity} onChange={(event) => setBackgroundOpacity(Number(event.target.value))} /><em>{backgroundOpacity}%</em></label>
          </div>
        </div>
      ) : null}

      {transformDialog ? (
        <div className="canvas-modal-backdrop" onClick={() => setTransformDialog(null)}>
          <div className="size-dialog" onClick={(event) => event.stopPropagation()}>
            <header><strong>Numeric Transform</strong><button className="row-icon" onClick={() => setTransformDialog(null)}><CloseIcon /></button></header>
            {([["dx", "Move X"], ["dy", "Move Y"], ["scale", "Scale %"], ["rotation", "Rotate °"], ["skew", "Skew °"]] as const).map(([key, label]) => (
              <label className="studio-option-row" key={key}>
                <span>{label}</span>
                <input type="number" value={transformDialog[key]} onChange={(event) => setTransformDialog({ ...transformDialog, [key]: Number(event.target.value) })} />
                <em>{key === "scale" ? "%" : key === "rotation" || key === "skew" ? "°" : "px"}</em>
              </label>
            ))}
            <footer><button onClick={() => setTransformDialog(null)}>Cancel</button><button className="filter-apply" onClick={() => applyNumericTransform(transformDialog)}>Apply</button></footer>
          </div>
        </div>
      ) : null}

      {sizeDialog ? (
        <div className="canvas-modal-backdrop" onClick={() => setSizeDialog(null)}>
          <div className="size-dialog" onClick={(event) => event.stopPropagation()}>
            <header><strong>{sizeDialog.kind === "image" ? "Image Size" : "Canvas Size"}</strong><button className="row-icon" onClick={() => setSizeDialog(null)}><CloseIcon /></button></header>
            <label className="studio-option-row"><span>Width</span><input type="number" min={1} max={8192} value={sizeDialog.width} onChange={(event) => setSizeDialog({ ...sizeDialog, width: Number(event.target.value) })} /><em>px</em></label>
            <label className="studio-option-row"><span>Height</span><input type="number" min={1} max={8192} value={sizeDialog.height} onChange={(event) => setSizeDialog({ ...sizeDialog, height: Number(event.target.value) })} /><em>px</em></label>
            <footer><button onClick={() => setSizeDialog(null)}>Cancel</button><button className="filter-apply" onClick={() => resizeBoard(sizeDialog.width, sizeDialog.height)}>Apply</button></footer>
          </div>
        </div>
      ) : null}

      {aiOpen ? (
        <AIPanel
          source={aiSource}
          onClose={() => setAiOpen(false)}
          onApplyCutout={(foreground, mask) => {
            void addAIImageLayers([{ name: "Cutout", dataUrl: foreground, maskDataUrl: mask }], undefined, { hideSource: true });
            setAiOpen(false);
          }}
          onApplyPBR={(maps) => {
            const items = PBR_MAP_ORDER.filter((key) => maps[key]).map((key) => ({
              name: `PBR ${PBR_MAP_LABELS[key]}`,
              dataUrl: maps[key],
              visible: key === "baseColor",
            }));
            void addAIImageLayers(items, "PBR Base Color");
            setAiOpen(false);
          }}
          onApplySpine={(parts) => {
            void addAIImageLayers(parts.map((part) => ({ name: `Part · ${part.name}`, dataUrl: part.png })), undefined, { hideSource: true });
            setAiOpen(false);
          }}
        />
      ) : null}

      {filterDialog ? (
        <FilterGallery
          source={ensureLayerCanvas(activeLayer)}
          initialCategory={filterDialog.category}
          initialFilterId={filterDialog.filterId}
          onApply={(filter, params) => {
            applyFilterToLayer(filter, params);
            setFilterDialog(null);
          }}
          onClose={() => setFilterDialog(null)}
        />
      ) : null}

      {studioHold ? (
        <div
          className="canvas-hold-ring"
          style={{ left: studioHold.x, top: studioHold.y, "--hold-progress": studioHold.progress } as React.CSSProperties}
          aria-hidden="true"
        >
          <div className="canvas-hold-halo" />
          <svg className="canvas-hold-arc" viewBox="0 0 52 52">
            <circle className="canvas-hold-track" cx="26" cy="26" r="21" />
            <path className="canvas-hold-progress" d={studioHoldArc(studioHold.progress)} />
          </svg>
          <StudioIcon name="home" size={16} className="canvas-hold-home" />
        </div>
      ) : null}
    </div>
  );
}
