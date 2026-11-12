import { useEffect, useRef, useState } from "react";
import { loadStoredImage } from "../lib/canvasStore";
import { dataUrlToBlob, imageExtension, rasterizeSvgDataUrl } from "../lib/imageUtils";
import { CloseIcon } from "./Icons";

type Props = {
  title: string;
  src?: string;
  srcId?: string;
  width?: number;
  height?: number;
  onClose: () => void;
};

type View = { scale: number; x: number; y: number };

const MIN_SCALE = 0.02;
const MAX_SCALE = 8;

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

export function ImageViewer({ title, src, srcId, width, height, onClose }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const zoomLabelRef = useRef<HTMLSpanElement>(null);
  const bitmapRef = useRef<ImageBitmap | null>(null);
  const previewRef = useRef<ImageBitmap | null>(null);
  const viewRef = useRef<View>({ scale: 1, x: 0, y: 0 });
  const fitScaleRef = useRef(1);
  const rafRef = useRef(0);
  const dragRef = useRef<{
    mode: "pan" | "zoom";
    pointerId: number;
    startX: number;
    startY: number;
    viewX: number;
    viewY: number;
    scale: number;
    anchorX: number;
    anchorY: number;
    imageX: number;
    imageY: number;
  } | null>(null);
  const dataUrlRef = useRef("");
  const zoomAtRef = useRef<(clientX: number, clientY: number, factor: number) => void>(() => {});
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [error, setError] = useState("");
  const [dimensions, setDimensions] = useState({ width: width ?? 0, height: height ?? 0 });

  function scheduleDraw() {
    if (rafRef.current) return;
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = 0;
      draw();
    });
  }

  function draw() {
    const canvas = canvasRef.current;
    const container = containerRef.current;
    const bitmap = bitmapRef.current;
    if (!canvas || !container || !bitmap) return;
    const dpr = window.devicePixelRatio || 1;
    const width = Math.max(1, container.clientWidth);
    const height = Math.max(1, container.clientHeight);
    if (canvas.width !== Math.round(width * dpr) || canvas.height !== Math.round(height * dpr)) {
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
    }
    const context = canvas.getContext("2d");
    if (!context) return;
    context.setTransform(dpr, 0, 0, dpr, 0, 0);
    context.clearRect(0, 0, width, height);

    const view = viewRef.current;
    const usePreview = view.scale < 1 && previewRef.current;
    const source = usePreview ? previewRef.current! : bitmap;
    const sourceScale = usePreview ? source.width / bitmap.width : 1;

    const sourceX = Math.max(0, -view.x / view.scale);
    const sourceY = Math.max(0, -view.y / view.scale);
    const sourceWidth = Math.min(bitmap.width - sourceX, width / view.scale);
    const sourceHeight = Math.min(bitmap.height - sourceY, height / view.scale);
    if (sourceWidth <= 0 || sourceHeight <= 0) return;

    const destX = view.x + sourceX * view.scale;
    const destY = view.y + sourceY * view.scale;
    const destWidth = sourceWidth * view.scale;
    const destHeight = sourceHeight * view.scale;

    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = usePreview ? "high" : "medium";
    context.drawImage(
      source,
      sourceX * sourceScale,
      sourceY * sourceScale,
      sourceWidth * sourceScale,
      sourceHeight * sourceScale,
      destX,
      destY,
      destWidth,
      destHeight,
    );
    if (zoomLabelRef.current) zoomLabelRef.current.textContent = `${Math.round(view.scale * 100)}%`;
  }

  function fitToScreen() {
    const container = containerRef.current;
    const bitmap = bitmapRef.current;
    if (!container || !bitmap) return;
    const width = Math.max(1, container.clientWidth);
    const height = Math.max(1, container.clientHeight);
    const scale = clamp(Math.min(width / bitmap.width, height / bitmap.height) * 0.92, MIN_SCALE, MAX_SCALE);
    fitScaleRef.current = scale;
    viewRef.current = {
      scale,
      x: (width - bitmap.width * scale) / 2,
      y: (height - bitmap.height * scale) / 2,
    };
    scheduleDraw();
  }

  function actualSize() {
    const container = containerRef.current;
    const bitmap = bitmapRef.current;
    if (!container || !bitmap) return;
    const width = Math.max(1, container.clientWidth);
    const height = Math.max(1, container.clientHeight);
    viewRef.current = {
      scale: 1,
      x: (width - bitmap.width) / 2,
      y: (height - bitmap.height) / 2,
    };
    scheduleDraw();
  }

  function zoomAt(clientX: number, clientY: number, factor: number) {
    const container = containerRef.current;
    if (!container) return;
    const rect = container.getBoundingClientRect();
    const pointX = clientX - rect.left;
    const pointY = clientY - rect.top;
    const view = viewRef.current;
    const nextScale = clamp(view.scale * factor, MIN_SCALE, MAX_SCALE);
    if (nextScale === view.scale) return;
    const imageX = (pointX - view.x) / view.scale;
    const imageY = (pointY - view.y) / view.scale;
    viewRef.current = {
      scale: nextScale,
      x: pointX - imageX * nextScale,
      y: pointY - imageY * nextScale,
    };
    scheduleDraw();
  }
  zoomAtRef.current = zoomAt;

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        setStatus("loading");
        setError("");
        let data = src ?? "";
        if (srcId) {
          const stored = await loadStoredImage(srcId);
          if (stored) data = stored;
        }
        if (!data) throw new Error("没有可用的原图");
        dataUrlRef.current = data;
        // Chromium's createImageBitmap does not reliably decode SVG blobs.
        // Rasterize vectors for display while keeping the original for download.
        const bitmapSource = data.startsWith("data:image/svg")
          ? await rasterizeSvgDataUrl(data, 8192)
          : data;
        const blob = bitmapSource.startsWith("data:") ? dataUrlToBlob(bitmapSource) : await (await fetch(bitmapSource)).blob();
        const bitmap = await createImageBitmap(blob);
        if (cancelled) {
          bitmap.close();
          return;
        }
        bitmapRef.current = bitmap;
        setDimensions({ width: bitmap.width, height: bitmap.height });

        const maxEdge = 2048;
        if (Math.max(bitmap.width, bitmap.height) > maxEdge) {
          const scale = maxEdge / Math.max(bitmap.width, bitmap.height);
          const resizeWidth = Math.max(1, Math.round(bitmap.width * scale));
          const resizeHeight = Math.max(1, Math.round(bitmap.height * scale));
          try {
            previewRef.current = await createImageBitmap(blob, {
              resizeWidth,
              resizeHeight,
              resizeQuality: "high",
            });
          } catch {
            const canvas = document.createElement("canvas");
            canvas.width = resizeWidth;
            canvas.height = resizeHeight;
            const context = canvas.getContext("2d");
            if (context) {
              context.imageSmoothingEnabled = true;
              context.imageSmoothingQuality = "high";
              context.drawImage(bitmap, 0, 0, resizeWidth, resizeHeight);
              previewRef.current = await createImageBitmap(canvas);
            }
          }
        }
        if (cancelled) return;
        setStatus("ready");
        requestAnimationFrame(() => fitToScreen());
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : String(err));
        setStatus("error");
      }
    }
    void load();
    return () => {
      cancelled = true;
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      bitmapRef.current?.close();
      previewRef.current?.close();
      bitmapRef.current = null;
      previewRef.current = null;
    };
  }, [src, srcId]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
      else if (event.key === "0") fitToScreen();
      else if (event.key === "1") actualSize();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const observer = new ResizeObserver(() => scheduleDraw());
    observer.observe(container);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      event.stopPropagation();
      zoomAtRef.current(event.clientX, event.clientY, Math.exp(-event.deltaY * 0.0015));
    };
    container.addEventListener("wheel", onWheel, { passive: false });
    return () => container.removeEventListener("wheel", onWheel);
  }, []);

  function onPointerDown(event: React.PointerEvent) {
    if (event.button !== 0 && event.button !== 1) return;
    event.preventDefault();
    const container = containerRef.current;
    if (!container) return;
    const rect = container.getBoundingClientRect();
    const view = viewRef.current;
    const pointX = event.clientX - rect.left;
    const pointY = event.clientY - rect.top;
    container.setPointerCapture(event.pointerId);
    if (event.button === 0) {
      dragRef.current = {
        mode: "pan",
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        viewX: view.x,
        viewY: view.y,
        scale: view.scale,
        anchorX: pointX,
        anchorY: pointY,
        imageX: (pointX - view.x) / view.scale,
        imageY: (pointY - view.y) / view.scale,
      };
    } else {
      dragRef.current = {
        mode: "zoom",
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        viewX: view.x,
        viewY: view.y,
        scale: view.scale,
        anchorX: pointX,
        anchorY: pointY,
        imageX: (pointX - view.x) / view.scale,
        imageY: (pointY - view.y) / view.scale,
      };
    }
  }

  function onPointerMove(event: React.PointerEvent) {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    if (drag.mode === "pan") {
      viewRef.current = {
        ...viewRef.current,
        x: drag.viewX + (event.clientX - drag.startX),
        y: drag.viewY + (event.clientY - drag.startY),
      };
    } else {
      const factor = Math.exp((drag.startY - event.clientY) * 0.006);
      const nextScale = clamp(drag.scale * factor, MIN_SCALE, MAX_SCALE);
      viewRef.current = {
        scale: nextScale,
        x: drag.anchorX - drag.imageX * nextScale,
        y: drag.anchorY - drag.imageY * nextScale,
      };
    }
    scheduleDraw();
  }

  function onPointerUp(event: React.PointerEvent) {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    dragRef.current = null;
    containerRef.current?.releasePointerCapture(event.pointerId);
  }

  function onDoubleClick(event: React.MouseEvent) {
    const view = viewRef.current;
    if (Math.abs(view.scale - fitScaleRef.current) < 0.001) {
      actualSize();
    } else {
      fitToScreen();
    }
    event.preventDefault();
  }

  function download() {
    const data = dataUrlRef.current;
    if (!data) return;
    const link = document.createElement("a");
    link.download = `${title || "image"}.${imageExtension(data)}`;
    link.href = data;
    link.click();
  }

  return (
    <div
      className="image-viewer"
      onPointerDown={(event) => event.stopPropagation()}
      onPointerMove={(event) => event.stopPropagation()}
      onPointerUp={(event) => event.stopPropagation()}
      onPointerCancel={(event) => event.stopPropagation()}
      onWheel={(event) => event.stopPropagation()}
      onContextMenu={(event) => event.stopPropagation()}
      onDragOver={(event) => event.stopPropagation()}
      onDrop={(event) => event.stopPropagation()}
    >
      <header className="image-viewer-top">
        <button className="image-viewer-back" onClick={onClose} aria-label="关闭查看器">
          <CloseIcon />
          <span>关闭</span>
        </button>
        <div className="image-viewer-title">
          <strong>{title || "Image"}</strong>
          <span>{dimensions.width} × {dimensions.height}</span>
        </div>
        <div className="image-viewer-actions">
          <span ref={zoomLabelRef} className="image-viewer-zoom">100%</span>
          <button onClick={fitToScreen}>适应</button>
          <button onClick={actualSize}>100%</button>
          <button onClick={download}>下载</button>
        </div>
      </header>
      <div
        ref={containerRef}
        className="image-viewer-canvas-wrap"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onDoubleClick={onDoubleClick}
        onContextMenu={(event) => event.preventDefault()}
      >
        <canvas ref={canvasRef} className="image-viewer-canvas" />
        {status === "loading" ? <div className="image-viewer-loading">加载原图…</div> : null}
        {status === "error" ? <div className="image-viewer-loading error">{error}</div> : null}
        <div className="image-viewer-hint">左键拖拽平移 · 滚轮 / 中键拖拽缩放 · 双击切换适应/100% · Esc 返回</div>
      </div>
    </div>
  );
}
