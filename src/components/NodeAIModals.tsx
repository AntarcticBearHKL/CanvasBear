import { useEffect, useState, type ReactNode } from "react";
import { ensureLocalModels } from "../lib/localModelGate";
import { CloseIcon } from "./Icons";

export type NodeAIToolId = "cutout" | "pbr" | "upscale" | "segment" | "angle";

export type NodeAIResultImage = {
  title: string;
  src: string;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
};

type SourceNode = { x: number; y: number; width: number; height: number; title: string };

type CommonProps = {
  source: string;
  sourceNode: SourceNode;
  onClose: () => void;
  onAdd: (images: NodeAIResultImage[]) => void;
};

type Part = {
  name: string;
  png: string;
  preview?: string;
  bounds: { x: number; y: number; width: number; height: number };
};

export const PBR_ORDER = ["baseColor", "height", "normal", "roughness", "metallic", "ao"];
export const PBR_LABELS: Record<string, string> = {
  baseColor: "BaseColor",
  height: "Height",
  normal: "Normal",
  roughness: "Roughness",
  metallic: "Metallic",
  ao: "AO",
};

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("无法读取图片"));
    image.src = src;
  });
}

async function cropPart(png: string, bounds: { x: number; y: number; width: number; height: number }): Promise<string> {
  const image = await loadImage(png);
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, bounds.width);
  canvas.height = Math.max(1, bounds.height);
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Canvas unavailable");
  context.drawImage(image, bounds.x, bounds.y, bounds.width, bounds.height, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL("image/png");
}

function useBusyTimer(busy: boolean) {
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    if (!busy) {
      setElapsed(0);
      return;
    }
    const started = Date.now();
    setElapsed(0);
    const timer = window.setInterval(() => setElapsed(Math.round((Date.now() - started) / 1000)), 1000);
    return () => window.clearInterval(timer);
  }, [busy]);
  return elapsed;
}

function useEscape(busy: boolean, onClose: () => void) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !busy) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [busy, onClose]);
}

function ModalShell({
  title,
  subtitle,
  size,
  busy,
  onClose,
  children,
}: {
  title: string;
  subtitle: string;
  size: "cutout" | "pbr" | "upscale" | "segment" | "angle";
  busy: boolean;
  onClose: () => void;
  children: ReactNode;
}) {
  useEscape(busy, onClose);
  return (
    <div className="canvas-modal-backdrop" onClick={() => { if (!busy) onClose(); }}>
      <div className={`node-ai-modal node-ai-modal-${size}`} onClick={(event) => event.stopPropagation()}>
        <header className="node-ai-head">
          <div><strong>{title}</strong><span>{subtitle}</span></div>
          <button className="row-icon" aria-label="关闭" onClick={() => { if (!busy) onClose(); }}><CloseIcon /></button>
        </header>
        <div className="node-ai-single">{children}</div>
      </div>
    </div>
  );
}

function ModalStatus({ busy, elapsed, status, error }: { busy: boolean; elapsed: number; status: string; error: string }) {
  return (
    <>
      {error ? <div className="ai-error">{error}</div> : null}
      {busy || status ? <div className="ai-status">{busy ? `${status || "Working…"} · ${elapsed}s` : status}</div> : null}
    </>
  );
}

