export type CaptureNode = {
  id: string;
  kind: string;
  title?: string;
  src?: string;
  svg?: string;
  width?: number;
  height?: number;
};

export type NodeCapture = {
  dataUrl: string;
  width: number;
  height: number;
  nodeId: string;
  title: string;
  kind: string;
};

const CAPTURE_MAX_EDGE = 2048;

function loadImageElement(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("无法读取节点图片"));
    image.src = src;
  });
}

function svgSize(markup: string): { width: number; height: number } {
  const tag = /<svg\b[^>]*>/i.exec(markup)?.[0] ?? "";
  const read = (name: string) => {
    const match = new RegExp(`\\b${name}\\s*=\\s*["']\\s*([\\d.]+)`, "i").exec(tag);
    return match ? Number(match[1]) : 0;
  };
  const width = read("width");
  const height = read("height");
  if (width > 0 && height > 0) return { width, height };
  const viewBox = /\bviewBox\s*=\s*["']\s*[-\d.]+[\s,]+[-\d.]+[\s,]+([\d.]+)[\s,]+([\d.]+)/i.exec(tag);
  if (viewBox) {
    const boxWidth = Number(viewBox[1]);
    const boxHeight = Number(viewBox[2]);
    if (boxWidth > 0 && boxHeight > 0) return { width: boxWidth, height: boxHeight };
  }
  return { width: width || 1024, height: height || 1024 };
}

/**
 * Render one node's visual output to a standalone PNG.
 *
 * SVG nodes are re-rendered from their markup at up to 2048px on the long edge
 * so the capture stays crisp. Raster nodes keep their natural size (already
 * capped at 2048 on the canvas) and never upscale.
 */
export async function captureNodeImage(node: CaptureNode): Promise<NodeCapture> {
  const kind = String(node.kind || "");
  let src = String(node.src || "");
  let width = 0;
  let height = 0;
  let vector = false;

  if (kind === "svg") {
    const markup = String(node.svg || "");
    if (!markup.trim()) throw new Error("SVG 节点还没有源码");
    const size = svgSize(markup);
    width = size.width;
    height = size.height;
    src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(markup)}`;
    vector = true;
  } else if (!src) {
    throw new Error("节点没有可截图的图片");
  }

  const image = await loadImageElement(src);
  if (!width || !height) {
    width = image.naturalWidth || node.width || 1024;
    height = image.naturalHeight || node.height || 1024;
  }

  const longEdge = Math.max(width, height);
  const scale = vector
    ? CAPTURE_MAX_EDGE / longEdge
    : Math.min(1, CAPTURE_MAX_EDGE / longEdge);
  const targetWidth = Math.max(1, Math.round(width * scale));
  const targetHeight = Math.max(1, Math.round(height * scale));

  const canvas = document.createElement("canvas");
  canvas.width = targetWidth;
  canvas.height = targetHeight;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Canvas unavailable");
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = "high";
  context.drawImage(image, 0, 0, targetWidth, targetHeight);

  return {
    dataUrl: canvas.toDataURL("image/png"),
    width: targetWidth,
    height: targetHeight,
    nodeId: node.id,
    title: node.title || "",
    kind,
  };
}
