import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { AngleModal, CutoutModal, PBR_ORDER, PBR_LABELS, PBRModal, SegmentModal, UpscaleModal, type NodeAIResultImage, type NodeAIToolId } from "./NodeAIModals";
import { ImageViewer } from "./ImageViewer";
import { PromptEditor } from "./PromptEditor";
import { recordCost, recordLog } from "../lib/runtimeLog";
import { loadStoredCanvas, saveStoredCanvas, saveStoredImage } from "../lib/canvasStore";
import { downscaleDataUrl, rasterizeSvgDataUrl } from "../lib/imageUtils";
import { ensureLocalModels } from "../lib/localModelGate";
import { useArmedDelete } from "../lib/useArmedDelete";
import {
  ArrowDownIcon,
  ArrowUpIcon,
  CanvasIcon,
  CheckIcon,
  ChevronDownIcon,
  CloseIcon,
  FolderIcon,
  MaximizeIcon,
  MinimizeIcon,
  PlusIcon,
  TrashIcon,
} from "./Icons";

type NodeKind = "image" | "image-attempt" | "image-stack" | "assets" | "smart-canvas" | "svg";

type CanvasNode = {
  id: string;
  kind: NodeKind;
  title: string;
  status: string;
  x: number;
  y: number;
  width: number;
  height: number;
  tone: string;
  prompt?: string;
  count?: number;
  svg?: string;
  src?: string;
  originalSrcId?: string;
  originalWidth?: number;
  originalHeight?: number;
  referenceIds?: string[];
  version?: number;
  why?: string;
  model?: string;
  outputFormat?: StillFormat;
  gifMode?: boolean;
  aspect?: string;
  quality?: string;
  complexity?: string;
  frames?: number;
  frameMs?: number;
  generating?: boolean;
  error?: string;
  versions?: GenerationVersion[];
  activeVersion?: number;
};

type GenerationVersion = {
  id: string;
  number: number;
  prompt: string;
  why: string;
  model: string;
  outputFormat: StillFormat;
  gifMode: boolean;
  aspect: string;
  quality: string;
  complexity: string;
  frames: number;
  frameMs: number;
  src?: string;
  originalSrcId?: string;
  originalWidth?: number;
  originalHeight?: number;
  referenceIds?: string[];
  status: string;
  generating?: boolean;
  error?: string;
};

type Wire = { id: string; from: string; to: string };
type CanvasView = { x: number; y: number; k: number };
type CanvasSnapshot = { nodes: CanvasNode[]; wires: Wire[]; selected: string[]; selectedWire: string };
type NodeDrag = {
  id: string;
  startX: number;
  startY: number;
  originX: number;
  originY: number;
  k: number;
  element: HTMLElement;
  width: number;
  height: number;
  dx: number;
  dy: number;
  moved: boolean;
};
type StillFormat = "png" | "jpeg" | "webp";
type ConfigOption = { value: string; label: string };

const ATTEMPT_MODELS: ConfigOption[] = [
  { value: "openai/gpt-image-2.6-sunburst", label: "GPT Image 2.6 Sunburst" },
  { value: "openai/gpt-image-2.6-flare", label: "GPT Image 2.6 Flare" },
  { value: "openai/gpt-5.4-image-2", label: "GPT-5.4 Image 2" },
];

const ATTEMPT_ASPECTS: ConfigOption[] = ["1:1", "3:2", "2:3", "4:3", "3:4", "16:9", "9:16", "21:9", "auto"].map((value) => ({ value, label: value }));
const ATTEMPT_QUALITIES: ConfigOption[] = ["auto", "low", "medium", "high"].map((value) => ({ value, label: value }));
const ATTEMPT_COMPLEXITIES: ConfigOption[] = ["low", "medium", "high"].map((value) => ({ value, label: value }));
const ATTEMPT_FORMATS: ConfigOption[] = [
  { value: "png", label: "PNG" },
  { value: "jpeg", label: "JPEG" },
  { value: "webp", label: "WebP" },
];

function createLegacyVersion(node: CanvasNode): GenerationVersion {
  return {
    id: `v1-${node.id}`,
    number: 1,
    prompt: node.prompt || "",
    why: node.why || "",
    model: node.model || ATTEMPT_MODELS[0].value,
    outputFormat: node.outputFormat || "png",
    gifMode: node.gifMode ?? Boolean(node.src?.startsWith("data:image/gif")),
    aspect: node.aspect || "1:1",
    quality: node.quality || "medium",
    complexity: node.complexity || "medium",
    frames: node.frames ?? 9,
    frameMs: node.frameMs ?? 200,
    src: node.src,
    originalSrcId: node.originalSrcId,
    originalWidth: node.originalWidth,
    originalHeight: node.originalHeight,
    referenceIds: node.referenceIds ?? [],
    status: node.generating ? "错误" : (node.status || "Draft"),
    generating: false,
    error: node.generating ? (node.error || "生成被中断") : node.error,
  };
}

function nodeVersions(node: CanvasNode): GenerationVersion[] {
  return node.versions?.length ? node.versions : [createLegacyVersion(node)];
}

function activeVersionOf(node: CanvasNode): GenerationVersion {
  const versions = nodeVersions(node);
  const index = Math.min(Math.max(0, node.activeVersion ?? 0), versions.length - 1);
  return versions[index];
}

function displayImageFor(node: CanvasNode): GenerationVersion | null {
  const versions = nodeVersions(node);
  const index = Math.min(Math.max(0, node.activeVersion ?? 0), versions.length - 1);
  for (let i = index; i >= 0; i -= 1) {
    if (versions[i].src) return versions[i];
  }
  return null;
}

function summarizeNodeForInfo(node: CanvasNode) {
  return {
    ...node,
    src: node.src ? "[base64 image]" : undefined,
    versions: node.versions?.map((version) => ({
      ...version,
      src: version.src ? "[base64 image]" : undefined,
    })),
  };
}

function describeGenerationError(message: string): string {
  const lower = message.toLowerCase();
  if (lower.includes("maximum cost exceeds your available credits")) {
    return "OpenRouter 预估本次请求的最大成本超过当前可用额度。已自动限制 max_tokens；如仍失败，请降低 quality / GIF 帧数，或给 OpenRouter 充值。";
  }
  if (lower.includes("requires more credits") || lower.includes("fewer max_tokens")) {
    return "OpenRouter 额度不足：请降低 max_tokens、质量或帧数，或给 OpenRouter 充值。";
  }
  return message;
}

function syncVersionFields(node: CanvasNode, version: GenerationVersion): CanvasNode {
  return {
    ...node,
    prompt: version.prompt,
    why: version.why,
    model: version.model,
    outputFormat: version.outputFormat,
    gifMode: version.gifMode,
    aspect: version.aspect,
    quality: version.quality,
    complexity: version.complexity,
    frames: version.frames,
    frameMs: version.frameMs,
    src: version.src,
    originalSrcId: version.originalSrcId,
    originalWidth: version.originalWidth,
    originalHeight: version.originalHeight,
    referenceIds: version.referenceIds ?? [],
    status: version.status,
    generating: version.generating,
    error: version.error,
    version: version.number,
  };
}

function withActiveVersion(node: CanvasNode, patch: Partial<GenerationVersion>): CanvasNode {
  const versions = nodeVersions(node);
  const index = Math.min(Math.max(0, node.activeVersion ?? 0), versions.length - 1);
  const nextVersions = versions.map((version, i) => (i === index ? { ...version, ...patch } : version));
  return syncVersionFields({ ...node, versions: nextVersions, activeVersion: index }, nextVersions[index]);
}

function withVersionPatch(node: CanvasNode, versionId: string, patch: Partial<GenerationVersion>): CanvasNode {
  const versions = nodeVersions(node);
  const nextVersions = versions.map((version) => (version.id === versionId ? { ...version, ...patch } : version));
  const index = Math.min(Math.max(0, node.activeVersion ?? 0), nextVersions.length - 1);
  return syncVersionFields({ ...node, versions: nextVersions, activeVersion: index }, nextVersions[index]);
}

function withActiveVersionIndex(node: CanvasNode, index: number): CanvasNode {
  const versions = nodeVersions(node);
  const nextIndex = Math.min(Math.max(0, index), versions.length - 1);
  return syncVersionFields({ ...node, versions, activeVersion: nextIndex }, versions[nextIndex]);
}

function nextVersionNumber(versions: GenerationVersion[]): number {
  return Math.max(0, ...versions.map((version) => version.number)) + 1;
}

function addVersionToNode(node: CanvasNode, version: GenerationVersion): CanvasNode {
  const versions = [...nodeVersions(node), version];
  return syncVersionFields({ ...node, versions, activeVersion: versions.length - 1 }, version);
}

function isVersionLocked(version: GenerationVersion): boolean {
  return Boolean(version.src) || version.status === "完成";
}

function canEnterVersion(versions: GenerationVersion[], index: number): boolean {
  if (index < 0 || index >= versions.length) return false;
  for (let i = 0; i < index; i += 1) {
    if (!isVersionLocked(versions[i])) return false;
  }
  return true;
}

function canCreateNextVersion(versions: GenerationVersion[], activeIndex: number): boolean {
  const lastIndex = versions.length - 1;
  return activeIndex === lastIndex && isVersionLocked(versions[lastIndex]);
}

const MIN_ZOOM = 0.05;
const MAX_ZOOM = 5;
// The world layer now fills the stage; rulers are screen-space overlays.
const CANVAS_INSET_X = 0;
const CANVAS_INSET_Y = 0;
const DOT_STEP = 26;

const INITIAL_NODES: CanvasNode[] = [];
const INITIAL_WIRES: Wire[] = [];

const NODE_META: Record<NodeKind, { label: string; width: number; height: number; tone: string }> = {
  // Defaults from the Rust `get_node_spec` table.
  "image-attempt": { label: "生成", width: 380, height: 380, tone: "forest-a" },
  image: { label: "Image", width: 340, height: 240, tone: "forest-b" },
  "image-stack": { label: "Image Stack", width: 420, height: 320, tone: "forest-d" },
  assets: { label: "Assets", width: 360, height: 320, tone: "assets" },
  "smart-canvas": { label: "Smart Canvas", width: 420, height: 300, tone: "forest-e" },
  svg: { label: "SVG", width: 420, height: 320, tone: "forest-c" },
};

const LEGACY_NODE_SIZES: Partial<Record<NodeKind, [number, number]>> = {
  "image-attempt": [146, 186],
  image: [124, 150],
  "image-stack": [138, 150],
  assets: [150, 150],
  "smart-canvas": [140, 150],
};

const LEGACY_DEMO_IDS = new Set(["n1", "n2", "n3", "n4", "n5", "n6", "n7", "n8", "n9", "n10"]);
const LEGACY_DEMO_TITLES = new Set([
  "Forest study 01", "Forest study 02", "Moss light", "Canopy", "Shade study",
  "Assets", "Wide forest", "Wide forest 2", "Close study",
]);

function isLegacyDemoNode(node: CanvasNode) {
  return LEGACY_DEMO_IDS.has(node.id) && LEGACY_DEMO_TITLES.has(node.title);
}

function normalizeNodes(nodes: CanvasNode[]): CanvasNode[] {
  // Text nodes were removed from the canvas model. Strip them from older
  // documents instead of rendering an unsupported node kind.
  return nodes
    .filter((node) => String(node.kind) !== "text" && !isLegacyDemoNode(node))
    .map(normalizeNode);
}

function normalizeNode(node: CanvasNode): CanvasNode {
  if (node.kind === "image-attempt" && node.title === "Image Attempt") {
    node = { ...node, title: "生成" };
  }
  if (node.kind === "image-attempt") {
    const cleaned = nodeVersions(node).map((version) =>
      version.generating ? { ...version, generating: false, status: "错误", error: version.error || "生成被中断" } : version,
    );
    // A version can only be followed by another version once it is locked.
    const firstUnlocked = cleaned.findIndex((version) => !isVersionLocked(version));
    const versions = firstUnlocked >= 0 ? cleaned.slice(0, firstUnlocked + 1) : cleaned;
    const index = versions.length - 1;
    node = syncVersionFields({ ...node, versions, activeVersion: index }, versions[index]);
  } else if (node.generating) {
    node = { ...node, generating: false, status: "错误", error: node.error || "生成被中断" };
  }
  if (node.kind === "image-attempt" && !node.src) {
    node = { ...node, width: 380, height: 380 };
  }
  const legacy = LEGACY_NODE_SIZES[node.kind];
  const spec = NODE_META[node.kind];
  if (!legacy || !spec) return node;
  if (node.width === legacy[0] && node.height === legacy[1]) {
    return { ...node, width: spec.width, height: spec.height };
  }
  return node;
}