export function CutoutModal({ source, sourceNode, onClose, onAdd }: CommonProps) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");
  const [cutout, setCutout] = useState<{ foreground: string; mask: string } | null>(null);
  const elapsed = useBusyTimer(busy);
  const ai = window.openCanvasDesktop?.ai;

  async function runCutout() {
    if (!ai) return setError("AI bridge unavailable. Restart the desktop app.");
    if (!source) return setError("当前节点没有可用的图片。");
    setBusy(true);
    setError("");
    setStatus("BiRefNet 正在抠图…");
    try {
      await ensureLocalModels(["birefnet"], setStatus);
      const result = await ai.cutout(source);
      setCutout({ foreground: result.foreground, mask: result.mask });
      setStatus("抠图完成");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setStatus("");
    } finally {
      setBusy(false);
    }
  }

  function applyCutout() {
    if (!cutout) return;
    onAdd([{
      title: `${sourceNode.title} · Cutout`,
      src: cutout.foreground,
      x: sourceNode.x + 32,
      y: sourceNode.y + 32,
      width: sourceNode.width,
      height: sourceNode.height,
    }]);
  }

  return (
    <ModalShell title="AI Cutout" subtitle="BiRefNet · local" size="cutout" busy={busy} onClose={onClose}>
      <p className="node-ai-note">从当前节点图片提取透明前景和蒙版，结果作为新节点加入。</p>
      <button className="ai-run" disabled={busy || !source} onClick={runCutout}>{busy ? "Working…" : "Remove Background"}</button>
      {cutout ? (
        <div className="ai-cutout-result">
          <div className="ai-image-box"><img src={cutout.foreground} alt="" /></div>
          <div className="ai-image-box ai-mask-box"><img src={cutout.mask} alt="" /></div>
          <button className="ai-apply" onClick={applyCutout}>Add Cutout Node</button>
        </div>
      ) : null}
      <ModalStatus busy={busy} elapsed={elapsed} status={status} error={error} />
    </ModalShell>
  );
}

export function PBRModal({ source, sourceNode, onClose, onAdd }: CommonProps) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");
  const [pbr, setPbr] = useState<Record<string, string> | null>(null);
  const [normalConvention, setNormalConvention] = useState("opengl");
  const [tileable, setTileable] = useState(false);
  const elapsed = useBusyTimer(busy);
  const ai = window.openCanvasDesktop?.ai;

  async function runPBR() {
    if (!ai) return setError("AI bridge unavailable. Restart the desktop app.");
    if (!source) return setError("当前节点没有可用的图片。");
    setBusy(true);
    setError("");
    setStatus("正在生成 PBR 通道…");
    try {
      await ensureLocalModels(["depth-anything-v2-small"], setStatus);
      const result = await ai.pbr({ image: source, normalConvention, tileable });
      setPbr(result.maps);
      setStatus("PBR 通道完成");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setStatus("");
    } finally {
      setBusy(false);
    }
  }

  function applyPBR() {
    if (!pbr) return;
    const images = PBR_ORDER.filter((key) => pbr[key]).map((key, index) => ({
      title: `PBR ${PBR_LABELS[key]}`,
      src: pbr[key],
      x: sourceNode.x + sourceNode.width + 60 + (index % 3) * (sourceNode.width * 0.75 + 20),
      y: sourceNode.y + Math.floor(index / 3) * (sourceNode.height * 0.75 + 20),
      width: sourceNode.width * 0.75,
      height: sourceNode.height * 0.75,
    }));
    onAdd(images);
  }

  return (
    <ModalShell title="Image → PBR" subtitle="Material extraction · local" size="pbr" busy={busy} onClose={onClose}>
      <p className="node-ai-note">生成 BaseColor、Height、Normal、Roughness、Metallic、AO 六张图。</p>
      <div className="node-ai-fields">
        <label className="node-ai-field"><span>Normal</span><select value={normalConvention} onChange={(event) => setNormalConvention(event.target.value)}><option value="opengl">OpenGL</option><option value="directx">DirectX</option></select></label>
        <label className="node-ai-field node-ai-check"><span>Tileable</span><input type="checkbox" checked={tileable} onChange={(event) => setTileable(event.target.checked)} /></label>
      </div>
      <button className="ai-run" disabled={busy || !source} onClick={runPBR}>{busy ? "Working…" : "Generate PBR"}</button>
      {pbr ? (
        <div className="ai-map-grid">
          {Object.entries(pbr).map(([key, value]) => (
            <div className="ai-map-card" key={key}>
              <div className="ai-map-preview" style={{ backgroundImage: `url("${value}")` }} />
              <span>{PBR_LABELS[key] ?? key}</span>
            </div>
          ))}
          <button className="ai-apply" onClick={applyPBR}>Add 6 PBR Nodes</button>
        </div>
      ) : null}
      <ModalStatus busy={busy} elapsed={elapsed} status={status} error={error} />
    </ModalShell>
  );
}

