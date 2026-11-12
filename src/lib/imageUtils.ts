export const CANVAS_IMAGE_MAX_EDGE = 2048;

export type ImageAsset = {
  src: string;
  width: number;
  height: number;
  downscaled: boolean;
};

function loadImageElement(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("无法读取图片"));
    image.src = src;
  });
}

export function dataUrlToBlob(dataUrl: string): Blob {
  const comma = dataUrl.indexOf(",");
  if (comma < 0) throw new Error("Invalid data URL");
  const header = dataUrl.slice(0, comma);
  const payload = dataUrl.slice(comma + 1);
  const mime = /^data:([^;]+)/.exec(header)?.[1] || "application/octet-stream";
  if (!header.includes(";base64")) {
    return new Blob([decodeURIComponent(payload)], { type: mime });
  }
  const binary = atob(payload);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return new Blob([bytes], { type: mime });
}

async function sourceToBlob(src: string): Promise<Blob> {
  if (src.startsWith("data:")) return dataUrlToBlob(src);
  return (await fetch(src)).blob();
}

/**
 * Convert an SVG data URL to a raster PNG data URL. OpenRouter's image input
 * only accepts raster formats (PNG/JPEG/WebP/GIF), so vector canvas images must
 * be rasterized before they are sent as generation references.
 */
export async function rasterizeSvgDataUrl(src: string, maxEdge = CANVAS_IMAGE_MAX_EDGE): Promise<string> {
  if (!src.startsWith("data:image/svg")) return src;
  const image = await loadImageElement(src);
  const width = image.naturalWidth || 1024;
  const height = image.naturalHeight || 1024;
  const scale = Math.min(1, maxEdge / Math.max(width, height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(width * scale));
  canvas.height = Math.max(1, Math.round(height * scale));
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Canvas unavailable");
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = "high";
  context.drawImage(image, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL("image/png");
}

export async function getImageDimensions(src: string): Promise<{ width: number; height: number }> {
  if (src.startsWith("data:image/svg")) {
    const image = await loadImageElement(src);
    return { width: image.naturalWidth, height: image.naturalHeight };
  }
  try {
    const blob = await sourceToBlob(src);
    const bitmap = await createImageBitmap(blob);
    const size = { width: bitmap.width, height: bitmap.height };
    bitmap.close();
    return size;
  } catch {
    const image = await loadImageElement(src);
    return { width: image.naturalWidth, height: image.naturalHeight };
  }
}

/**
 * Downscale a static raster image for canvas-node display. Animated GIFs and
 * SVGs are left untouched; the original stays available to the viewer.
 */
export async function downscaleDataUrl(src: string, maxEdge = CANVAS_IMAGE_MAX_EDGE): Promise<ImageAsset> {
  if (
    !src.startsWith("data:image/") ||
    src.startsWith("data:image/gif") ||
    src.startsWith("data:image/svg")
  ) {
    const size = await getImageDimensions(src).catch(() => ({ width: 0, height: 0 }));
    return { src, ...size, downscaled: false };
  }

  let bitmap: ImageBitmap | null = null;
  try {
    const blob = await sourceToBlob(src);
    bitmap = await createImageBitmap(blob);
  } catch {
    const image = await loadImageElement(src);
    const originalWidth = image.naturalWidth;
    const originalHeight = image.naturalHeight;
    const max = Math.max(originalWidth, originalHeight);
    if (max <= maxEdge) {
      return { src, width: originalWidth, height: originalHeight, downscaled: false };
    }
    const scale = maxEdge / max;
    const width = Math.max(1, Math.round(originalWidth * scale));
    const height = Math.max(1, Math.round(originalHeight * scale));
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Canvas unavailable");
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = "high";
    context.drawImage(image, 0, 0, width, height);
    const mime = src.startsWith("data:image/jpeg") ? "image/jpeg" : src.startsWith("data:image/webp") ? "image/webp" : "image/png";
    return { src: canvas.toDataURL(mime, 0.92), width: originalWidth, height: originalHeight, downscaled: true };
  }

  const width = bitmap.width;
  const height = bitmap.height;
  const max = Math.max(width, height);
  if (max <= maxEdge) {
    bitmap.close();
    return { src, width, height, downscaled: false };
  }
  const scale = maxEdge / max;
  const targetWidth = Math.max(1, Math.round(width * scale));
  const targetHeight = Math.max(1, Math.round(height * scale));
  const canvas = document.createElement("canvas");
  canvas.width = targetWidth;
  canvas.height = targetHeight;
  const context = canvas.getContext("2d");
  if (!context) {
    bitmap.close();
    throw new Error("Canvas unavailable");
  }
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = "high";
  context.drawImage(bitmap, 0, 0, targetWidth, targetHeight);
  bitmap.close();
  const mime = src.startsWith("data:image/jpeg") ? "image/jpeg" : src.startsWith("data:image/webp") ? "image/webp" : "image/png";
  return { src: canvas.toDataURL(mime, 0.92), width, height, downscaled: true };
}

export function imageExtension(src: string): string {
  const match = /^data:image\/([a-z0-9.+-]+);/i.exec(src);
  if (match) {
    const type = match[1].toLowerCase();
    if (type.includes("gif")) return "gif";
    if (type.includes("jpeg") || type.includes("jpg")) return "jpg";
    if (type.includes("webp")) return "webp";
    if (type.includes("svg")) return "svg";
  }
  return "png";
}