function isGifSource(src?: string | null) {
  return Boolean(src && (src.startsWith("data:image/gif") || /\.gif(?:[?#]|$)/i.test(src)));
}

const DEFAULT_SVG = [
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 300">',
  '<rect width="400" height="300" fill="#f7f5ef"/>',
  '<circle cx="200" cy="132" r="66" fill="none" stroke="#2f5d50" stroke-width="6"/>',
  '<path d="M110 244h180" stroke="#c96a4a" stroke-width="6" stroke-linecap="round"/>',
  "</svg>",
].join("");

function svgMarkupToDataUrl(markup: string): string {
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(markup)}`;
}

/**
 * A node can feed a generation reference when it has visible media. Image
 * nodes use their raster src; SVG nodes use their markup as a vector preview.
 * The generation step rasterizes both to PNG before calling the model.
 */
function referencePreviewSrc(node: CanvasNode): string | undefined {
  if (node.kind === "image") {
    return node.src && !isGifSource(node.src) ? node.src : undefined;
  }
  if (node.kind === "svg") {
    return node.svg ? svgMarkupToDataUrl(node.svg) : undefined;
  }
  return undefined;
}

function stripInvalidReferences(nodes: CanvasNode[]): CanvasNode[] {
  const invalidIds = new Set<string>();
  for (const node of nodes) {
    if (node.kind === "image" || node.kind === "svg") {
      if (!referencePreviewSrc(node)) invalidIds.add(node.id);
    } else {
      invalidIds.add(node.id);
    }
  }
  if (!invalidIds.size) return nodes;
  return nodes.map((node) => {
    if (node.kind !== "image-attempt" || !node.versions?.length) return node;
    let changed = false;
    const versions = node.versions.map((version) => {
      const references = version.referenceIds ?? [];
      const filtered = references.filter((id) => !invalidIds.has(id));
      let prompt = version.prompt ?? "";
      for (const id of references) {
        if (invalidIds.has(id)) prompt = prompt.split(`[[image:${id}]]`).join("");
      }
      if (filtered.length === references.length && prompt === (version.prompt ?? "")) return version;
      changed = true;
      return { ...version, referenceIds: filtered, prompt };
    });
    if (!changed) return node;
    const index = Math.min(Math.max(0, node.activeVersion ?? 0), versions.length - 1);
    return syncVersionFields({ ...node, versions, activeVersion: index }, versions[index]);
  });
}

/**
 * Drop wires and references that point at nodes the canvas no longer has.
 * Old documents can contain text nodes, which are removed on load.
 */
function stripDanglingLinks(nodes: CanvasNode[], wires: Wire[]): { nodes: CanvasNode[]; wires: Wire[] } {
  const ids = new Set(nodes.map((node) => node.id));
  const cleaned = nodes.map((node) => {
    if (node.kind !== "image-attempt" || !node.versions?.length) return node;
    let changed = false;
    const versions = node.versions.map((version) => {
      const references = version.referenceIds ?? [];
      const filtered = references.filter((id) => ids.has(id));
      if (filtered.length === references.length) return version;
      changed = true;
      let prompt = version.prompt ?? "";
      for (const id of references) {
        if (!ids.has(id)) prompt = prompt.split(`[[image:${id}]]`).join("");
      }
      return { ...version, referenceIds: filtered, prompt };
    });
    if (!changed) return node;
    const index = Math.min(Math.max(0, node.activeVersion ?? 0), versions.length - 1);
    return syncVersionFields({ ...node, versions, activeVersion: index }, versions[index]);
  });
  return {
    nodes: cleaned,
    wires: wires.filter((wire) => ids.has(wire.from) && ids.has(wire.to)),
  };
}

function referenceWirePath(fromX: number, fromY: number, fromWidth: number, fromHeight: number, toX: number, toY: number, toWidth: number, toHeight: number) {
  const x1 = fromX + fromWidth;
  const y1 = fromY + fromHeight / 2;
  const x2 = toX;
  const y2 = toY + toHeight / 2;
  const midX = (x1 + x2) / 2;
  return `M ${x1} ${y1} C ${midX} ${y1}, ${midX} ${y2}, ${x2} ${y2}`;
}

async function prepareCanvasImage(src: string, key: string): Promise<{ src: string; originalSrcId?: string; originalWidth?: number; originalHeight?: number }> {
  // Image nodes hold raster pixels only. Imported or legacy SVG is rasterized
  // first; vector work belongs to a dedicated SVG node.
  const source = src.startsWith("data:image/svg") || /\.svg(?:[?#]|$)/i.test(src)
    ? await rasterizeSvgDataUrl(src)
    : src;
  if (!source || !source.startsWith("data:image/") || source.startsWith("data:image/gif")) {
    return { src: source };
  }
  const asset = await downscaleDataUrl(source);
  if (!asset.downscaled) {
    return { src: asset.src, originalWidth: asset.width, originalHeight: asset.height };
  }
  const originalSrcId = `${key}:original`;
  try {
    await saveStoredImage(originalSrcId, source);
  } catch {
    // The viewer falls back to the capped image if the original cannot be stored.
  }
  return { src: asset.src, originalSrcId, originalWidth: asset.width, originalHeight: asset.height };
}

async function capNodeImages(nodes: CanvasNode[]): Promise<CanvasNode[]> {
  const result: CanvasNode[] = [];
  for (const node of nodes) {
    if (node.kind === "image-attempt" && node.versions?.length) {
      const versions: GenerationVersion[] = [];
      for (const version of node.versions) {
        if (!version.src || version.originalWidth || version.originalSrcId || version.src.startsWith("data:image/gif")) {
          versions.push(version);
          continue;
        }
        const prepared = await prepareCanvasImage(version.src, `${node.id}:${version.id}`);
        versions.push({ ...version, ...prepared });
      }
      const index = Math.min(Math.max(0, node.activeVersion ?? 0), versions.length - 1);
      result.push(syncVersionFields({ ...node, versions, activeVersion: index }, versions[index]));
    } else if (node.kind === "image" && node.src && !node.originalWidth && !node.originalSrcId && !node.src.startsWith("data:image/gif")) {
      const prepared = await prepareCanvasImage(node.src, node.id);
      result.push({ ...node, ...prepared });
    } else {
      result.push(node);
    }
  }
  return result;
}

const HOVER_ICONS: Record<string, string> = {
  info: "info",
  duplicate: "copy",
  cutout: "circle",
  pbr: "layers",
  extract: "image",
  upscale: "maximize",
  segment: "grid",
  angle: "compass",
  delete: "trash",
};

const NodeBody = memo(function NodeBody({ node, onMediaSize }: { node: CanvasNode; onMediaSize?: (id: string, width: number, height: number) => void }) {
  const imageRef = useRef<HTMLImageElement>(null);
  useEffect(() => {
    const image = imageRef.current;
    if (image?.complete && image.naturalWidth > 0) {
      onMediaSize?.(node.id, image.naturalWidth, image.naturalHeight);
    }
  }, [node.id, node.src]);
  if (node.kind === "assets") {
    const hasFiles = Boolean(node.status && !node.status.includes("0"));
    return (
      <div className="node-assets-body">
        <div className="node-assets-head">
          <span>Local folder</span>
          <span className="node-assets-bind">Bind folder</span>
        </div>
        {hasFiles ? (
          <div className="node-assets-list">
            <div><CanvasIcon name="folder-input" size={14} /><span>references</span></div>
            <div><CanvasIcon name="folder-input" size={14} /><span>output</span></div>
            <div><CanvasIcon name="folder-input" size={14} /><span>textures</span></div>
          </div>
        ) : (
          <div className="node-assets-empty">
            <CanvasIcon name="folder-input" size={24} />
            <span>Bind a local folder, then drag its images or videos onto the canvas</span>
          </div>
        )}
      </div>
    );
  }
  if (node.kind === "image-attempt") {
    const version = activeVersionOf(node);
    const imageVersion = displayImageFor(node);
    const displaySrc = imageVersion?.src;
    return (
      <div className={`node-attempt-body${version.generating ? " generating" : ""}`}>
        {displaySrc ? (
          <img
            ref={imageRef}
            className="node-attempt-image"
            src={displaySrc}
            alt=""
            draggable={false}
            onDragStart={(event) => event.preventDefault()}
            onLoad={(event) => onMediaSize?.(node.id, event.currentTarget.naturalWidth, event.currentTarget.naturalHeight)}
          />
        ) : version.generating ? null : (
          <div className="node-empty-media">
            <CanvasIcon name="image" size={34} />
            <span>No image</span>
          </div>
        )}
        {version.generating ? (
          <div className="node-generating-overlay" role="status" aria-live="polite">
            <span className="node-generating-spinner" />
            <span>生成中…</span>
          </div>
        ) : null}
        {!version.generating && version.error ? (
          <div className="node-attempt-error" title={version.error}>{version.error}</div>
        ) : null}
        <span className="node-attempt-version">v{version.number}</span>
      </div>
    );
  }
  if (node.kind === "svg") {
    return (
      <div className={`node-svg-body${node.svg ? " has-svg" : " empty"}`}>
        {node.svg ? (
          <img
            ref={imageRef}
            className="node-svg-image"
            src={svgMarkupToDataUrl(node.svg)}
            alt=""
            draggable={false}
            onDragStart={(event) => event.preventDefault()}
            onLoad={(event) => onMediaSize?.(node.id, event.currentTarget.naturalWidth, event.currentTarget.naturalHeight)}
          />
        ) : (
          <div className="node-empty-media">
            <CanvasIcon name="svg" size={34} />
            <span>No SVG yet</span>
          </div>
        )}
      </div>
    );
  }
  if (node.kind === "image-stack") {
    return (
      <div className={`node-media-body${node.src ? " has-image" : " empty"}`}>
        {node.src ? (
          <img
            className="node-media-image"
            src={node.src}
            alt=""
            draggable={false}
            onDragStart={(event) => event.preventDefault()}
          />
        ) : node.count ? null : (
          <div className="node-empty-media">
            <CanvasIcon name="images" size={24} />
            <span>Drop images here, or generate multiple images</span>
          </div>
        )}
        {node.count ? (
          <span className="node-stack-count"><CanvasIcon name="layers" size={12} />{node.count}</span>
        ) : null}
      </div>
    );
  }
  if (node.kind === "smart-canvas") {
    return (
      <div className={`node-media-body${node.src ? " has-image" : " smart-empty"}`}>
        {node.src ? (
          <img
            className="node-media-image"
            src={node.src}
            alt=""
            draggable={false}
            onDragStart={(event) => event.preventDefault()}
          />
        ) : (
          <div className="node-empty-media"><span>Nothing here yet</span></div>
        )}
        {node.src ? <span className="node-media-label">Studio</span> : null}
      </div>
    );
  }
  return (
    <div className={`node-media-body${node.src ? " has-image" : " empty"}`}>
      {node.src ? (
        <img
          ref={imageRef}
          className="node-media-image"
          src={node.src}
          alt=""
          draggable={false}
          onDragStart={(event) => event.preventDefault()}
          onLoad={(event) => onMediaSize?.(node.id, event.currentTarget.naturalWidth, event.currentTarget.naturalHeight)}
        />
      ) : (
        <div className="node-empty-media">
          <CanvasIcon name="image" size={34} />
          <span>No image yet</span>
        </div>
      )}
    </div>
  );
});

function niceRulerStep(scale: number) {
  const raw = 84 / Math.max(0.05, scale);
  const power = Math.pow(10, Math.floor(Math.log10(raw)));
  const normalized = raw / power;
  return (normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10) * power;
}

function rulerTicks(length: number, offset: number, scale: number, step: number) {
  const first = Math.floor((-offset / scale) / step) * step;
  const last = Math.ceil((length - offset) / scale / step) * step;
  const ticks: Array<{ value: number; pos: number }> = [];
  for (let value = first; value <= last; value += step) {
    const pos = offset + value * scale;
    if (pos >= -60 && pos <= length + 60) ticks.push({ value, pos });
  }
  return ticks;
}

function formatRulerValue(value: number) {
  const rounded = Math.round(value);
  return Math.abs(value - rounded) < 0.01 ? String(rounded) : value.toFixed(1);
}

function ConfigSelect({
  label,
  value,
  options,
  onChange,
  columns = 1,
  disabled = false,
}: {
  label: string;
  value: string;
  options: readonly ConfigOption[];
  onChange: (value: string) => void;
  columns?: number;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [menuStyle, setMenuStyle] = useState<{ left: number; width: number; top?: number; bottom?: number } | null>(null);
  const fieldRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const selected = options.find((option) => option.value === value) ?? options[0];

  useLayoutEffect(() => {
    if (!open) return;
    const updatePosition = () => {
      const field = fieldRef.current;
      if (!field) return;
      const rect = field.getBoundingClientRect();
      const rows = Math.ceil(options.length / columns);
      const menuHeight = Math.min(220, rows * 34 + 8);
      const width = Math.min(rect.width, columns > 1 ? 300 : 280);
      const openUp = window.innerHeight - rect.bottom < menuHeight + 12 && rect.top > menuHeight + 12;
      setMenuStyle({
        left: Math.max(8, Math.min(rect.right - width, window.innerWidth - width - 8)),
        width,
        ...(openUp ? { bottom: window.innerHeight - rect.top + 6 } : { top: rect.bottom + 6 }),
      });
    };
    updatePosition();
    window.addEventListener("resize", updatePosition);
    window.addEventListener("scroll", updatePosition, true);
    return () => {
      window.removeEventListener("resize", updatePosition);
      window.removeEventListener("scroll", updatePosition, true);
    };
  }, [open, options.length, columns]);

  useEffect(() => {
    if (!open) return;
    const closeOnOutside = (event: PointerEvent) => {
      const target = event.target as Node;
      if (fieldRef.current?.contains(target) || menuRef.current?.contains(target)) return;
      setOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setOpen(false);
      triggerRef.current?.focus();
    };
    document.addEventListener("pointerdown", closeOnOutside, true);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOnOutside, true);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [open]);

  useEffect(() => {
    if (disabled) setOpen(false);
  }, [disabled]);

  return (
    <div className={`attempt-config-field${open ? " open" : ""}${disabled ? " disabled" : ""}`} ref={fieldRef} onClick={() => { if (!disabled) setOpen((current) => !current); }}>
      <span>{label}</span>
      <button
        ref={triggerRef}
        type="button"
        className="attempt-select-trigger"
        aria-haspopup="listbox"
        aria-expanded={open}
        disabled={disabled}
        onClick={(event) => {
          event.stopPropagation();
          if (!disabled) setOpen((current) => !current);
        }}
        onKeyDown={(event) => {
          if (event.key !== "ArrowDown") return;
          event.preventDefault();
          if (!disabled) setOpen(true);
        }}
      >
        <span>{selected?.label ?? value}</span>
        <ChevronDownIcon size={12} />
      </button>
      {open && menuStyle ? createPortal(
        <>
          <div className="attempt-select-scrim" onPointerDown={() => setOpen(false)} />
          <div ref={menuRef} className={`attempt-select-menu${columns > 1 ? " grid" : ""}`} role="listbox" aria-label={label} style={menuStyle}>
            {options.map((option) => {
              const active = option.value === value;
              return (
                <button
                  key={option.value}
                  type="button"
                  role="option"
                  aria-selected={active}
                  className={`attempt-select-option${active ? " selected" : ""}`}
                  onClick={() => {
                    onChange(option.value);
                    setOpen(false);
                    triggerRef.current?.focus();
                  }}
                >
                  <span>{option.label}</span>
                  {active ? <CheckIcon size={13} /> : null}
                </button>
              );
            })}
          </div>
        </>,
        document.body,
      ) : null}
    </div>
  );
}

function VersionSwitcher({
  versions,
  activeIndex,
  canCreate,
  onSelect,
  onCreate,
}: {
  versions: GenerationVersion[];
  activeIndex: number;
  canCreate: boolean;
  onSelect: (index: number) => void;
  onCreate: () => void;
}) {
  const safeIndex = Math.min(Math.max(0, activeIndex), Math.max(0, versions.length - 1));
  return (
    <div className="version-switcher">
      <div className="version-switcher-label">
        <CanvasIcon name="layers" size={13} />
        <span>Versions</span>
        <span className="version-count">{versions.length}</span>
      </div>
      <div className="version-tabs" role="tablist" aria-label="Versions">
        {versions.map((version, index) => {
          const accessible = canEnterVersion(versions, index);
          const locked = isVersionLocked(version);
          const isActive = index === safeIndex;
          const status = version.generating
            ? "generating"
            : version.error && !locked
              ? "error"
              : locked
                ? "locked"
                : "draft";
          return (
            <button
              key={version.id}
              type="button"
              role="tab"
              aria-selected={isActive}
              className={`version-tab${isActive ? " active" : ""}`}
              data-status={status}
              disabled={!accessible && !isActive}
              title={accessible ? `v${version.number} · ${version.status}` : "请先锁定前一个版本"}
              onClick={() => onSelect(index)}
            >
              <span className="version-tab-dot" />
              <span>v{version.number}</span>
            </button>
          );
        })}
      </div>
      <button
        type="button"
        className={`version-new${canCreate ? " ready" : ""}`}
        disabled={!canCreate}
        title={canCreate ? "新建版本" : "当前版本锁定后才能新建下一个版本"}
        onClick={onCreate}
      >
        <PlusIcon size={13} />
        <span>New version</span>
      </button>
    </div>
  );
}

type SidebarCanvas = { id: string; name: string };

type Props = {
  canvasId: string;
  title: string;
  canvases: SidebarCanvas[];
  onSelectCanvas: (canvas: SidebarCanvas) => void;
  onCreateCanvas: () => void;
  onDeleteCanvas: (id: string) => void;
  onMoveCanvas: (id: string, direction: number) => void;
  onHome: () => void;
  onOpenSettings: () => void;
  onOpenStudio: (title: string) => void;
};

export function CanvasScreen({
  canvasId,
  title,
  canvases,
  onSelectCanvas,
  onCreateCanvas,
  onDeleteCanvas,
  onMoveCanvas,
  onHome,
  onOpenSettings,
  onOpenStudio,
}: Props) {
  const storageKey = `open-canvas:electron-canvas:${canvasId}`;
  const [nodes, setNodes] = useState<CanvasNode[]>(() => {
    try {
      const raw = localStorage.getItem(storageKey);
      const nodes = raw ? (JSON.parse(raw) as { nodes: CanvasNode[] }).nodes : INITIAL_NODES;
      return normalizeNodes(nodes);
    } catch {
      return INITIAL_NODES;
    }
  });
  const [wires, setWires] = useState<Wire[]>(() => {
    try {
      const raw = localStorage.getItem(storageKey);
      // Node input/output connections are intentionally disabled.
      return [];
    } catch {
      return INITIAL_WIRES;
    }
  });
  const [selected, setSelected] = useState<string[]>([]);
  const [selectedWire, setSelectedWire] = useState("");
  const [zOrder, setZOrder] = useState<string[]>(() => {
    const ids = nodes.map((node) => node.id);
    try {
      const raw = localStorage.getItem(`${storageKey}:z`);
      const stored = raw ? (JSON.parse(raw) as string[]) : undefined;
      if (Array.isArray(stored)) {
        const valid = stored.filter((id) => typeof id === "string" && ids.includes(id));
        return [...valid, ...ids.filter((id) => !valid.includes(id))];
      }
    } catch {
      // Fall back to the node order.
    }
    return ids;
  });
  const [resize, setResize] = useState<{ id: string; startX: number; startY: number; width: number; height: number; k: number; moved: boolean } | null>(null);
  const [sidebarWidth, setSidebarWidth] = useState(280);
  const [sidebarVisible, setSidebarVisible] = useState(true);
  const [sidebarDragCanvas, setSidebarDragCanvas] = useState("");
  const [sidebarDrag, setSidebarDrag] = useState<{ startX: number; width: number } | null>(null);
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const [referenceDropTargetId, setReferenceDropTargetId] = useState<string | null>(null);
  const referenceDropTargetRef = useRef<string | null>(null);
  const [wireDraftFrom, setWireDraftFrom] = useState<string | null>(null);
  const wireDraftFromRef = useRef<string | null>(null);
  const wireDraftPathRef = useRef<SVGPathElement>(null);
  const [activeTool, setActiveTool] = useState("select");
  const { armed: armedCanvasDelete, requestDelete: requestCanvasDelete } = useArmedDelete();
  const [viewer, setViewer] = useState<{ title: string; src?: string; srcId?: string; width?: number; height?: number } | null>(null);
  const [svgEditor, setSvgEditor] = useState<{ id: string; svg: string } | null>(null);
  const [info, setInfo] = useState<CanvasNode | null>(null);
  const [infoJson, setInfoJson] = useState(false);
  const [layerPopover, setLayerPopover] = useState<string | null>(null);
  const [attempt, setAttempt] = useState<CanvasNode | null>(null);
  const [attemptPrompt, setAttemptPrompt] = useState("");
  const [attemptWhy, setAttemptWhy] = useState("");
  const [attemptModel, setAttemptModel] = useState<string>(ATTEMPT_MODELS[0].value);
  const [attemptFormat, setAttemptFormat] = useState<StillFormat>("png");
  const [attemptGif, setAttemptGif] = useState(false);
  const [attemptAspect, setAttemptAspect] = useState("1:1");
  const [attemptQuality, setAttemptQuality] = useState("medium");
  const [attemptComplexity, setAttemptComplexity] = useState("medium");
  const [attemptFrames, setAttemptFrames] = useState(9);
  const [attemptFrameMs, setAttemptFrameMs] = useState(200);
  const [attemptError, setAttemptError] = useState("");

  function loadVersionFields(version: GenerationVersion) {
    setAttemptPrompt(version.prompt);
    setAttemptWhy(version.why);
    setAttemptModel(version.model);
    setAttemptFormat(version.outputFormat);
    setAttemptGif(version.gifMode);
    setAttemptAspect(version.aspect);
    setAttemptQuality(version.quality);
    setAttemptComplexity(version.complexity || "medium");
    setAttemptFrames(version.frames);
    setAttemptFrameMs(version.frameMs);
    setAttemptError("");
  }

  function saveAttemptConfig(patch: Partial<GenerationVersion>) {
    if (!attempt) return;
    const id = attempt.id;
    const apply = (node: CanvasNode) => withActiveVersion(node, patch);
    setAttempt((current) => (current ? apply(current) : current));
    setNodes((current) => current.map((node) => (node.id === id ? apply(node) : node)));
  }

  async function referenceUrlsFor(prompt: string, referenceIds: string[] = []): Promise<string[]> {
    const markerIds = Array.from(prompt.matchAll(/\[\[image:([^\]]+)\]\]/g)).map((match) => match[1]);
    const ids = Array.from(new Set([...referenceIds, ...markerIds]));
    const urls = await Promise.all(
      ids.map(async (id) => {
        const node = nodesRef.current.find((item) => item.id === id);
        if (!node) return null;
        const preview = referencePreviewSrc(node);
        // SVG references are vector data; rasterize them because the image
        // generation API only accepts PNG/JPEG/WebP/GIF inputs.
        return preview ? rasterizeSvgDataUrl(preview) : null;
      }),
    );
    return urls.filter((url): url is string => Boolean(url));
  }

  async function runGeneration() {
    const target = attempt;
    if (!target) return;
    const targetVersion = activeVersionOf(target);
    if (targetVersion.generating || targetVersion.src || targetVersion.status === "完成") return;
    const targetVersionId = targetVersion.id;
    setAttemptError("");
    let key = "";
    try {
      const keys = JSON.parse(localStorage.getItem("open-canvas:electron-api-keys:v1") || "{}") as Record<string, string>;
      key = keys.openrouter || "";
    } catch {
      key = "";
    }
    if (!key) {
      setAttemptError("OpenRouter API key required. Add one in Settings before generating.");
      return;
    }
    // Close the workbench immediately; progress is shown on the node itself.
    setAttempt(null);
    setNodes((current) => current.map((node) => (node.id === target.id ? withVersionPatch(node, targetVersionId, { status: "生成中", generating: true, error: undefined }) : node)));
    setAttempt((current) => (current && current.id === target.id ? withVersionPatch(current, targetVersionId, { status: "生成中", generating: true, error: undefined }) : current));
    try {
      const frameCount = Math.max(2, Math.min(16, Math.round(attemptFrames)));
      const frameDuration = Math.max(20, Math.min(2000, Math.round(attemptFrameMs)));
      const outputFormat = attemptGif ? "gif" : attemptFormat;
      // OpenRouter estimates a request's maximum cost from max_tokens. Leaving it
      // unset makes the estimate use the model's full completion budget, which can
      // exceed the account's in-flight credit budget even when credits remain.
      const maxTokens = attemptGif ? Math.min(16384, Math.max(8192, frameCount * 1024)) : 8192;
      const rawPrompt = attemptPrompt || targetVersion.prompt || "";
      const promptText = rawPrompt.replace(/\[\[image:[^\]]+\]\]/g, " ").replace(/\s+/g, " ").trim();
      const referenceUrls = await referenceUrlsFor(rawPrompt, targetVersion.referenceIds ?? []);
      const body: Record<string, unknown> = {
        model: attemptModel,
        prompt: promptText || (referenceUrls.length ? "根据参考图生成" : "Describe the image"),
        n: 1,
        quality: attemptQuality,
        aspect_ratio: attemptAspect,
        output_format: outputFormat,
        max_tokens: maxTokens,
      };
      if (attemptModel.startsWith("openai/gpt-image-2.6")) {
        body.provider = {
          options: {
            openai: { complexity: attemptComplexity },
          },
        };
      }
      if (attemptGif) {
        body.frame_count = frameCount;
        body.frame_duration_ms = frameDuration;
      }
      if (referenceUrls.length) {
        body.input_references = referenceUrls.map((url) => ({ type: "image_url", image_url: { url } }));
      }
      let payload: { data?: Array<{ b64_json?: string; media_type?: string; url?: string }>; images?: typeof payload.data; results?: typeof payload.data; error?: { message?: string } };
      if (window.openCanvasDesktop?.generateImage) {
        const result = await window.openCanvasDesktop.generateImage({ key, body });
        payload = JSON.parse(result.body);
        if (!result.ok) throw new Error(payload?.error?.message || `Request failed (${result.status})`);
      } else {
        const response = await fetch("https://openrouter.ai/api/v1/images", {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
          body: JSON.stringify(body),
        });
        payload = await response.json();
        if (!response.ok) throw new Error(payload?.error?.message || `Request failed (${response.status})`);
      }
      const item = (payload.data || payload.images || payload.results || [])[0];
      const fallbackType = outputFormat === "gif" ? "image/gif" : outputFormat === "jpeg" ? "image/jpeg" : outputFormat === "webp" ? "image/webp" : "image/png";
      const src = item?.b64_json ? `data:${item.media_type || fallbackType};base64,${item.b64_json}` : item?.url;
      if (!src) throw new Error("The provider returned no image");
      const prepared = await prepareCanvasImage(src, `${target.id}:${targetVersionId}`);
      recordLog("info", "generation", "Attempt image generated", `model=${attemptModel} format=${outputFormat} aspect=${attemptAspect} quality=${attemptQuality}`);
      recordCost(attemptModel, 0.04);
      setNodes((current) => current.map((node) => (node.id === target.id ? withVersionPatch(node, targetVersionId, { status: "完成", ...prepared, generating: false, error: undefined }) : node)));
      setAttempt((current) => (current && current.id === target.id ? withVersionPatch(current, targetVersionId, { status: "完成", ...prepared, generating: false, error: undefined }) : current));
    } catch (error) {
      const message = describeGenerationError(error instanceof Error ? error.message : "Generation failed");
      recordLog("error", "generation", "Attempt generation failed", message);
      setNodes((current) => current.map((node) => (node.id === target.id ? withVersionPatch(node, targetVersionId, { status: "错误", generating: false, error: message }) : node)));
      setAttempt((current) => (current && current.id === target.id ? withVersionPatch(current, targetVersionId, { status: "错误", generating: false, error: message }) : current));
    }
  }

  function selectAttemptVersion(index: number) {
    if (!attempt) return;
    const versions = nodeVersions(attempt);
    if (!canEnterVersion(versions, index)) return;
    const clamped = Math.min(Math.max(0, index), versions.length - 1);
    const version = versions[clamped];
    setAttempt(withActiveVersionIndex(attempt, clamped));
    setNodes((current) => current.map((node) => (node.id === attempt.id ? withActiveVersionIndex(node, clamped) : node)));
    loadVersionFields(version);
  }

  function createAttemptVersion() {
    if (!attempt) return;
    const versions = nodeVersions(attempt);
    const activeIndex = Math.min(Math.max(0, attempt.activeVersion ?? 0), versions.length - 1);
    if (!canCreateNextVersion(versions, activeIndex)) return;
    const current = versions[versions.length - 1];
    const number = nextVersionNumber(versions);
    const version: GenerationVersion = {
      id: `v${number}-${Date.now()}`,
      number,
      prompt: current.prompt,
      why: current.why,
      model: current.model,
      outputFormat: current.outputFormat,
      gifMode: current.gifMode,
      aspect: current.aspect,
      quality: current.quality,
      complexity: current.complexity || "medium",
      referenceIds: current.referenceIds ?? [],
      frames: current.frames,
      frameMs: current.frameMs,
      src: undefined,
      status: "Draft",
      generating: false,
      error: undefined,
    };
    setAttempt(addVersionToNode(attempt, version));
    setNodes((currentNodes) => currentNodes.map((node) => (node.id === attempt.id ? addVersionToNode(node, version) : node)));
    loadVersionFields(version);
  }

  const [aiDialog, setAiDialog] = useState<{ id: NodeAIToolId; node: CanvasNode } | null>(null);
  const [stack, setStack] = useState<CanvasNode | null>(null);
  const [marquee, setMarquee] = useState<{ x: number; y: number; w: number; h: number; additive: boolean } | null>(null);
  const [view, setView] = useState<CanvasView>(() => {
    try {
      const raw = localStorage.getItem(`${storageKey}:view`);
      const stored = raw ? (JSON.parse(raw) as Partial<CanvasView>) : null;
      if (stored && Number.isFinite(stored.x) && Number.isFinite(stored.y) && Number.isFinite(stored.k)) {
        return {
          x: stored.x as number,
          y: stored.y as number,
          k: Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, stored.k as number)),
        };
      }
    } catch {
      // Fall back to the default view.
    }
    return { x: 0, y: 0, k: 1 };
  });
  const viewRef = useRef(view);
  viewRef.current = view;
  const [panning, setPanning] = useState(false);
  const panRef = useRef<{ startX: number; startY: number; viewX: number; viewY: number; moved: boolean; button: number } | null>(null);
  const windowDragRef = useRef<{ startScreenX: number; startScreenY: number; moved: boolean; button: number; watchRaf?: number } | null>(null);
  const [spaceHeld, setSpaceHeld] = useState(false);
  const [backHold, setBackHold] = useState<{ x: number; y: number; progress: number } | null>(null);
  const backHoldRaf = useRef<number | null>(null);
  const backHoldStart = useRef(0);
  const [zoomBadge, setZoomBadge] = useState(false);
  const zoomBadgeTimer = useRef<number | null>(null);
  const [historyStats, setHistoryStats] = useState({ undo: 0, redo: 0 });
  const historyRef = useRef<CanvasSnapshot[]>([]);
  const futureRef = useRef<CanvasSnapshot[]>([]);
  const dragSnapshotRef = useRef<CanvasSnapshot | null>(null);
  const resizeSnapshotRef = useRef<CanvasSnapshot | null>(null);
  const nodeDragRef = useRef<NodeDrag | null>(null);
  const hoverBarRef = useRef<HTMLDivElement>(null);
  const dragMovedRef = useRef(false);
  const resizeMovedRef = useRef(false);
  const stageRef = useRef<HTMLElement>(null);
  const dotLayerRef = useRef<HTMLDivElement>(null);
  const worldRef = useRef<HTMLDivElement>(null);
  const [stageSize, setStageSize] = useState({ width: 1200, height: 800 });
  const [storageReady, setStorageReady] = useState(false);
  const [processingImages, setProcessingImages] = useState(0);
  const nodesRef = useRef(nodes);
  nodesRef.current = nodes;
  const wiresRef = useRef(wires);
  wiresRef.current = wires;
  const persistDataRef = useRef({ canvasId, nodes, wires, storageKey });
  persistDataRef.current = { canvasId, nodes, wires, storageKey };
  const persistTimerRef = useRef<number | null>(null);
  const persistIdleRef = useRef<number | null>(null);

  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const update = () => setStageSize({ width: stage.clientWidth, height: stage.clientHeight });
    update();
    const observer = new ResizeObserver(update);
    observer.observe(stage);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    let cancelled = false;
    setStorageReady(false);
    void (async () => {
      try {
        const stored = await loadStoredCanvas(canvasId);
        if (cancelled) return;
        if (stored) {
          const normalized = Array.isArray(stored.nodes) ? normalizeNodes(stored.nodes as CanvasNode[]) : [];
          const capped = await capNodeImages(normalized);
          const cleaned = stripInvalidReferences(capped);
          if (cancelled) return;
          const linked = stripDanglingLinks(
            cleaned,
            Array.isArray(stored.wires) ? (stored.wires as Wire[]) : [],
          );
          setNodes(linked.nodes);
          setWires(linked.wires);
          setSelected([]);
          setSelectedWire("");
          if (Array.isArray(stored.nodes) && stored.nodes.length) {
            localStorage.removeItem(storageKey);
          }
        } else {
          const initialNodes = nodesRef.current;
          const initialWires = wiresRef.current;
          if (initialNodes.length) {
            const capped = await capNodeImages(initialNodes);
            const cleaned = stripInvalidReferences(capped);
            if (cancelled) return;
            setNodes(cleaned);
            await saveStoredCanvas(canvasId, { nodes: cleaned, wires: initialWires });
            if (cancelled) return;
            localStorage.removeItem(storageKey);
          }
        }
      } catch {
        // Keep the localStorage fallback if IndexedDB is unavailable.
      } finally {
        if (!cancelled) setStorageReady(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [canvasId, storageKey]);

  useEffect(() => {
    if (!storageReady) return;
    const clearScheduled = () => {
      if (persistTimerRef.current !== null) {
        window.clearTimeout(persistTimerRef.current);
        persistTimerRef.current = null;
      }
      if (persistIdleRef.current !== null) {
        (window as any).cancelIdleCallback?.(persistIdleRef.current);
        persistIdleRef.current = null;
      }
    };
    const save = () => {
      // A save can be scheduled before a drag/pan starts. Keep retrying until
      // the interaction ends so large image payloads never serialize mid-drag.
      if (nodeDragRef.current || panRef.current || resize) {
        persistTimerRef.current = window.setTimeout(save, 300);
        return;
      }
      const latest = persistDataRef.current;
      // Generation nodes mirror their active version's image into node.src.
      // Drop that duplicate from storage; normalizeNode restores it on load.
      const storedNodes = latest.nodes.map((node) => (node.versions?.length ? { ...node, src: undefined } : node));
      void (async () => {
        try {
          await saveStoredCanvas(latest.canvasId, { nodes: storedNodes, wires: latest.wires });
          // IndexedDB is the source of truth; remove the old localStorage copy.
          localStorage.removeItem(latest.storageKey);
        } catch {
          const writeFallback = (nodesToStore: CanvasNode[]) => {
            try {
              localStorage.setItem(latest.storageKey, JSON.stringify({ nodes: nodesToStore, wires: latest.wires }));
              return true;
            } catch {
              return false;
            }
          };
          if (writeFallback(storedNodes)) return;
          try {
            // If version history exceeds the localStorage quota, keep the active image and drop older image payloads.
            const slimNodes = storedNodes.map((node) => {
              if (node.kind !== "image-attempt" || !node.versions?.length) return node;
              const active = Math.min(Math.max(0, node.activeVersion ?? 0), node.versions.length - 1);
              return {
                ...node,
                versions: node.versions.map((version, index) => (index === active ? version : { ...version, src: undefined })),
              };
            });
            writeFallback(slimNodes);
          } catch {
            // Keep the canvas in memory if even the slim payload cannot be stored.
          }
        }
      })();
    };
    const start = () => {
      const idle = (window as any).requestIdleCallback as ((cb: () => void, opts?: { timeout: number }) => number) | undefined;
      if (idle) persistIdleRef.current = idle(save, { timeout: 1200 });
      else save();
    };
    persistTimerRef.current = window.setTimeout(start, 260);
    return clearScheduled;
  }, [canvasId, storageKey, nodes, wires, resize, storageReady]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      try {
        localStorage.setItem(`${storageKey}:z`, JSON.stringify(zOrder));
      } catch {
        // Ignore storage failures; z-order is session state first.
      }
    }, 200);
    return () => window.clearTimeout(timer);
  }, [storageKey, zOrder]);

  useEffect(() => {
    try {
      // Small payload; write immediately so switching canvases never loses the
      // latest view even if the component unmounts right away.
      localStorage.setItem(`${storageKey}:view`, JSON.stringify(view));
    } catch {
      // View persistence is best-effort.
    }
  }, [storageKey, view]);

  useEffect(() => {
    if (!attempt && !svgEditor) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setAttempt(null);
      setSvgEditor(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [attempt, svgEditor]);

  useEffect(() => {
    (window as any).openCanvasLive = {
      canvasId,
      nodes,
      wires,
      selected,
      selectedWire,
      view,
      stageSize,
      runAiTool: runAgentAi,
      generateImage: runAgentGenerateImage,
    };
  }, [canvasId, nodes, wires, selected, selectedWire, view, stageSize]);

  useEffect(() => {
    let cancelled = false;
    const onProject = (event: Event) => {
      const detail = (event as CustomEvent).detail;
      if (detail?.canvasId !== canvasId || !detail.project) return;
      pushHistory();
      const rawNodes = Array.isArray(detail.project.nodes) ? normalizeNodes(detail.project.nodes) : [];
      const rawWires = Array.isArray(detail.project.wires) ? (detail.project.wires as Wire[]) : [];
      void (async () => {
        const capped = await capNodeImages(rawNodes);
        if (cancelled) return;
        const cleaned = stripInvalidReferences(capped);
        const linked = stripDanglingLinks(cleaned, rawWires);
        setNodes(linked.nodes);
        setWires(linked.wires);
        setSelected([]);
        setSelectedWire("");
      })();
    };
    const onSelect = (event: Event) => {
      const ids = (event as CustomEvent).detail?.ids;
      if (Array.isArray(ids)) {
        const next = ids.filter((id) => typeof id === "string");
        setSelected(next);
        const last = next[next.length - 1];
        if (last) focusNode(last);
      }
    };
    const onViewport = (event: Event) => {
      const viewport = (event as CustomEvent).detail;
      if (viewport && Number.isFinite(viewport.x) && Number.isFinite(viewport.y) && Number.isFinite(viewport.k)) {
        setView({ x: viewport.x, y: viewport.y, k: Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, viewport.k)) });
      }
    };
    window.addEventListener("open-canvas:agent-project", onProject);
    window.addEventListener("open-canvas:agent-select", onSelect);
    window.addEventListener("open-canvas:agent-viewport", onViewport);
    return () => {
      cancelled = true;
      window.removeEventListener("open-canvas:agent-project", onProject);
      window.removeEventListener("open-canvas:agent-select", onSelect);
      window.removeEventListener("open-canvas:agent-viewport", onViewport);
      if ((window as any).openCanvasLive?.canvasId === canvasId) delete (window as any).openCanvasLive;
    };
  }, [canvasId, nodes, wires, selected, selectedWire]);

  useEffect(() => {
    setZOrder((current) => {
      const ids = new Set(nodes.map((node) => node.id));
      const kept = current.filter((id) => ids.has(id));
      const added = nodes.filter((node) => !kept.includes(node.id)).map((node) => node.id);
      if (kept.length === current.length && added.length === 0) return current;
      return [...kept, ...added];
    });
  }, [nodes]);

  const selectedNodes = useMemo(() => nodes.filter((node) => selected.includes(node.id)), [nodes, selected]);
  const zIndexById = useMemo(() => new Map(zOrder.map((id, index) => [id, index + 1])), [zOrder]);
  const referenceWires = useMemo(() => {
    const result: Array<{ id: string; from: string; to: string; path: string }> = [];
    for (const target of nodes) {
      if (target.kind !== "image-attempt") continue;
      const version = activeVersionOf(target);
      for (const fromId of version.referenceIds ?? []) {
        const from = nodes.find((node) => node.id === fromId);
        if (!from || !referencePreviewSrc(from)) continue;
        result.push({
          id: `${fromId}->${target.id}`,
          from: fromId,
          to: target.id,
          path: referenceWirePath(from.x, from.y, from.width, from.height, target.x, target.y, target.width, target.height),
        });
      }
    }
    return result;
  }, [nodes]);
  const primary = selectedNodes[0];
  const hovered = nodes.find((node) => node.id === hoveredId) ?? primary;
  const hoverActions: Array<[string, string]> = !hovered
    ? []
    : hovered.kind === "image-attempt"
      ? [
          ["duplicate", "Duplicate"],
          ...(displayImageFor(hovered)?.src ? [["extract", "Add as Image"] as [string, string]] : []),
          ["cutout", "AI Cutout"],
          ["pbr", "PBR"],
          ["upscale", "Upscale"],
          ["segment", "Segment"],
          ["angle", "Angle"],
          ["delete", "Delete"],
        ]
      : [
          ["info", "Info"],
          ["duplicate", "Duplicate"],
          ["cutout", "AI Cutout"],
          ["pbr", "PBR"],
          ["upscale", "Upscale"],
          ["segment", "Segment"],
          ["angle", "Angle"],
          ["delete", "Delete"],
        ];

  useEffect(() => {
    const drag = nodeDragRef.current;
    if (!drag) return;
    updateReferenceWiresForNode(drag.id, drag.originX + drag.dx, drag.originY + drag.dy);
  }, [referenceDropTargetId]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement || event.target instanceof HTMLSelectElement) return;
      if ((event.key === "Delete" || event.key === "Backspace") && (selected.length || selectedWire)) {
        event.preventDefault();
        deleteSelection();
      }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "z") {
        event.preventDefault();
        if (event.shiftKey) redoCanvas();
        else undoCanvas();
      }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "y") {
        event.preventDefault();
        redoCanvas();
      }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "a") {
        event.preventDefault();
        setSelected(nodes.map((node) => node.id));
      }
      if ((event.ctrlKey || event.metaKey) && event.key === "0") {
        event.preventDefault();
        resetView();
      }
      if ((event.ctrlKey || event.metaKey) && event.key === "1") {
        event.preventDefault();
        fitView();
      }
      if (event.key === "Escape") {
        setSelected([]);
        setSelectedWire("");
        setInfo(null);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [nodes, selected, selectedWire]);

  useEffect(() => {
    const isEditable = (target: EventTarget | null) =>
      target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.code === "Space" && !isEditable(event.target)) {
        event.preventDefault();
        setSpaceHeld(true);
      }
    };
    const onKeyUp = (event: KeyboardEvent) => {
      if (event.code === "Space") setSpaceHeld(false);
    };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
    };
  }, []);

  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? 100 : 1;
      applyZoom(event.clientX, event.clientY, event.deltaY * unit);
    };
    stage.addEventListener("wheel", onWheel, { passive: false });
    return () => stage.removeEventListener("wheel", onWheel);
  }, []);

  useEffect(() => () => {
    if (zoomBadgeTimer.current) window.clearTimeout(zoomBadgeTimer.current);
    if (backHoldRaf.current) cancelAnimationFrame(backHoldRaf.current);
    if (windowDragRef.current?.watchRaf) cancelAnimationFrame(windowDragRef.current.watchRaf);
    window.openCanvasDesktop?.windowControls?.endDrag?.();
  }, []);

  useEffect(() => {
    const stopWindowDrag = () => {
      const drag = windowDragRef.current;
      if (!drag) return;
      if (drag.watchRaf) cancelAnimationFrame(drag.watchRaf);
      windowDragRef.current = null;
      window.openCanvasDesktop?.windowControls?.endDrag?.();
      cancelBackHold();
      setPanning(false);
    };
    window.addEventListener("blur", stopWindowDrag);
    return () => window.removeEventListener("blur", stopWindowDrag);
  }, []);

  function alignSelection(axis: "left" | "hcenter" | "right" | "top" | "vcenter" | "bottom") {
    if (selectedNodes.length < 2) return;
    pushHistory();
    const minX = Math.min(...selectedNodes.map((node) => node.x));
    const maxX = Math.max(...selectedNodes.map((node) => node.x + node.width));
    const minY = Math.min(...selectedNodes.map((node) => node.y));
    const maxY = Math.max(...selectedNodes.map((node) => node.y + node.height));
    const centerX = (minX + maxX) / 2;
    const centerY = (minY + maxY) / 2;
    setNodes((current) => current.map((node) => {
      if (!selected.includes(node.id)) return node;
      if (axis === "left") return { ...node, x: minX };
      if (axis === "right") return { ...node, x: maxX - node.width };
      if (axis === "hcenter") return { ...node, x: centerX - node.width / 2 };
      if (axis === "top") return { ...node, y: minY };
      if (axis === "bottom") return { ...node, y: maxY - node.height };
      return { ...node, y: centerY - node.height / 2 };
    }));
  }

  function distributeSelection(axis: "h" | "v") {
    if (selectedNodes.length < 3) return;
    pushHistory();
    const ordered = [...selectedNodes].sort((a, b) => (axis === "h" ? a.x - b.x : a.y - b.y));
    const first = ordered[0];
    const last = ordered[ordered.length - 1];
    const span = axis === "h" ? (last.x + last.width) - first.x : (last.y + last.height) - first.y;
    const total = ordered.reduce((sum, node) => sum + (axis === "h" ? node.width : node.height), 0);
    const gap = (span - total) / (ordered.length - 1);
    let cursor = axis === "h" ? first.x : first.y;
    const positions = new Map<string, number>();
    for (const node of ordered) {
      positions.set(node.id, cursor);
      cursor += (axis === "h" ? node.width : node.height) + gap;
    }
    setNodes((current) => current.map((node) => positions.has(node.id) ? { ...node, [axis === "h" ? "x" : "y"]: positions.get(node.id)! } : node));
  }

  function nodeCenter(node: CanvasNode) {
    return { x: node.x + node.width / 2, y: node.y + node.height / 2 };
  }

  function makeSnapshot(): CanvasSnapshot {
    return {
      nodes: nodes.map((node) => ({ ...node })),
      wires: wires.map((wire) => ({ ...wire })),
      selected: [...selected],
      selectedWire,
    };
  }

  function syncHistoryStats() {
    setHistoryStats({ undo: historyRef.current.length, redo: futureRef.current.length });
  }

  function pushHistorySnapshot(snapshot: CanvasSnapshot | null) {
    if (!snapshot) return;
    historyRef.current.push(snapshot);
    if (historyRef.current.length > 60) historyRef.current.shift();
    futureRef.current = [];
    syncHistoryStats();
  }

  function pushHistory() {
    pushHistorySnapshot(makeSnapshot());
  }

  function restoreSnapshot(snapshot: CanvasSnapshot) {
    setNodes(snapshot.nodes);
    setWires(snapshot.wires);
    setSelected(snapshot.selected);
    setSelectedWire(snapshot.selectedWire);
  }

  function undoCanvas() {
    const snapshot = historyRef.current.pop();
    if (!snapshot) return;
    futureRef.current.push(makeSnapshot());
    restoreSnapshot(snapshot);
    syncHistoryStats();
  }

  function redoCanvas() {
    const snapshot = futureRef.current.pop();
    if (!snapshot) return;
    historyRef.current.push(makeSnapshot());
    restoreSnapshot(snapshot);
    syncHistoryStats();
  }

  function cancelBackHold() {
    if (backHoldRaf.current) cancelAnimationFrame(backHoldRaf.current);
    backHoldRaf.current = null;
    setBackHold(null);
  }

  function holdArcPath(progress: number) {
    const value = Math.min(1, Math.max(0, progress));
    if (value <= 0.001) return "";
    if (value >= 0.999) return "M 26 5 A 21 21 0 1 1 25.99 5";
    const angle = -Math.PI / 2 + Math.PI * 2 * value;
    const x = 26 + 21 * Math.cos(angle);
    const y = 26 + 21 * Math.sin(angle);
    return `M 26 5 A 21 21 0 ${value > 0.5 ? 1 : 0} 1 ${x.toFixed(2)} ${y.toFixed(2)}`;
  }

  function startBackHold(clientX: number, clientY: number) {
    cancelBackHold();
    backHoldStart.current = performance.now();
    setBackHold(null);
    const tick = () => {
      const progress = Math.min(1, (performance.now() - backHoldStart.current) / 500);
      // A normal click must not flash the ring: show it only after the press
      // has clearly become a hold.
      if (progress >= 0.10) {
        setBackHold({ x: clientX, y: clientY, progress });
      }
      if (progress >= 1) {
        cancelBackHold();
        onHome();
        return;
      }
      backHoldRaf.current = requestAnimationFrame(tick);
    };
    backHoldRaf.current = requestAnimationFrame(tick);
  }

  function flashZoomBadge() {
    setZoomBadge(true);
    if (zoomBadgeTimer.current) window.clearTimeout(zoomBadgeTimer.current);
    zoomBadgeTimer.current = window.setTimeout(() => setZoomBadge(false), 1200);
  }

  function canvasPoint(clientX: number, clientY: number) {
    const rect = stageRef.current?.getBoundingClientRect();
    if (!rect) return null;
    const current = viewRef.current;
    return {
      x: (clientX - rect.left - CANVAS_INSET_X - current.x) / current.k,
      y: (clientY - rect.top - CANVAS_INSET_Y - current.y) / current.k,
    };
  }

  function beginPan(event: React.PointerEvent) {
    event.preventDefault();
    stageRef.current?.setPointerCapture(event.pointerId);
    panRef.current = {
      startX: event.clientX,
      startY: event.clientY,
      viewX: viewRef.current.x,
      viewY: viewRef.current.y,
      moved: false,
      button: event.button,
    };
    setPanning(true);
  }

  function startWindowDrag(event: React.PointerEvent) {
    const controls = window.openCanvasDesktop?.windowControls;
    if (!controls?.beginDrag) {
      // Browser preview fallback: no native window to move.
      beginPan(event);
      return;
    }
    event.preventDefault();
    stageRef.current?.setPointerCapture(event.pointerId);
    windowDragRef.current = { startScreenX: window.screenX, startScreenY: window.screenY, moved: false, button: event.button };
    controls.beginDrag();
    setPanning(true);
    // The native window moves under the pointer; watch the actual window
    // position (not client coordinates) to tell a click from a drag and to
    // cancel the hold ring. The main process samples the cursor itself.
    const watch = () => {
      const drag = windowDragRef.current;
      if (!drag) return;
      if (Math.abs(window.screenX - drag.startScreenX) > 3 || Math.abs(window.screenY - drag.startScreenY) > 3) {
        drag.moved = true;
        cancelBackHold();
      }
      drag.watchRaf = requestAnimationFrame(watch);
    };
    windowDragRef.current.watchRaf = requestAnimationFrame(watch);
  }

  function applyZoom(clientX: number, clientY: number, deltaY: number) {
    const rect = stageRef.current?.getBoundingClientRect();
    if (!rect) return;
    const anchorX = clientX - rect.left - CANVAS_INSET_X;
    const anchorY = clientY - rect.top - CANVAS_INSET_Y;
    setView((current) => {
      const factor = Math.pow(1.1, (-deltaY * 1.5) / 100);
      const k = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, current.k * factor));
      const worldX = (anchorX - current.x) / current.k;
      const worldY = (anchorY - current.y) / current.k;
      return { k, x: anchorX - worldX * k, y: anchorY - worldY * k };
    });
    flashZoomBadge();
  }

  function resetView() {
    setView({ x: 0, y: 0, k: 1 });
    flashZoomBadge();
  }

  function fitView() {
    const rect = stageRef.current?.getBoundingClientRect();
    if (!rect || !nodes.length) {
      resetView();
      return;
    }
    const width = Math.max(1, rect.width - CANVAS_INSET_X);
    const height = Math.max(1, rect.height - CANVAS_INSET_Y);
    const minX = Math.min(...nodes.map((node) => node.x));
    const minY = Math.min(...nodes.map((node) => node.y));
    const maxX = Math.max(...nodes.map((node) => node.x + node.width));
    const maxY = Math.max(...nodes.map((node) => node.y + node.height));
    const k = Math.min(
      MAX_ZOOM,
      Math.max(MIN_ZOOM, Math.min(width / Math.max(1, maxX - minX + 160), height / Math.max(1, maxY - minY + 160))),
    );
    const centerX = (minX + maxX) / 2;
    const centerY = (minY + maxY) / 2;
    setView({ k, x: width / 2 - centerX * k, y: height / 2 - centerY * k });
    flashZoomBadge();
  }

  function applySvgEditor() {
    if (!svgEditor) return;
    pushHistory();
    setNodes((current) => current.map((node) => (
      node.id === svgEditor.id ? { ...node, svg: svgEditor.svg, status: "完成" } : node
    )));
    setSvgEditor(null);
  }

  function addNode(kind: NodeKind) {
    // Image nodes are produced by generator extraction or an asset drop,
    // never by the create toolbar.
    if (kind === "image") return;
    pushHistory();
    const meta = NODE_META[kind];
    const id = `n-${Date.now()}`;
    const index = nodes.length;
    const centerX = (stageSize.width / 2 - CANVAS_INSET_X - view.x) / view.k;
    const centerY = (stageSize.height / 2 - CANVAS_INSET_Y - view.y) / view.k;
    const offset = (index % 5) * 12;
    const node: CanvasNode = {
      id,
      kind,
      title: kind === "assets" ? "Assets" : meta.label,
      status: kind === "image-attempt" ? "Draft" : kind === "assets" ? "0 files" : "完成",
      x: centerX - meta.width / 2 + offset,
      y: centerY - meta.height / 2 + offset,
      width: meta.width,
      height: meta.height,
      tone: meta.tone,
      prompt: kind === "image-attempt" ? "Describe the image…" : undefined,
      count: kind === "image-stack" ? 1 : undefined,
      svg: kind === "svg" ? DEFAULT_SVG : undefined,
    };
    setNodes((current) => [...current, node]);
    setSelected([id]);
  }

  function addReferenceToGeneration(targetId: string, sourceId: string) {
    const source = nodesRef.current.find((node) => node.id === sourceId);
    if (!source || !referencePreviewSrc(source)) return;
    setNodes((current) => current.map((node) => {
      if (node.id !== targetId) return node;
      const versions = nodeVersions(node);
      const index = versions.length - 1;
      const version = versions[index];
      const references = version.referenceIds ?? [];
      if (references.includes(sourceId)) return node;
      if (isVersionLocked(version)) {
        const number = nextVersionNumber(versions);
        const draft: GenerationVersion = {
          id: `v${number}-${Date.now()}`,
          number,
          prompt: version.prompt,
          why: version.why,
          model: version.model,
          outputFormat: version.outputFormat,
          gifMode: version.gifMode,
          aspect: version.aspect,
          quality: version.quality,
          complexity: version.complexity || "medium",
          referenceIds: [...references, sourceId],
          frames: version.frames,
          frameMs: version.frameMs,
          src: undefined,
          status: "Draft",
          generating: false,
          error: undefined,
        };
        const nextVersions = [...versions, draft];
        return syncVersionFields({ ...node, versions: nextVersions, activeVersion: nextVersions.length - 1 }, draft);
      }
      const nextVersions = versions.map((item, itemIndex) => (
        itemIndex === index ? { ...item, referenceIds: [...references, sourceId] } : item
      ));
      return syncVersionFields({ ...node, versions: nextVersions, activeVersion: index }, nextVersions[index]);
    }));
  }

  function updateWireDraft(node: CanvasNode, x: number, y: number) {
    const path = wireDraftPathRef.current;
    if (!path) return;
    path.setAttribute("d", referenceWirePath(node.x, node.y, node.width, node.height, x, y, 0, 0));
  }

  function beginWireFromNode(event: React.PointerEvent, node: CanvasNode) {
    if (!referencePreviewSrc(node)) return;
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    wireDraftFromRef.current = node.id;
    setWireDraftFrom(node.id);
    referenceDropTargetRef.current = null;
    setReferenceDropTargetId(null);
    const point = canvasPoint(event.clientX, event.clientY);
    if (point) updateWireDraft(node, point.x, point.y);
  }

  function moveWireFromNode(event: React.PointerEvent, node: CanvasNode) {
    if (wireDraftFromRef.current !== node.id) return;
    event.preventDefault();
    event.stopPropagation();
    const point = canvasPoint(event.clientX, event.clientY);
    if (!point) return;
    updateWireDraft(node, point.x, point.y);
    const target = nodesRef.current.find((candidate) => {
      if (candidate.kind !== "image-attempt") return false;
      const tolerance = 24 / Math.max(0.05, viewRef.current.k);
      return point.x >= candidate.x - tolerance
        && point.x <= candidate.x + candidate.width * 0.5
        && point.y >= candidate.y - tolerance
        && point.y <= candidate.y + candidate.height + tolerance;
    });
    const targetId = target?.id ?? null;
    referenceDropTargetRef.current = targetId;
    if (targetId !== referenceDropTargetId) setReferenceDropTargetId(targetId);
  }

  function endWireFromNode(event: React.PointerEvent, node: CanvasNode) {
    if (wireDraftFromRef.current !== node.id) return;
    event.preventDefault();
    event.stopPropagation();
    const targetId = referenceDropTargetRef.current;
    if (targetId) {
      pushHistory();
      addReferenceToGeneration(targetId, node.id);
    }
    wireDraftFromRef.current = null;
    setWireDraftFrom(null);
    referenceDropTargetRef.current = null;
    setReferenceDropTargetId(null);
    try {
      event.currentTarget.releasePointerCapture(event.pointerId);
    } catch {
      // Pointer capture may already be released.
    }
  }

  function cancelWireFromNode(event: React.PointerEvent, node: CanvasNode) {
    if (wireDraftFromRef.current !== node.id) return;
    wireDraftFromRef.current = null;
    setWireDraftFrom(null);
    referenceDropTargetRef.current = null;
    setReferenceDropTargetId(null);
    try {
      event.currentTarget.releasePointerCapture(event.pointerId);
    } catch {
      // Pointer capture may already be released.
    }
  }

  function updateReferenceWiresForNode(id: string, x: number, y: number) {
    const svg = stageRef.current?.querySelector(".reference-wires");
    if (!svg) return;
    svg.querySelectorAll(`path[data-from="${id}"], path[data-to="${id}"]`).forEach((path) => {
      const fromId = path.getAttribute("data-from");
      const toId = path.getAttribute("data-to");
      if (!fromId || !toId) return;
      const from = nodesRef.current.find((node) => node.id === fromId);
      const to = nodesRef.current.find((node) => node.id === toId);
      if (!from || !to) return;
      const fromX = fromId === id ? x : from.x;
      const fromY = fromId === id ? y : from.y;
      const toX = toId === id ? x : to.x;
      const toY = toId === id ? y : to.y;
      path.setAttribute("d", referenceWirePath(fromX, fromY, from.width, from.height, toX, toY, to.width, to.height));
    });
  }

  function focusNode(id: string) {
    setZOrder((current) => {
      if (current[current.length - 1] === id) return current;
      const next = current.filter((item) => item !== id);
      next.push(id);
      return next;
    });
  }

  function onNodePointerDown(event: React.PointerEvent, node: CanvasNode) {
    event.stopPropagation();
    // Middle belongs to the canvas pan, even over a card. Right is only
    // click (toggle rail) or hold (return home) now.
    if (event.button === 1) {
      beginPan(event);
      return;
    }
    if (event.button === 2) {
      startWindowDrag(event);
      startBackHold(event.clientX, event.clientY);
      return;
    }
    if (event.button !== 0) return;
    focusNode(node.id);
    setHoveredId(node.id);
    dragSnapshotRef.current = makeSnapshot();
    dragMovedRef.current = false;
    setSelected((current) => {
      if (event.shiftKey) {
        return current.includes(node.id) ? current.filter((id) => id !== node.id) : [...current, node.id];
      }
      return [node.id];
    });
    setSelectedWire("");
    event.currentTarget.setPointerCapture(event.pointerId);
    const element = event.currentTarget.parentElement as HTMLElement | null;
    if (element) {
      element.style.willChange = "transform";
      nodeDragRef.current = {
        id: node.id,
        startX: event.clientX,
        startY: event.clientY,
        originX: node.x,
        originY: node.y,
        k: viewRef.current.k,
        element,
        width: element.offsetWidth,
        height: element.offsetHeight,
        dx: 0,
        dy: 0,
        moved: false,
      };
    }
  }

  function setHoverBarPosition(nodeX: number, nodeY: number, width: number, height: number) {
    const hoverBar = hoverBarRef.current;
    if (!hoverBar) return;
    const view = viewRef.current;
    hoverBar.style.transform = `translate3d(${CANVAS_INSET_X + view.x + (nodeX + width / 2) * view.k + 18}px, ${CANVAS_INSET_Y + view.y + (nodeY + height) * view.k + 8}px, 0) translateX(-50%)`;
  }

  function onPointerMove(event: React.PointerEvent) {
    if (windowDragRef.current) {
      const drag = windowDragRef.current;
      if (Math.abs(window.screenX - drag.startScreenX) > 3 || Math.abs(window.screenY - drag.startScreenY) > 3) {
        drag.moved = true;
        cancelBackHold();
      }
      return;
    }
    if (panRef.current) {
      const pan = panRef.current;
      const dx = event.clientX - pan.startX;
      const dy = event.clientY - pan.startY;
      if (Math.abs(dx) > 3 || Math.abs(dy) > 3) {
        pan.moved = true;
        cancelBackHold();
      }
      const current = viewRef.current;
      const nextX = pan.viewX + dx;
      const nextY = pan.viewY + dy;
      viewRef.current = { ...current, x: nextX, y: nextY };
      const world = worldRef.current;
      if (world) {
        world.style.transform = `translate3d(${nextX / current.k}px, ${nextY / current.k}px, 0)`;
      }
      const dotLayer = dotLayerRef.current;
      if (dotLayer) {
        dotLayer.style.transform = `translate3d(${nextX % 26}px, ${nextY % 26}px, 0)`;
      }
      return;
    }
    if (sidebarDrag) {
      setSidebarWidth(Math.max(220, Math.min(480, sidebarDrag.width + event.clientX - sidebarDrag.startX)));
      return;
    }
    if (resize) {
      const dx = (event.clientX - resize.startX) / resize.k;
      const dy = (event.clientY - resize.startY) / resize.k;
      if (Math.abs(dx) > 0.1 || Math.abs(dy) > 0.1) {
        resizeMovedRef.current = true;
        if (!resize.moved) setResize((current) => current ? { ...current, moved: true } : current);
      }
      // Keep every node's aspect ratio fixed while the invisible bottom-right
      // handle scales it.
      const ratio = resize.width / Math.max(1, resize.height);
      const factor = Math.max(0.25, 1 + Math.max(dx / Math.max(1, resize.width), dy / Math.max(1, resize.height)));
      const width = Math.max(120, resize.width * factor);
      const height = Math.max(90, width / ratio);
      setNodes((current) => current.map((node) => node.id === resize.id ? { ...node, width, height } : node));
      return;
    }
    const nodeDrag = nodeDragRef.current;
    if (nodeDrag) {
      const dx = (event.clientX - nodeDrag.startX) / nodeDrag.k;
      const dy = (event.clientY - nodeDrag.startY) / nodeDrag.k;
      nodeDrag.dx = dx;
      nodeDrag.dy = dy;
      if (Math.abs(dx) > 0.1 || Math.abs(dy) > 0.1) {
        nodeDrag.moved = true;
        dragMovedRef.current = true;
      }
      // Move the DOM node directly while dragging; React state is committed on pointerup.
      nodeDrag.element.style.transform = `translate3d(${dx}px, ${dy}px, 0)`;
      setHoverBarPosition(nodeDrag.originX + dx, nodeDrag.originY + dy, nodeDrag.width, nodeDrag.height);
      updateReferenceWiresForNode(nodeDrag.id, nodeDrag.originX + dx, nodeDrag.originY + dy);
      const dragged = nodesRef.current.find((node) => node.id === nodeDrag.id);
      const draggedSrc = dragged ? referencePreviewSrc(dragged) : undefined;
      let targetId: string | null = null;
      const pointer = canvasPoint(event.clientX, event.clientY);
      if (nodeDrag.moved && dragged && draggedSrc && pointer) {
        const target = nodesRef.current.find((node) => {
          if (node.kind !== "image-attempt" || node.id === nodeDrag.id) return false;
          const tolerance = 24 / Math.max(0.05, viewRef.current.k);
          return pointer.x >= node.x - tolerance
            && pointer.x <= node.x + node.width * 0.5
            && pointer.y >= node.y - tolerance
            && pointer.y <= node.y + node.height + tolerance;
        });
        targetId = target?.id ?? null;
      }
      referenceDropTargetRef.current = targetId;
      if (targetId !== referenceDropTargetId) setReferenceDropTargetId(targetId);
      return;
    }
    if (marquee) {
      const point = canvasPoint(event.clientX, event.clientY);
      if (point) {
        setMarquee((current) =>
          current ? { ...current, w: point.x - current.x, h: point.y - current.y } : current,
        );
      }
    }
  }

  function onPointerUp() {
    const windowDrag = windowDragRef.current;
    if (windowDrag) {
      if (windowDrag.watchRaf) cancelAnimationFrame(windowDrag.watchRaf);
      windowDragRef.current = null;
      window.openCanvasDesktop?.windowControls?.endDrag?.();
      cancelBackHold();
      setPanning(false);
      if (!windowDrag.moved) {
        if (windowDrag.button === 2) setSidebarVisible((visible) => !visible);
        else {
          setSelected([]);
          setSelectedWire("");
        }
      }
      return;
    }
    const pan = panRef.current;
    if (pan) {
      cancelBackHold();
      panRef.current = null;
      setPanning(false);
      if (pan.moved) setView({ ...viewRef.current });
      if (!pan.moved && pan.button === 0) {
        setSelected([]);
        setSelectedWire("");
      }
      return;
    }
    const nodeDrag = nodeDragRef.current;
    if (nodeDrag) {
      const finalX = nodeDrag.originX + nodeDrag.dx;
      const finalY = nodeDrag.originY + nodeDrag.dy;
      const dragged = nodesRef.current.find((node) => node.id === nodeDrag.id);
      const draggedSrc = dragged ? referencePreviewSrc(dragged) : undefined;
      const dropTargetId = referenceDropTargetRef.current;
      if (nodeDrag.moved && dropTargetId && draggedSrc) {
        const targetId = dropTargetId;
        nodeDrag.element.style.transform = "";
        nodeDrag.element.style.willChange = "";
        setHoverBarPosition(nodeDrag.originX, nodeDrag.originY, nodeDrag.width, nodeDrag.height);
        addReferenceToGeneration(targetId, nodeDrag.id);
        pushHistorySnapshot(dragSnapshotRef.current);
        referenceDropTargetRef.current = null;
        setReferenceDropTargetId(null);
        nodeDragRef.current = null;
        dragSnapshotRef.current = null;
        dragMovedRef.current = false;
        return;
      }
      referenceDropTargetRef.current = null;
      setReferenceDropTargetId(null);
      nodeDrag.element.style.transform = "";
      nodeDrag.element.style.willChange = "";
      if (nodeDrag.moved) {
        nodeDrag.element.style.left = `${finalX}px`;
        nodeDrag.element.style.top = `${finalY}px`;
        setNodes((current) => current.map((node) => (node.id === nodeDrag.id ? { ...node, x: finalX, y: finalY } : node)));
        pushHistorySnapshot(dragSnapshotRef.current);
      }
      nodeDragRef.current = null;
      dragSnapshotRef.current = null;
      dragMovedRef.current = false;
      return;
    }
    if (marquee) {
      const box = {
        x: Math.min(marquee.x, marquee.x + marquee.w),
        y: Math.min(marquee.y, marquee.y + marquee.h),
        w: Math.abs(marquee.w),
        h: Math.abs(marquee.h),
      };
      if (box.w > 4 && box.h > 4) {
        const hits = nodes
          .filter((node) => node.x < box.x + box.w && node.x + node.width > box.x && node.y < box.y + box.h && node.y + node.height > box.y)
          .map((node) => node.id);
        setSelected((current) => marquee.additive ? Array.from(new Set([...current, ...hits])) : hits);
      }
      setMarquee(null);
      return;
    }
    if (dragMovedRef.current) pushHistorySnapshot(dragSnapshotRef.current);
    if (resizeMovedRef.current) pushHistorySnapshot(resizeSnapshotRef.current);
    dragSnapshotRef.current = null;
    resizeSnapshotRef.current = null;
    dragMovedRef.current = false;
    resizeMovedRef.current = false;
    setResize(null);
    setSidebarDrag(null);
  }

  function onPointerCancel() {
    cancelBackHold();
    window.openCanvasDesktop?.windowControls?.endDrag?.();
    if (windowDragRef.current?.watchRaf) cancelAnimationFrame(windowDragRef.current.watchRaf);
    windowDragRef.current = null;
    const pan = panRef.current;
    panRef.current = null;
    if (pan?.moved) setView({ ...viewRef.current });
    const nodeDrag = nodeDragRef.current;
    if (nodeDrag) {
      nodeDrag.element.style.transform = "";
      nodeDrag.element.style.willChange = "";
      setHoverBarPosition(nodeDrag.originX, nodeDrag.originY, nodeDrag.width, nodeDrag.height);
      updateReferenceWiresForNode(nodeDrag.id, nodeDrag.originX, nodeDrag.originY);
      nodeDragRef.current = null;
    }
    referenceDropTargetRef.current = null;
    setReferenceDropTargetId(null);
    dragSnapshotRef.current = null;
    resizeSnapshotRef.current = null;
    dragMovedRef.current = false;
    resizeMovedRef.current = false;
    setPanning(false);
    setResize(null);
    setSidebarDrag(null);
    setMarquee(null);
  }

  function onStagePointerDown(event: React.PointerEvent) {
    if (event.target !== event.currentTarget) return;
    if (event.button === 1) {
      beginPan(event);
      return;
    }
    if (event.button === 2) {
      startWindowDrag(event);
      startBackHold(event.clientX, event.clientY);
      return;
    }
    if (event.button !== 0) return;
    if (spaceHeld) {
      beginPan(event);
      return;
    }
    // Left-drag pans the viewport. Right-drag moves the frameless window;
    // a still right press is the rail toggle / hold-to-home gesture.
    beginPan(event);
  }

  async function addAIImageNodes(images: NodeAIResultImage[]) {
    if (!images.length) return [];
    pushHistory();
    setProcessingImages((count) => count + 1);
    try {
      const stamp = Date.now();
      const nextNodes: CanvasNode[] = [];
      for (let index = 0; index < images.length; index += 1) {
        const image = images[index];
        const id = `n-${stamp}-${index}`;
        const prepared = await prepareCanvasImage(image.src, id);
        nextNodes.push({
          id,
          kind: "image",
          title: image.title,
          status: "完成",
          x: image.x ?? 0,
          y: image.y ?? 0,
          width: Math.max(24, image.width ?? 340),
          height: Math.max(24, image.height ?? 240),
          tone: "forest-b",
          ...prepared,
        });
      }
      setNodes((current) => [...current, ...nextNodes]);
      setSelected(nextNodes.map((node) => node.id));
      return nextNodes;
    } finally {
      setProcessingImages((count) => Math.max(0, count - 1));
    }
  }

  function agentAiSource(nodeId?: string) {
    const source = nodeId
      ? nodesRef.current.find((node) => node.id === nodeId)
      : nodesRef.current.find((node) => selected.includes(node.id) && node.kind === "image")
        ?? nodesRef.current.find((node) => node.kind === "image" && node.src);
    if (!source) throw new Error("没有可用的图片节点；请先选择一个 image 节点");
    const src = displayImageFor(source)?.src ?? source.src;
    if (!src) throw new Error("源节点没有图片");
    return { source, src };
  }

  async function runAgentGenerateImage(options: Record<string, unknown>) {
    if (options.nodeId) return generateIntoAttemptNode(String(options.nodeId), options);
    const key = (() => {
      try {
        return String((JSON.parse(localStorage.getItem("open-canvas:electron-api-keys:v1") || "{}") as Record<string, unknown>).openrouter || "");
      } catch {
        return "";
      }
    })();
    if (!key) throw new Error("OpenRouter API key required. Add one in Settings before generating.");
    if (!window.openCanvasDesktop?.generateImage) throw new Error("Electron image generation bridge unavailable");
    const prompt = String(options.prompt || "").trim();
    if (!prompt) throw new Error("generate 需要 prompt");
    const model = String(options.model || "openai/gpt-image-2.6-sunburst");
    const outputFormat = String(options.outputFormat || "png");
    const body: Record<string, unknown> = {
      model,
      prompt,
      n: 1,
      quality: String(options.quality || "medium"),
      aspect_ratio: String(options.aspect || "1:1"),
      output_format: outputFormat,
      max_tokens: Math.max(1024, Math.min(16384, Number(options.maxTokens) || 8192)),
    };
    if (model.startsWith("openai/gpt-image-2.6")) {
      body.provider = { options: { openai: { complexity: String(options.complexity || "medium") } } };
    }
    const result = await window.openCanvasDesktop.generateImage({ key, body });
    const payload = JSON.parse(result.body) as {
      data?: Array<{ b64_json?: string; media_type?: string; url?: string }>;
      images?: Array<{ b64_json?: string; media_type?: string; url?: string }>;
      results?: Array<{ b64_json?: string; media_type?: string; url?: string }>;
      error?: { message?: string };
    };
    if (!result.ok) throw new Error(payload?.error?.message || `Request failed (${result.status})`);
    const item = (payload.data || payload.images || payload.results || [])[0];
    const fallbackType = outputFormat === "jpeg" ? "image/jpeg" : outputFormat === "webp" ? "image/webp" : "image/png";
    const src = item?.b64_json ? `data:${item.media_type || fallbackType};base64,${item.b64_json}` : item?.url;
    if (!src) throw new Error("The provider returned no image");
    const nodes = await addAIImageNodes([{
      title: String(options.title || "Generated image"),
      src,
      x: options.x as number | undefined,
      y: options.y as number | undefined,
      width: Number(options.width) || 512,
      height: Number(options.height) || 512,
    }]);
    return {
      ok: true,
      action: "generate",
      ids: nodes.map((node) => node.id),
      count: nodes.length,
    };
  }

  async function generateIntoAttemptNode(nodeId: string, options: Record<string, unknown>) {
    const key = (() => {
      try {
        return String((JSON.parse(localStorage.getItem("open-canvas:electron-api-keys:v1") || "{}") as Record<string, unknown>).openrouter || "");
      } catch {
        return "";
      }
    })();
    if (!key) throw new Error("OpenRouter API key required. Add one in Settings before generating.");
    if (!window.openCanvasDesktop?.generateImage) throw new Error("Electron image generation bridge unavailable");

    const node = nodesRef.current.find((item) => item.id === nodeId);
    if (!node) throw new Error(`节点不存在：${nodeId}`);
    if (node.kind !== "image-attempt") throw new Error("nodeId 必须是生成节点（image-attempt）");
    const versions = nodeVersions(node);
    const activeIndex = Math.min(Math.max(0, node.activeVersion ?? 0), versions.length - 1);
    const active = versions[activeIndex];
    if (!active) throw new Error("生成节点没有可用版本");
    if (active.generating) throw new Error("这个版本正在生成");

    // A locked version stays as history; generate into a fresh draft that
    // inherits the prompt, model and references.
    const createNew = isVersionLocked(active);
    const number = createNew ? nextVersionNumber(versions) : active.number;
    const draft: GenerationVersion = createNew
      ? {
          ...active,
          id: `v${number}-${Date.now()}`,
          number,
          why: "",
          src: undefined,
          originalSrcId: undefined,
          originalWidth: undefined,
          originalHeight: undefined,
          status: "Draft",
          generating: false,
          error: undefined,
        }
      : active;
    const versionId = draft.id;

    const prompt = String(options.prompt ?? draft.prompt ?? "");
    const model = String(options.model ?? draft.model ?? ATTEMPT_MODELS[0].value);
    const gifMode = Boolean(draft.gifMode);
    const outputFormat = gifMode ? "gif" : String(options.outputFormat ?? draft.outputFormat ?? "png");
    const aspect = String(options.aspect ?? draft.aspect ?? "1:1");
    const quality = String(options.quality ?? draft.quality ?? "medium");
    const complexity = String(options.complexity ?? draft.complexity ?? "medium");
    const frames = Math.max(2, Math.min(16, Number(options.frames) || draft.frames || 9));
    const frameMs = Math.max(20, Math.min(2000, Number(options.frameMs) || draft.frameMs || 200));
    const maxTokens = Number(options.maxTokens) || (gifMode ? Math.min(16384, Math.max(8192, frames * 1024)) : 8192);

    setNodes((current) => current.map((item) => {
      if (item.id !== nodeId) return item;
      const base = createNew ? addVersionToNode(item, draft) : item;
      return withVersionPatch(base, versionId, {
        prompt,
        model,
        outputFormat: outputFormat as StillFormat,
        gifMode,
        aspect,
        quality,
        complexity,
        frames,
        frameMs,
        status: "生成中",
        generating: true,
        error: undefined,
      });
    }));

    try {
      const referenceUrls = await referenceUrlsFor(prompt, draft.referenceIds ?? []);
      const promptText = prompt.replace(/\[\[image:[^\]]+\]\]/g, " ").replace(/\s+/g, " ").trim();
      const body: Record<string, unknown> = {
        model,
        prompt: promptText || (referenceUrls.length ? "根据参考图生成" : "Describe the image"),
        n: 1,
        quality,
        aspect_ratio: aspect,
        output_format: outputFormat,
        max_tokens: maxTokens,
      };
      if (model.startsWith("openai/gpt-image-2.6")) {
        body.provider = { options: { openai: { complexity } } };
      }
      if (gifMode) {
        body.frame_count = frames;
        body.frame_duration_ms = frameMs;
      }
      if (referenceUrls.length) {
        body.input_references = referenceUrls.map((url) => ({ type: "image_url", image_url: { url } }));
      }
      const result = await window.openCanvasDesktop.generateImage({ key, body });
      const payload = JSON.parse(result.body) as {
        data?: Array<{ b64_json?: string; media_type?: string; url?: string }>;
        images?: Array<{ b64_json?: string; media_type?: string; url?: string }>;
        results?: Array<{ b64_json?: string; media_type?: string; url?: string }>;
        error?: { message?: string };
      };
      if (!result.ok) throw new Error(payload?.error?.message || `Request failed (${result.status})`);
      const item = (payload.data || payload.images || payload.results || [])[0];
      const fallbackType = outputFormat === "gif" ? "image/gif" : outputFormat === "jpeg" ? "image/jpeg" : outputFormat === "webp" ? "image/webp" : "image/png";
      const src = item?.b64_json ? `data:${item.media_type || fallbackType};base64,${item.b64_json}` : item?.url;
      if (!src) throw new Error("The provider returned no image");
      const prepared = await prepareCanvasImage(src, `${nodeId}:${versionId}`);
      recordLog("info", "generation", "Attempt image generated", `model=${model} format=${outputFormat} aspect=${aspect} quality=${quality}`);
      recordCost(model, 0.04);
      setNodes((current) => current.map((target) => (
        target.id === nodeId
          ? withVersionPatch(target, versionId, { status: "完成", ...prepared, generating: false, error: undefined })
          : target
      )));
      return {
        ok: true,
        action: "generate",
        nodeId,
        versionId,
        referenceCount: referenceUrls.length,
        width: prepared.originalWidth,
        height: prepared.originalHeight,
      };
    } catch (error) {
      const message = describeGenerationError(error instanceof Error ? error.message : "Generation failed");
      recordLog("error", "generation", "Attempt generation failed", message);
      setNodes((current) => current.map((target) => (
        target.id === nodeId
          ? withVersionPatch(target, versionId, { status: "错误", generating: false, error: message })
          : target
      )));
      throw new Error(message);
    }
  }

  async function runAgentAi(action: string, options: Record<string, unknown> = {}) {
    if (action === "generate") return runAgentGenerateImage(options);
    const ai = window.openCanvasDesktop?.ai;
    if (!ai) throw new Error("Local AI bridge unavailable. Restart the desktop app.");
    const { source, src } = agentAiSource(options.nodeId as string | undefined);
    const title = String(options.title || source.title || "AI");
    if (action === "cutout") {
      await ensureLocalModels(["birefnet"]);
      const result = await ai.cutout(src);
      const nodes = await addAIImageNodes([{
        title: `${title} · Cutout`,
        src: result.foreground,
        x: source.x + 32,
        y: source.y + 32,
        width: source.width,
        height: source.height,
      }]);
      return { ok: true, action, sourceNodeId: source.id, ids: nodes.map((node) => node.id), count: nodes.length };
    }
    if (action === "pbr") {
      await ensureLocalModels(["depth-anything-v2-small"]);
      const result = await ai.pbr({
        image: src,
        normalConvention: options.normalConvention as string | undefined,
        tileable: Boolean(options.tileable),
      });
      const images = PBR_ORDER.filter((key) => result.maps[key]).map((key, index) => ({
        title: `PBR ${PBR_LABELS[key] ?? key}`,
        src: result.maps[key],
        x: source.x + source.width + 60 + (index % 3) * (source.width * 0.75 + 20),
        y: source.y + Math.floor(index / 3) * (source.height * 0.75 + 20),
        width: source.width * 0.75,
        height: source.height * 0.75,
      }));
      const nodes = await addAIImageNodes(images);
      return { ok: true, action, sourceNodeId: source.id, ids: nodes.map((node) => node.id), count: nodes.length };
    }
    if (action === "segment") {
      await ensureLocalModels(["seethrough-layerdiff3d", "seethrough-marigold"]);
      const result = await ai.spine({
        image: src,
        resolution: Number(options.resolution) || 768,
        resolutionDepth: Math.min(768, Number(options.resolutionDepth) || 768),
      });
      const selectedParts = Array.isArray(options.parts) ? new Set(options.parts.map(String)) : null;
      const parts = result.parts.filter((part) => !selectedParts || selectedParts.has(part.name));
      const images = parts.map((part, index) => ({
        title: part.name || `Part ${index + 1}`,
        src: part.png,
        x: source.x + source.width + 60 + (index % 3) * 220,
        y: source.y + Math.floor(index / 3) * 220,
        width: Math.max(80, Math.min(320, part.bounds.width)),
        height: Math.max(80, Math.min(320, part.bounds.height)),
      }));
      const nodes = await addAIImageNodes(images);
      return { ok: true, action, sourceNodeId: source.id, ids: nodes.map((node) => node.id), count: nodes.length, partCount: result.partCount, cached: result.cached };
    }
    if (action === "upscale") {
      const result = await ai.upscale({
        image: src,
        scale: Number(options.scale) || undefined,
        targetLongEdge: Number(options.targetLongEdge) || undefined,
        method: options.method as string | undefined,
      });
      const nodes = await addAIImageNodes([{
        title: `${title} · ${result.width}×${result.height}`,
        src: result.image,
        x: source.x + 32,
        y: source.y + 32,
        width: source.width,
        height: source.height,
      }]);
      return { ok: true, action, sourceNodeId: source.id, ids: nodes.map((node) => node.id), count: nodes.length, width: result.width, height: result.height, scale: result.scale, method: result.method };
    }
    if (action === "angle") {
      const result = await ai.angle({
        image: src,
        yaw: Number(options.yaw) || 0,
        pitch: Number(options.pitch) || 0,
        zoom: Number(options.zoom) || 1,
      });
      const nodes = await addAIImageNodes([{
        title: `${title} · Angle`,
        src: result.image,
        x: source.x + 32,
        y: source.y + 32,
        width: source.width,
        height: source.height,
      }]);
      return { ok: true, action, sourceNodeId: source.id, ids: nodes.map((node) => node.id), count: nodes.length, width: result.width, height: result.height };
    }
    throw new Error("action 必须是 cutout / pbr / segment / upscale / angle / generate");
  }

  async function addImportedImage(dataUrl: string, x: number, y: number) {
    pushHistory();
    setProcessingImages((count) => count + 1);
    try {
      const id = `n-${Date.now()}-${Math.random().toString(36).slice(2, 5)}`;
      const prepared = await prepareCanvasImage(dataUrl, id);
      const node: CanvasNode = {
        id,
        kind: "image",
        title: "Imported image",
        status: "完成",
        x,
        y,
        width: 340,
        height: 240,
        tone: "forest-b",
        ...prepared,
      };
      setNodes((current) => [...current, node]);
      setSelected([node.id]);
    } finally {
      setProcessingImages((count) => Math.max(0, count - 1));
    }
  }

  const handleMediaSize = useCallback((id: string, width: number, height: number) => {
    if (!width || !height) return;
    setNodes((current) => current.map((node) => {
      if (node.id !== id) return node;
      const ratio = width / height;
      const nextWidth = node.width || 380;
      const nextHeight = Math.round(nextWidth / ratio);
      if (Math.abs(node.width / Math.max(1, node.height) - ratio) < 0.01) return node;
      return { ...node, width: nextWidth, height: nextHeight };
    }));
  }, []);

  function onDrop(event: React.DragEvent) {
    event.preventDefault();
    const point = canvasPoint(event.clientX, event.clientY);
    if (!point) return;
    const files = Array.from(event.dataTransfer.files).filter((file) => file.type.startsWith("image/"));
    files.forEach((file, index) => {
      const reader = new FileReader();
      reader.onload = () => {
        if (typeof reader.result === "string") {
          void addImportedImage(reader.result, point.x + index * 40, point.y + index * 40);
        }
      };
      reader.readAsDataURL(file);
    });
  }

  useEffect(() => {
    const onPaste = (event: ClipboardEvent) => {
      const item = Array.from(event.clipboardData?.items ?? []).find((entry) => entry.type.startsWith("image/"));
      if (!item) return;
      const file = item.getAsFile();
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => {
        if (typeof reader.result === "string") void addImportedImage(reader.result, 160, 520);
      };
      reader.readAsDataURL(file);
    };
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
  }, []);

  function extractImageNode(node: CanvasNode) {
    const version = displayImageFor(node);
    if (!version?.src) return;
    pushHistory();
    const id = `n-${Date.now()}-${Math.random().toString(36).slice(2, 5)}`;
    const imageNode: CanvasNode = {
      id,
      kind: "image",
      title: `${node.title} · Image`,
      status: "完成",
      x: node.x + node.width + 48,
      y: node.y,
      width: node.width,
      height: node.height,
      tone: node.tone,
      src: version.src,
      originalSrcId: version.originalSrcId,
      originalWidth: version.originalWidth,
      originalHeight: version.originalHeight,
    };
    setNodes((current) => [...current, imageNode]);
    setSelected([id]);
  }

  function duplicateNode(node: CanvasNode) {
    pushHistory();
    const id = `n-${Date.now()}`;
    const copy = { ...node, id, x: node.x + 36, y: node.y + 36, title: `${node.title} copy` };
    setNodes((current) => [...current, copy]);
    setSelected([id]);
  }

  function deleteSelection() {
    if (selectedWire) {
      pushHistory();
      setWires((current) => current.filter((wire) => wire.id !== selectedWire));
      setSelectedWire("");
      return;
    }
    if (!selected.length) return;
    pushHistory();
    setNodes((current) => current.filter((node) => !selected.includes(node.id)));
    setWires((current) => current.filter((wire) => !selected.includes(wire.from) && !selected.includes(wire.to)));
    setSelected([]);
  }

  const rulerStep = niceRulerStep(view.k);
  const rulerSpacing = Math.max(1, rulerStep * view.k);
  const topTicks = rulerTicks(stageSize.width, view.x, view.k, rulerStep);
  const leftTicks = rulerTicks(stageSize.height, view.y, view.k, rulerStep);
  const topPhase = ((view.x % rulerSpacing) + rulerSpacing) % rulerSpacing;
  const leftPhase = ((view.y % rulerSpacing) + rulerSpacing) % rulerSpacing;
  const attemptVersion = attempt ? activeVersionOf(attempt) : null;
  const attemptLocked = Boolean(attemptVersion && (attemptVersion.generating || attemptVersion.src || attemptVersion.status === "完成"));
  const attemptDisplayError = attemptError || attemptVersion?.error || "";
  const attemptVersions = attempt ? nodeVersions(attempt) : [];
  const attemptActiveIndex = attempt ? Math.min(Math.max(0, attempt.activeVersion ?? 0), Math.max(0, attemptVersions.length - 1)) : -1;
  const canCreateAttemptVersion = attempt ? canCreateNextVersion(attemptVersions, attemptActiveIndex) : false;
  const attemptReferenceIds = attemptVersion?.referenceIds ?? [];
  const attemptReferences = attemptReferenceIds.flatMap((id) => {
    const node = nodes.find((item) => item.id === id);
    if (!node) return [];
    const preview = referencePreviewSrc(node);
    if (!preview) return [];
    return [{ id: node.id, title: node.title, src: preview }];
  });
  const insertedReferenceIds = new Set(
    Array.from(attemptPrompt.matchAll(/\[\[image:([^\]]+)\]\]/g)).map((match) => match[1]),
  );

  function addAttemptReference(id: string) {
    if (!attempt || !attemptVersion || attemptLocked) return;
    const source = nodes.find((node) => node.id === id);
    if (!source || !referencePreviewSrc(source)) return;
    const references = attemptVersion.referenceIds ?? [];
    if (references.includes(id)) return;
    saveAttemptConfig({ referenceIds: [...references, id] });
  }

  function removeAttemptReference(id: string) {
    if (!attempt || !attemptVersion || attemptLocked) return;
    const nextPrompt = attemptPrompt.split(`[[image:${id}]]`).join("");
    saveAttemptConfig({
      referenceIds: (attemptVersion.referenceIds ?? []).filter((reference) => reference !== id),
      prompt: nextPrompt,
    });
    setAttemptPrompt(nextPrompt);
  }

  return (
    <div className="canvas-shell">
      <aside className="canvas-sidebar" style={{ width: sidebarVisible ? sidebarWidth : 0, minWidth: sidebarVisible ? sidebarWidth : 0, display: sidebarVisible ? undefined : "none" }}>
        <div
          className="canvas-sidebar-resize"
          onPointerDown={(event) => {
            event.currentTarget.setPointerCapture(event.pointerId);
            setSidebarDrag({ startX: event.clientX, width: sidebarWidth });
          }}
        />
        <div className="canvas-sidebar-top">
          <button className="icon-btn" aria-label="返回画布列表" title="返回" onClick={onHome}>
            <FolderIcon size={18} />
          </button>
          <button className="icon-btn" aria-label="新建画布" title="新建画布" onClick={onCreateCanvas}>
            <PlusIcon size={20} />
          </button>
        </div>
        <div className="canvas-sidebar-list">
          {canvases.map((canvas) => (
            <div
              key={canvas.id}
              className={`canvas-project-group${canvas.id === canvasId ? " active" : ""}`}
              onClick={() => onSelectCanvas(canvas)}
              draggable
              onDragStart={() => setSidebarDragCanvas(canvas.id)}
              onDragOver={(event) => event.preventDefault()}
              onDrop={() => {
                if (!sidebarDragCanvas || sidebarDragCanvas === canvas.id) return;
                const from = canvases.findIndex((item) => item.id === sidebarDragCanvas);
                const to = canvases.findIndex((item) => item.id === canvas.id);
                if (from < 0 || to < 0) return;
                onMoveCanvas(sidebarDragCanvas, to - from);
                setSidebarDragCanvas("");
              }}
            >
              <span className="canvas-project-icon"><FolderIcon size={16} /></span>
              <span className="canvas-project-name">{canvas.name}</span>
              <span className="canvas-project-count">{canvas.id === canvasId ? nodes.length : ""}</span>
              <span className="canvas-project-actions">
                <button aria-label="上移画布" title="上移画布" onClick={(event) => { event.stopPropagation(); onMoveCanvas(canvas.id, 1); }}>
                  <ArrowUpIcon size={14} />
                </button>
                <button aria-label="下移画布" title="下移画布" onClick={(event) => { event.stopPropagation(); onMoveCanvas(canvas.id, -1); }}>
                  <ArrowDownIcon size={14} />
                </button>
                <button
                  className={`danger${armedCanvasDelete === canvas.id ? " armed" : ""}`}
                  aria-label={armedCanvasDelete === canvas.id ? "再次点击确认删除画布" : "删除画布"}
                  draggable={false}
                  onDragStart={(event) => event.preventDefault()}
                  onPointerDown={(event) => event.stopPropagation()}
                  onClick={(event) => {
                    event.stopPropagation();
                    requestCanvasDelete(canvas.id, () => onDeleteCanvas(canvas.id));
                  }}
                >
                  <TrashIcon size={14} />
                </button>
              </span>
            </div>
          ))}
        </div>
      </aside>

      <div className="canvas-main">
        <div className="canvas-titlebar">
          <span className="canvas-titlebar-name">{title}</span>
          <div className="canvas-window-controls">
            <button className="window-btn" aria-label="最小化" onClick={() => window.openCanvasDesktop?.windowControls?.minimize()}><MinimizeIcon /></button>
            <button className="window-btn" aria-label="最大化" onClick={() => window.openCanvasDesktop?.windowControls?.toggleMaximize()}><MaximizeIcon /></button>
            <button className="window-btn close" aria-label="关闭" onClick={() => window.openCanvasDesktop?.windowControls?.close()}><CloseIcon /></button>
          </div>
        </div>

        <main
          ref={stageRef}
          className={`canvas-stage${panning ? " panning" : spaceHeld ? " space-pan" : ""}`}
        onPointerDown={onStagePointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerCancel}
        onContextMenu={(event) => event.preventDefault()}
        onDragOver={(event) => event.preventDefault()}
        onDrop={onDrop}
      >
        {!storageReady ? <div className="canvas-storage-loading">加载画布…</div> : null}
        <div
          ref={dotLayerRef}
          className="canvas-dot-grid"
          style={{ transform: `translate3d(${view.x % 26}px, ${view.y % 26}px, 0)` }}
        />
        <div
          className="canvas-ruler canvas-ruler-top"
          style={{
            backgroundImage: `repeating-linear-gradient(90deg, var(--border) 0 1px, transparent 1px ${rulerSpacing}px), repeating-linear-gradient(90deg, color-mix(in srgb, var(--border) 55%, transparent) 0 1px, transparent 1px ${Math.max(1, rulerSpacing / 5)}px)`,
            backgroundPosition: `${topPhase}px 0`,
          }}
        >
          {topTicks.map((tick) => (
            <span className="ruler-label ruler-label-top" style={{ left: Math.round(tick.pos) }} key={tick.value}>
              {formatRulerValue(tick.value)}
            </span>
          ))}
        </div>
        <div
          className="canvas-ruler canvas-ruler-left"
          style={{
            backgroundImage: `repeating-linear-gradient(0deg, var(--border) 0 1px, transparent 1px ${rulerSpacing}px), repeating-linear-gradient(0deg, color-mix(in srgb, var(--border) 55%, transparent) 0 1px, transparent 1px ${Math.max(1, rulerSpacing / 5)}px)`,
            backgroundPosition: `0 ${leftPhase}px`,
          }}
        >
          {leftTicks.map((tick) => (
            <span className="ruler-label ruler-label-left" style={{ top: Math.round(tick.pos) }} key={tick.value}>
              {formatRulerValue(tick.value)}
            </span>
          ))}
        </div>
        <div className="canvas-ruler-corner" />

        <div
          ref={worldRef}
          className="canvas-world"
          style={{
            zoom: view.k,
            transform: `translate3d(${view.x / view.k}px, ${view.y / view.k}px, 0)`,
          }}
        >

          <svg className="canvas-wires reference-wires" aria-hidden="true">
            {referenceWires.map((wire) => (
              <path key={wire.id} data-from={wire.from} data-to={wire.to} d={wire.path} />
            ))}
            <path
              ref={wireDraftPathRef}
              className="reference-wire-draft"
              style={{ display: wireDraftFrom ? undefined : "none" }}
            />
          </svg>

          {nodes.map((node) => (
            <div
              key={node.id}
              className="node-shell"
              style={{ left: node.x, top: node.y, width: node.width, height: node.height, zIndex: zIndexById.get(node.id) ?? 1 }}
            >
              <div
                className="node-above-title"
                title={node.title}
                onPointerDown={(event) => onNodePointerDown(event, node)}
              >
                {node.title}
              </div>
              <article
                className={`node-card kind-${node.kind}${selected.includes(node.id) ? " selected" : ""}${activeVersionOf(node).generating ? " generating" : ""}${referenceDropTargetId === node.id ? " reference-target" : ""}`}
                onPointerDown={(event) => onNodePointerDown(event, node)}
                onPointerEnter={() => { if (!panRef.current && !nodeDragRef.current) setHoveredId(node.id); }}
                onPointerLeave={() => { if (!panRef.current && !nodeDragRef.current) setHoveredId(null); }}
                onClick={(event) => event.stopPropagation()}
                onDragStart={(event) => event.preventDefault()}
                onDoubleClick={(event) => {
                  event.stopPropagation();
                  if (node.kind === "smart-canvas") onOpenStudio(node.title || title);
                  else if (node.kind === "image-attempt") {
                    setAttempt(node);
                    loadVersionFields(activeVersionOf(node));
                  } else if (node.kind === "image-stack") setStack(node);
                  else if (node.kind === "svg") setSvgEditor({ id: node.id, svg: node.svg ?? "" });
                  else if (node.kind === "image") {
                    setViewer({
                      title: node.title || "Image",
                      src: node.src,
                      srcId: node.originalSrcId,
                      width: node.originalWidth,
                      height: node.originalHeight,
                    });
                  }
                }}
              >
                <NodeBody node={node} onMediaSize={handleMediaSize} />
                {selected.includes(node.id) ? (
                  <button
                    className="node-resize"
                    aria-label="缩放节点"
                    title="缩放节点"
                    onPointerDown={(event) => {
                      event.stopPropagation();
                      event.currentTarget.setPointerCapture(event.pointerId);
                      resizeSnapshotRef.current = makeSnapshot();
                      resizeMovedRef.current = false;
                      setResize({ id: node.id, startX: event.clientX, startY: event.clientY, width: node.width, height: node.height, k: viewRef.current.k, moved: false });
                    }}
                  />
                ) : null}
              </article>
              {node.kind === "image-attempt" ? <span className="node-port node-port-in" aria-hidden="true" /> : null}
              {node.kind === "image" || node.kind === "svg" ? (
                <span
                  className="node-port node-port-out"
                  aria-hidden="true"
                  title="拖出连线到生成节点左侧"
                  onPointerDown={(event) => beginWireFromNode(event, node)}
                  onPointerMove={(event) => moveWireFromNode(event, node)}
                  onPointerUp={(event) => endWireFromNode(event, node)}
                  onPointerCancel={(event) => cancelWireFromNode(event, node)}
                />
              ) : null}
            </div>
          ))}

          {marquee ? (
            <div
              className="canvas-marquee"
              style={{
                left: Math.min(marquee.x, marquee.x + marquee.w),
                top: Math.min(marquee.y, marquee.y + marquee.h),
                width: Math.abs(marquee.w),
                height: Math.abs(marquee.h),
              }}
            />
          ) : null}
        </div>

        {hovered && !panning ? (
          <div
            ref={hoverBarRef}
            className="canvas-node-hoverbar"
            style={{
              transform: `translate3d(${CANVAS_INSET_X + view.x + (hovered.x + hovered.width / 2) * view.k + 18}px, ${CANVAS_INSET_Y + view.y + (hovered.y + hovered.height) * view.k + 8}px, 0) translateX(-50%)`,
            }}
            onPointerEnter={() => setHoveredId(hovered.id)}
            onPointerLeave={() => setHoveredId(null)}
          >
            {hoverActions.map(([id, label]) => (
              <button
                key={id}
                className={`canvas-node-action canvas-tip${id === "delete" ? " danger" : ""}`}
                aria-label={label}
                data-label={label}
                onClick={(event) => {
                  event.stopPropagation();
                  if (id === "duplicate") duplicateNode(hovered);
                  else if (id === "extract") extractImageNode(hovered);
                  else if (id === "delete") deleteSelection();
                  else if (id === "info") setInfo(hovered);
                  else if (id === "cutout") setAiDialog({ id: "cutout", node: hovered });
                  else if (id === "pbr") setAiDialog({ id: "pbr", node: hovered });
                  else if (id === "upscale") setAiDialog({ id: "upscale", node: hovered });
                  else if (id === "segment") setAiDialog({ id: "segment", node: hovered });
                  else if (id === "angle") setAiDialog({ id: "angle", node: hovered });
                }}
              >
                <CanvasIcon name={HOVER_ICONS[id] ?? "info"} size={15} />
              </button>
            ))}
          </div>
        ) : null}

        {selected.length >= 2 ? (
          <div className="canvas-selection-toolbar">
            {[
              ["left", "Align left", "⇤"],
              ["hcenter", "Align center", "↔"],
              ["right", "Align right", "⇥"],
              ["top", "Align top", "⇧"],
              ["vcenter", "Align middle", "↕"],
              ["bottom", "Align bottom", "⇩"],
            ].map(([axis, label, glyph]) => (
              <button key={axis} className="canvas-tip" aria-label={label} data-label={label} onClick={() => alignSelection(axis as "left")}>{glyph}</button>
            ))}
            <button className="canvas-tip" aria-label="Distribute horizontally" data-label="Distribute horizontally" onClick={() => distributeSelection("h")}>≡</button>
            <button className="canvas-tip" aria-label="Distribute vertically" data-label="Distribute vertically" onClick={() => distributeSelection("v")}>⋮</button>
            <button className="danger canvas-tip" aria-label="Delete selection" data-label="Delete selection" onClick={deleteSelection}>×</button>
          </div>
        ) : null}

        {layerPopover ? (() => {
          const node = nodes.find((item) => item.id === layerPopover);
          if (!node) return null;
          return (
            <div
              className="canvas-layer-popover"
              style={{
                left: CANVAS_INSET_X + view.x + (node.x + node.width / 2) * view.k + 18,
                top: CANVAS_INSET_Y + view.y + (node.y + node.height) * view.k + 8,
              }}
            >
              <div className="canvas-layer-title">Layer <span>1 layer</span></div>
              <button onClick={() => {
                pushHistory();
                setNodes((current) => {
                  const index = current.findIndex((item) => item.id === node.id);
                  if (index <= 0) return current;
                  const next = [...current];
                  [next[index - 1], next[index]] = [next[index], next[index - 1]];
                  return next;
                });
                setLayerPopover(null);
              }}>Bring forward</button>
              <button onClick={() => {
                pushHistory();
                setNodes((current) => {
                  const index = current.findIndex((item) => item.id === node.id);
                  if (index < 0 || index >= current.length - 1) return current;
                  const next = [...current];
                  [next[index + 1], next[index]] = [next[index], next[index + 1]];
                  return next;
                });
                setLayerPopover(null);
              }}>Send backward</button>
              <small>Same layer uses creation order</small>
            </div>
          );
        })() : null}

        {backHold ? (
          <div
            className="canvas-hold-ring"
            style={{ left: backHold.x, top: backHold.y, "--hold-progress": backHold.progress } as React.CSSProperties}
            aria-hidden="true"
          >
            <div className="canvas-hold-halo" />
            <svg className="canvas-hold-arc" viewBox="0 0 52 52">
              <circle className="canvas-hold-track" cx="26" cy="26" r="21" />
              <path className="canvas-hold-progress" d={holdArcPath(backHold.progress)} />
            </svg>
            <CanvasIcon name="home" size={16} className="canvas-hold-home" />
          </div>
        ) : null}
        {zoomBadge ? <div className="canvas-zoom-badge">{Math.round(view.k * 100)}%</div> : null}

        <div className="canvas-dock">
          {[
            ["side", "Side panel", "panel-left"],
            ["image-attempt", "生成", "sparkles"],
            ["image-stack", "Image Stack", "images"],
            ["assets", "Assets", "folder-input"],
            ["smart-canvas", "Smart Canvas", "smart-canvas"],
            ["svg", "SVG", "svg"],
          ].map(([id, label, icon]) => (
            <button
              key={id}
              className={`canvas-dock-btn canvas-tip canvas-tip-up${activeTool === id ? " active" : ""}`}
              data-label={label}
              aria-label={label}
              onClick={() => {
                if (id === "side") setSidebarVisible((value) => !value);
                else if (id === "undo") undoCanvas();
                else if (id === "redo") redoCanvas();
                else if (id === "image-attempt" || id === "image" || id === "image-stack" || id === "assets" || id === "smart-canvas" || id === "svg") addNode(id as NodeKind);
                else setActiveTool(id);
              }}
              disabled={(id === "undo" && historyStats.undo === 0) || (id === "redo" && historyStats.redo === 0)}
            >
              <CanvasIcon name={icon} size={18} />
            </button>
          ))}
        </div>

        {viewer ? (
          <ImageViewer
            title={viewer.title}
            src={viewer.src}
            srcId={viewer.srcId}
            width={viewer.width}
            height={viewer.height}
            onClose={() => setViewer(null)}
          />
        ) : null}

        </main>
      </div>

      {stack ? (
        <div className="canvas-modal-backdrop" onClick={() => setStack(null)}>
          <div className="stack-gallery" onClick={(event) => event.stopPropagation()}>
            <header><strong>{stack.title}</strong><span>{stack.count ?? 4} images</span><button className="row-icon" onClick={() => setStack(null)}><CloseIcon /></button></header>
            <div className="stack-grid">
              {Array.from({ length: stack.count ?? 4 }, (_, index) => (
                <div className={`stack-card ${index === 0 ? "cover" : ""}`} key={index}>
                  <div className="stack-image" />
                  <div className="stack-card-actions">
                    <button>Set cover</button>
                    <button>Take out</button>
                    <button>Download</button>
                  </div>
                </div>
              ))}
            </div>
            <footer><button onClick={() => {
              pushHistory();
              const count = stack.count ?? 4;
              setNodes((current) => [...current, ...Array.from({ length: count }, (_, index) => ({
                id: `n-${Date.now()}-${index}`,
                kind: "image" as NodeKind,
                title: `${stack.title} ${index + 1}`,
                status: "完成",
                x: stack.x + (index % 2) * 380,
                y: stack.y + 360 + Math.floor(index / 2) * 280,
                width: 340,
                height: 240,
                tone: ["forest-a", "forest-b", "forest-c", "forest-d"][index % 4],
              }))]);
              setStack(null);
            }}>Split all</button></footer>
          </div>
        </div>
      ) : null}

      {svgEditor ? (
        <div className="canvas-modal-backdrop" onClick={() => setSvgEditor(null)}>
          <div className="svg-editor-modal" onClick={(event) => event.stopPropagation()}>
            <header>
              <strong>SVG 源码</strong>
              <button className="row-icon" aria-label="关闭" onClick={() => setSvgEditor(null)}><CloseIcon /></button>
            </header>
            <textarea
              className="svg-editor-input"
              autoFocus
              spellCheck={false}
              value={svgEditor.svg}
              placeholder="<svg xmlns=&quot;http://www.w3.org/2000/svg&quot; viewBox=&quot;0 0 400 300&quot;>…</svg>"
              onChange={(event) => setSvgEditor({ ...svgEditor, svg: event.target.value })}
              onKeyDown={(event) => {
                if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
                  event.preventDefault();
                  applySvgEditor();
                }
              }}
            />
            <footer>
              <span className="svg-editor-hint">Ctrl+Enter 应用 · Esc 取消</span>
              <button type="button" onClick={() => setSvgEditor(null)}>取消</button>
              <button type="button" className="primary" onClick={applySvgEditor}>应用</button>
            </footer>
          </div>
        </div>
      ) : null}

      {aiDialog ? (() => {
        const source = displayImageFor(aiDialog.node)?.src ?? aiDialog.node.src ?? "";
        const sourceNode = { x: aiDialog.node.x, y: aiDialog.node.y, width: aiDialog.node.width, height: aiDialog.node.height, title: aiDialog.node.title };
        const close = () => setAiDialog(null);
        const add = (images: NodeAIResultImage[]) => {
          addAIImageNodes(images);
          setAiDialog(null);
        };
        if (aiDialog.id === "cutout") return <CutoutModal source={source} sourceNode={sourceNode} onClose={close} onAdd={add} />;
        if (aiDialog.id === "pbr") return <PBRModal source={source} sourceNode={sourceNode} onClose={close} onAdd={add} />;
        if (aiDialog.id === "upscale") return <UpscaleModal source={source} sourceNode={sourceNode} onClose={close} onAdd={add} />;
        if (aiDialog.id === "segment") return <SegmentModal source={source} sourceNode={sourceNode} onClose={close} onAdd={add} />;
        return <AngleModal source={source} sourceNode={sourceNode} onClose={close} onAdd={add} />;
      })() : null}

      {attempt ? (
        <div className="canvas-modal-backdrop" onClick={() => setAttempt(null)}>
          <div className="attempt-workbench" onClick={(event) => event.stopPropagation()}>
            <header>
              <strong>{attempt.title}</strong>
              <button className="row-icon" onClick={() => setAttempt(null)}><CloseIcon /></button>
            </header>
            <VersionSwitcher
              versions={attemptVersions}
              activeIndex={attemptActiveIndex}
              canCreate={canCreateAttemptVersion}
              onSelect={selectAttemptVersion}
              onCreate={createAttemptVersion}
            />
            <div className="attempt-body attempt-body-single">
              <div className="attempt-left">
                <div className="attempt-reference-block">
                  <div className="attempt-reference-head">
                    <span>输入图片</span>
                    <em>{attemptReferences.length}</em>
                  </div>
                  <div className="attempt-references">
                    {attemptReferences.map((reference) => (
                      <div
                        className={`attempt-reference-chip${insertedReferenceIds.has(reference.id) ? " inserted" : ""}`}
                        key={reference.id}
                        title={`${reference.title} · 拖入 Prompt 作为参考图`}
                        draggable={!attemptLocked}
                        onDragStart={(event) => {
                          event.dataTransfer.setData("application/x-opencanvas-image", reference.id);
                          event.dataTransfer.setData("text/plain", reference.id);
                          event.dataTransfer.effectAllowed = "copy";
                        }}
                      >
                        <img src={reference.src} alt="" draggable={false} />
                        {!attemptLocked ? (
                          <button type="button" draggable={false} aria-label="移除参考图" onPointerDown={(event) => event.stopPropagation()} onClick={() => removeAttemptReference(reference.id)}>×</button>
                        ) : null}
                      </div>
                    ))}
                    {!attemptReferences.length ? (
                      <span className="attempt-references-empty">先把画布图片或 SVG 连接到生成节点，再把缩略图拖进 Prompt（GIF 不支持）</span>
                    ) : null}
                  </div>
                </div>
                <label className="attempt-label">Prompt</label>
                <PromptEditor
                  value={attemptPrompt}
                  placeholder={attemptGif ? "描述主体、动作和循环…把上方输入图片拖进来" : "描述画面；把上方输入图片拖进来作为参考…"}
                  disabled={attemptLocked}
                  images={attemptReferences}
                  onChange={(value) => {
                    setAttemptPrompt(value);
                    saveAttemptConfig({ prompt: value });
                  }}
                  onGenerate={() => {
                    void runGeneration();
                  }}
                />
                <label className="attempt-label">Why this version</label>
                <textarea
                  className="attempt-why-input"
                  value={attemptWhy}
                  disabled={attemptLocked}
                  placeholder="Why this version"
                  onChange={(event) => {
                    const value = event.target.value;
                    setAttemptWhy(value);
                    saveAttemptConfig({ why: value });
                  }}
                  onKeyDown={(event) => {
                    if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
                      event.preventDefault();
                      void runGeneration();
                    }
                  }}
                />
                <div className="attempt-config">
                  <div className="attempt-mode-row">
                    <span>Mode</span>
                    <div className="attempt-mode-switch" role="group" aria-label="Output mode">
                      <button type="button" className={!attemptGif ? "active" : ""} aria-pressed={!attemptGif} disabled={attemptLocked} onClick={() => { setAttemptGif(false); saveAttemptConfig({ gifMode: false }); }}>Still</button>
                      <button type="button" className={attemptGif ? "active" : ""} aria-pressed={attemptGif} disabled={attemptLocked} onClick={() => { setAttemptGif(true); saveAttemptConfig({ gifMode: true }); }}>GIF</button>
                    </div>
                  </div>
                  <ConfigSelect label="Model" value={attemptModel} options={ATTEMPT_MODELS} disabled={attemptLocked} onChange={(value) => { setAttemptModel(value); saveAttemptConfig({ model: value }); }} />
                  {attemptGif ? (
                    <div className="attempt-config-field attempt-config-static">
                      <span>Format</span>
                      <strong>GIF</strong>
                    </div>
                  ) : (
                    <ConfigSelect label="Format" value={attemptFormat} options={ATTEMPT_FORMATS} disabled={attemptLocked} onChange={(next) => { setAttemptFormat(next as StillFormat); saveAttemptConfig({ outputFormat: next as StillFormat }); }} />
                  )}
                  <ConfigSelect label="Aspect" value={attemptAspect} options={ATTEMPT_ASPECTS} disabled={attemptLocked} onChange={(value) => { setAttemptAspect(value); saveAttemptConfig({ aspect: value }); }} columns={3} />
                  <ConfigSelect label="Quality" value={attemptQuality} options={ATTEMPT_QUALITIES} disabled={attemptLocked} onChange={(value) => { setAttemptQuality(value); saveAttemptConfig({ quality: value }); }} />
                  <ConfigSelect label="Complexity" value={attemptComplexity} options={ATTEMPT_COMPLEXITIES} disabled={attemptLocked} onChange={(value) => { setAttemptComplexity(value); saveAttemptConfig({ complexity: value }); }} />
                </div>
                {attemptGif ? (
                  <div className="attempt-gif-options">
                    <label>Frames <input type="number" min={2} max={16} value={attemptFrames} disabled={attemptLocked} onChange={(event) => { const value = Number(event.target.value); setAttemptFrames(value); saveAttemptConfig({ frames: value }); }} /></label>
                    <label>Frame ms <input type="number" min={20} max={2000} step={10} value={attemptFrameMs} disabled={attemptLocked} onChange={(event) => { const value = Number(event.target.value); setAttemptFrameMs(value); saveAttemptConfig({ frameMs: value }); }} /></label>
                  </div>
                ) : null}
                {attemptGif ? (
                  <p className="attempt-gif-hint">
                    GIF 建议在 Prompt 里写明：无缝循环、固定镜头、角色回到起始姿势、背景保持一致。官方默认 9 帧 / 200ms；需要更顺滑可用 16 帧。
                  </p>
                ) : null}
                {attemptDisplayError ? (
                  <div className="attempt-status error">
                    <span>{attemptDisplayError}</span>
                    {attemptDisplayError.toLowerCase().includes("api key") ? (
                      <button type="button" onClick={() => { setAttempt(null); onOpenSettings(); }}>Open Settings</button>
                    ) : null}
                  </div>
                ) : null}
                <div className="attempt-actions">
                  {attemptLocked && attemptVersion && !attemptVersion.generating ? (
                    <button className={`attempt-run${canCreateAttemptVersion ? "" : " historical"}`} type="button" disabled={!canCreateAttemptVersion} title={canCreateAttemptVersion ? "新建版本" : "请先切换到最新版本"} onClick={createAttemptVersion}>New version</button>
                  ) : (
                    <button className="attempt-run" type="button" disabled={Boolean(attemptVersion?.generating)} onClick={runGeneration}>{attemptVersion?.generating ? "Generating…" : "Generate"}</button>
                  )}
                </div>
              </div>
            </div>
          </div>
        </div>
      ) : null}

      {processingImages > 0 ? <div className="canvas-processing">正在处理图片…</div> : null}

      {info ? (
        <div className="canvas-modal-backdrop" onClick={() => setInfo(null)}>
          <div className="canvas-info-modal" onClick={(event) => event.stopPropagation()}>
            <header>
              <strong>Node Info</strong>
              <div style={{ display: "flex", gap: 4 }}>
                <button className="canvas-info-toggle" onClick={() => setInfoJson((value) => !value)}>{infoJson ? "Info" : "JSON"}</button>
                <button className="row-icon" onClick={() => setInfo(null)}><CloseIcon /></button>
              </div>
            </header>
            {infoJson ? (
              <pre className="canvas-info-json">{JSON.stringify(summarizeNodeForInfo(info), null, 2)}</pre>
            ) : [
              ["ID", info.id],
              ["Name", info.title || "—"],
              ["Type", NODE_META[info.kind].label],
              ["Size", `${info.width} × ${info.height}`],
              ["Position", `${Math.round(info.x)}, ${Math.round(info.y)}`],
              ["Status", info.status],
            ].map(([label, value]) => (
              <div className="canvas-info-row" key={label}><span>{label}</span><strong>{value}</strong></div>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}