export function UpscaleModal({ source, sourceNode, onClose, onAdd }: CommonProps) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");
  const [mode, setMode] = useState<"scale" | "target">("scale");
  const [scale, setScale] = useState(2);
  const [target, setTarget] = useState(2048);
  const [method, setMethod] = useState("lanczos");
  const [sourceSize, setSourceSize] = useState<{ width: number; height: number } | null>(null);
  const [upscaled, setUpscaled] = useState<{ image: string; width: number; height: number; scale: number; method: string } | null>(null);
  const elapsed = useBusyTimer(busy);
  const ai = window.openCanvasDesktop?.ai;

  useEffect(() => {
    let alive = true;
    if (!source) {
      setSourceSize(null);
      return;
    }
    loadImage(source)
      .then((image) => {
        if (alive) setSourceSize({ width: image.naturalWidth, height: image.naturalHeight });
      })
      .catch(() => {
        if (alive) setSourceSize(null);
      });
    return () => {
      alive = false;
    };
  }, [source]);

  const estimate = sourceSize ? (() => {
    const maxSource = Math.max(1, Math.max(sourceSize.width, sourceSize.height));
    let value = mode === "scale" ? scale : target / maxSource;
    value = Math.min(value, 8192 / maxSource);
    value = Math.max(0.05, value);
    return {
      width: Math.max(1, Math.round(sourceSize.width * value)),
      height: Math.max(1, Math.round(sourceSize.height * value)),
    };
  })() : null;

  async function runUpscale() {
    if (!ai) return setError("AI bridge unavailable. Restart the desktop app.");
    if (!source) return setError("当前节点没有可用的图片。");
    setBusy(true);
    setError("");
    setStatus("正在放大…");
    try {
      const result = await ai.upscale({
        image: source,
        scale: mode === "scale" ? scale : undefined,
        targetLongEdge: mode === "target" ? target : undefined,
        method,
      });
      setUpscaled(result);
      setStatus(`放大完成 · ${result.width} × ${result.height}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setStatus("");
    } finally {
      setBusy(false);
    }
  }

  function applyUpscale() {
    if (!upscaled) return;
    const ratioW = sourceSize ? upscaled.width / Math.max(1, sourceSize.width) : upscaled.scale;
    const ratioH = sourceSize ? upscaled.height / Math.max(1, sourceSize.height) : upscaled.scale;
    onAdd([{
      title: `${sourceNode.title} · ${upscaled.width}×${upscaled.height}`,
      src: upscaled.image,
      x: sourceNode.x + 40,
      y: sourceNode.y + 40,
      width: sourceNode.width * ratioW,
      height: sourceNode.height * ratioH,
    }]);
  }

  return (
    <ModalShell title="Upscale" subtitle="Local resize · algorithm select" size="upscale" busy={busy} onClose={onClose}>
      <p className="node-ai-note">按倍率或目标分辨率放大当前节点图片，结果作为新节点加入。</p>
      <div className="node-ai-mode">
        <button type="button" className={mode === "scale" ? "active" : ""} onClick={() => setMode("scale")}>Scale</button>
        <button type="button" className={mode === "target" ? "active" : ""} onClick={() => setMode("target")}>Target size</button>
      </div>
      {mode === "scale" ? (
        <div className="node-ai-chips">
          {[2, 3, 4].map((value) => (
            <button key={value} type="button" className={scale === value ? "active" : ""} onClick={() => setScale(value)}>{value}x</button>
          ))}
        </div>
      ) : (
        <div className="node-ai-target">
          <div className="node-ai-chips">
            {[1024, 2048, 4096, 8192].map((value) => (
              <button key={value} type="button" className={target === value ? "active" : ""} onClick={() => setTarget(value)}>{value}</button>
            ))}
          </div>
          <label className="node-ai-field"><span>Long edge</span><input type="number" min={256} max={8192} step={64} value={target} onChange={(event) => setTarget(Math.max(256, Math.min(8192, Number(event.target.value))))} /><em>px</em></label>
        </div>
      )}
      <label className="node-ai-field">
        <span>Algorithm</span>
        <select value={method} onChange={(event) => setMethod(event.target.value)}>
          <option value="lanczos">Lanczos + Sharpen</option>
          <option value="bicubic">Bicubic + Sharpen</option>
          <option value="bilinear">Bilinear</option>
          <option value="nearest">Nearest</option>
        </select>
      </label>
      <div className="node-ai-estimate">
        <span>Source {sourceSize ? `${sourceSize.width} × ${sourceSize.height}` : "—"}</span>
        <span>Output {estimate ? `${estimate.width} × ${estimate.height}` : "—"}</span>
      </div>
      <button className="ai-run" disabled={busy || !source} onClick={runUpscale}>{busy ? "Working…" : "Upscale"}</button>
      {upscaled ? (
        <div className="node-ai-result">
          <div className="ai-image-box"><img src={upscaled.image} alt="" /></div>
          <div className="node-ai-result-meta"><span>{upscaled.width} × {upscaled.height} · {upscaled.method}</span><button className="ai-apply" onClick={applyUpscale}>Add Upscaled Node</button></div>
        </div>
      ) : null}
      <ModalStatus busy={busy} elapsed={elapsed} status={status} error={error} />
    </ModalShell>
  );
}

export function SegmentModal({ source, sourceNode, onClose, onAdd }: CommonProps) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");
  const [resolution, setResolution] = useState(768);
  const [parts, setParts] = useState<Part[]>([]);
  const [selectedParts, setSelectedParts] = useState<Record<string, boolean>>({});
  const elapsed = useBusyTimer(busy);
  const ai = window.openCanvasDesktop?.ai;

  async function runSegment() {
    if (!ai) return setError("AI bridge unavailable. Restart the desktop app.");
    if (!source) return setError("当前节点没有可用的图片。");
    setBusy(true);
    setError("");
    setStatus("See-through 正在拆件，首次可能需要数分钟…");
    try {
      await ensureLocalModels(["seethrough-layerdiff3d", "seethrough-marigold"], setStatus);
      const result = await ai.spine({ image: source, resolution, resolutionDepth: Math.min(768, resolution) });
      const withPreviews = await Promise.all(result.parts.map(async (part) => ({
        ...part,
        preview: await cropPart(part.png, part.bounds),
      })));
      setParts(withPreviews);
      setSelectedParts(Object.fromEntries(result.parts.map((part) => [part.name, true])));
      setStatus(result.cached ? `拆出 ${result.partCount} 个部件（本地缓存）` : `拆出 ${result.partCount} 个部件 · ${Math.round(result.elapsed)}s`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setStatus("");
    } finally {
      setBusy(false);
    }
  }

  async function applySegment() {
    const chosen = parts.filter((part) => selectedParts[part.name] !== false);
    if (!chosen.length) return;
    setBusy(true);
    setError("");
    try {
      const image = await loadImage(source);
      const scaleX = sourceNode.width / Math.max(1, image.naturalWidth);
      const scaleY = sourceNode.height / Math.max(1, image.naturalHeight);
      const images = chosen.map((part) => ({
        title: `${sourceNode.title} · ${part.name}`,
        src: part.preview ?? part.png,
        x: sourceNode.x + part.bounds.x * scaleX,
        y: sourceNode.y + part.bounds.y * scaleY,
        width: Math.max(24, part.bounds.width * scaleX),
        height: Math.max(24, part.bounds.height * scaleY),
      }));
      onAdd(images);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <ModalShell title="Segment" subtitle="See-through · local" size="segment" busy={busy} onClose={onClose}>
      <p className="node-ai-note">把当前角色图拆成独立部件，勾选后作为独立节点加入画布。</p>
      <div className="node-ai-chips">
        {[512, 768, 1024].map((value) => (
          <button key={value} type="button" className={resolution === value ? "active" : ""} onClick={() => setResolution(value)}>{value}</button>
        ))}
      </div>
      <button className="ai-run" disabled={busy || !source} onClick={runSegment}>{busy ? "Splitting…" : "Split Parts"}</button>
      {parts.length ? (
        <div className="ai-spine-result">
          <div className="ai-spine-grid">
            {parts.map((part) => (
              <label className="ai-part" key={part.name}>
                <input type="checkbox" checked={selectedParts[part.name] !== false} onChange={(event) => setSelectedParts((current) => ({ ...current, [part.name]: event.target.checked }))} />
                <img src={part.preview ?? part.png} alt="" />
                <span>{part.name}</span>
              </label>
            ))}
          </div>
          <button className="ai-apply" disabled={!parts.some((part) => selectedParts[part.name] !== false)} onClick={applySegment}>
            Add Selected Parts ({parts.filter((part) => selectedParts[part.name] !== false).length})
          </button>
        </div>
      ) : null}
      <ModalStatus busy={busy} elapsed={elapsed} status={status} error={error} />
    </ModalShell>
  );
}

export function AngleModal({ source, sourceNode, onClose, onAdd }: CommonProps) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");
  const [yaw, setYaw] = useState(0);
  const [pitch, setPitch] = useState(0);
  const [zoom, setZoom] = useState(1);
  const [angleImage, setAngleImage] = useState<string | null>(null);
  const elapsed = useBusyTimer(busy);
  const ai = window.openCanvasDesktop?.ai;

  async function runAngle() {
    if (!ai) return setError("AI bridge unavailable. Restart the desktop app.");
    if (!source) return setError("当前节点没有可用的图片。");
    setBusy(true);
    setError("");
    setStatus("正在生成角度…");
    try {
      const result = await ai.angle({ image: source, yaw, pitch, zoom });
      setAngleImage(result.image);
      setStatus("角度生成完成");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setStatus("");
    } finally {
      setBusy(false);
    }
  }

  function applyAngle() {
    if (!angleImage) return;
    onAdd([{
      title: `${sourceNode.title} · Angle`,
      src: angleImage,
      x: sourceNode.x + 40,
      y: sourceNode.y + 40,
      width: sourceNode.width,
      height: sourceNode.height,
    }]);
  }

  return (
    <ModalShell title="Camera Angle" subtitle="Perspective · local" size="angle" busy={busy} onClose={onClose}>
      <p className="node-ai-note">调整水平/垂直角度和缩放，生成新的视角节点。</p>
      <div className="ai-image-box node-ai-angle-stage">
        {source ? <img src={source} alt="" draggable={false} style={{ transform: `perspective(700px) rotateY(${yaw}deg) rotateX(${-pitch}deg) scale(${zoom})` }} /> : <span>No image</span>}
      </div>
      <label className="node-ai-slider"><span>Yaw</span><input type="range" min={-45} max={45} value={yaw} onChange={(event) => setYaw(Number(event.target.value))} /><em>{yaw}°</em></label>
      <label className="node-ai-slider"><span>Pitch</span><input type="range" min={-30} max={30} value={pitch} onChange={(event) => setPitch(Number(event.target.value))} /><em>{pitch}°</em></label>
      <label className="node-ai-slider"><span>Zoom</span><input type="range" min={0.8} max={1.4} step={0.05} value={zoom} onChange={(event) => setZoom(Number(event.target.value))} /><em>{zoom.toFixed(2)}x</em></label>
      <button className="ai-run" disabled={busy || !source} onClick={runAngle}>{busy ? "Working…" : "Generate Angle"}</button>
      {angleImage ? (
        <div className="node-ai-result">
          <div className="ai-image-box"><img src={angleImage} alt="" /></div>
          <div className="node-ai-result-meta"><span>Yaw {yaw}° · Pitch {pitch}°</span><button className="ai-apply" onClick={applyAngle}>Add Angle Node</button></div>
        </div>
      ) : null}
      <ModalStatus busy={busy} elapsed={elapsed} status={status} error={error} />
    </ModalShell>
  );
}
