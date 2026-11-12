import { useEffect, useState } from "react";
import { ensureLocalModels } from "../lib/localModelGate";
import { CloseIcon } from "./Icons";

type Props = {
  source: string;
  onClose: () => void;
  onApplyCutout: (foreground: string, mask: string) => void;
  onApplyPBR: (maps: Record<string, string>) => void;
  onApplySpine: (parts: Array<{ name: string; png: string }>) => void;
};

type Tab = "cutout" | "material" | "spine";

const MAP_LABELS: Record<string, string> = {
  baseColor: "Base Color",
  height: "Height",
  normal: "Normal",
  roughness: "Roughness",
  metallic: "Metallic",
  ao: "AO",
};

function SpinePartThumb({ part }: { part: { png: string; bounds: { x: number; y: number; width: number; height: number } } }) {
  const [src, setSrc] = useState(part.png);
  useEffect(() => {
    let alive = true;
    const image = new Image();
    image.onload = () => {
      if (!alive) return;
      const { x, y, width, height } = part.bounds;
      const scale = Math.min(180 / Math.max(1, width), 180 / Math.max(1, height), 1);
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(width * scale));
      canvas.height = Math.max(1, Math.round(height * scale));
      const context = canvas.getContext("2d");
      if (!context) return;
      context.drawImage(image, x, y, width, height, 0, 0, canvas.width, canvas.height);
      setSrc(canvas.toDataURL("image/png"));
    };
    image.src = part.png;
    return () => {
      alive = false;
    };
  }, [part.png, part.bounds.x, part.bounds.y, part.bounds.width, part.bounds.height]);
  return <img src={src} alt="" />;
}

export function AIPanel({ source, onClose, onApplyCutout, onApplyPBR, onApplySpine }: Props) {
  const [tab, setTab] = useState<Tab>("cutout");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");
  const [cutout, setCutout] = useState<{ foreground: string; mask: string } | null>(null);
  const [pbr, setPbr] = useState<Record<string, string> | null>(null);
  const [spine, setSpine] = useState<Array<{ name: string; png: string; bounds: { x: number; y: number; width: number; height: number } }> | null>(null);
  const [selectedParts, setSelectedParts] = useState<Record<string, boolean>>({});
  const [normalConvention, setNormalConvention] = useState("opengl");
  const [tileable, setTileable] = useState(false);
  const [resolution, setResolution] = useState(768);
  const [engine, setEngine] = useState<{ state: "checking" | "ready" | "error"; label: string }>({ state: "checking", label: "正在连接本地 AI…" });
  const [elapsed, setElapsed] = useState(0);
  const ai = window.openCanvasDesktop?.ai;

  useEffect(() => {
    if (!busy) {
      setElapsed(0);
      return;
    }
    const started = Date.now();
    setElapsed(0);
    const timer = window.setInterval(() => {
      setElapsed(Math.round((Date.now() - started) / 1000));
    }, 1000);
    return () => window.clearInterval(timer);
  }, [busy]);

  useEffect(() => {
    let alive = true;
    if (!ai) {
      setEngine({ state: "error", label: "AI 桥接不可用" });
      return;
    }
    ai.status()
      .then((result) => {
        if (!alive) return;
        if (result.ok) {
          setEngine({
            state: "ready",
            label: result.gpu ? `GPU · ${result.gpuName || "CUDA"}` : "CPU 模式",
          });
        } else {
          setEngine({ state: "error", label: result.error || "本地 AI 未就绪" });
        }
      })
      .catch((error) => {
        if (!alive) return;
        setEngine({ state: "error", label: error instanceof Error ? error.message : String(error) });
      });
    return () => {
      alive = false;
    };
  }, []);

  async function runCutout() {
    if (!ai) return setError("AI bridge unavailable. Restart the desktop app.");
    setBusy(true); setError(""); setStatus("BiRefNet 正在抠图…");
    try {
      await ensureLocalModels(["birefnet"], setStatus);
      const result = await ai.cutout(source);
      setCutout({ foreground: result.foreground, mask: result.mask });
      setStatus("抠图完成");
    } catch (err) { setError(err instanceof Error ? err.message : String(err)); setStatus(""); }
    finally { setBusy(false); }
  }

  async function runPBR() {
    if (!ai) return setError("AI bridge unavailable. Restart the desktop app.");
    setBusy(true); setError(""); setStatus("正在生成 PBR 通道…");
    try {
      await ensureLocalModels(["depth-anything-v2-small"], setStatus);
      const result = await ai.pbr({ image: source, normalConvention, tileable });
      setPbr(result.maps);
      setStatus("PBR 通道完成");
    } catch (err) { setError(err instanceof Error ? err.message : String(err)); setStatus(""); }
    finally { setBusy(false); }
  }

  async function runSpine() {
    if (!ai) return setError("AI bridge unavailable. Restart the desktop app.");
    setBusy(true); setError(""); setStatus("See-through 正在拆件，首次运行会加载模型，可能需要数分钟…");
    try {
      await ensureLocalModels(["seethrough-layerdiff3d", "seethrough-marigold"], setStatus);
      const result = await ai.spine({ image: source, resolution, resolutionDepth: Math.min(768, resolution) });
      setSpine(result.parts);
      setSelectedParts(Object.fromEntries(result.parts.map((part) => [part.name, true])));
      setStatus(result.cached ? `拆出 ${result.partCount} 个部件（本地缓存）` : `拆出 ${result.partCount} 个部件 · ${Math.round(result.elapsed)}s`);
    } catch (err) { setError(err instanceof Error ? err.message : String(err)); setStatus(""); }
    finally { setBusy(false); }
  }

  function requestClose() {
    if (!busy) onClose();
  }

  return (
    <div className="ai-panel-backdrop" onClick={requestClose}>
      <div className="ai-panel" onClick={(event) => event.stopPropagation()}>
        <header className="ai-panel-head">
          <div className="ai-panel-title">
            <img className="ai-source-thumb" src={source} alt="" title="当前源图" />
            <strong>AI Studio</strong>
            <span className={`ai-engine ${engine.state}`} title="BiRefNet · Depth Anything V2 · See-through">{engine.label}</span>
          </div>
          <button className="row-icon" aria-label="关闭 AI Studio" title={busy ? "任务进行中，完成后再关闭" : "关闭"} onClick={requestClose}><CloseIcon /></button>
        </header>
        <div className="ai-tabs">
          {(["cutout", "material", "spine"] as Tab[]).map((item) => (
            <button key={item} className={tab === item ? "active" : ""} onClick={() => setTab(item)}>
              {item === "cutout" ? "Cutout" : item === "material" ? "Material" : "Spine Parts"}
            </button>
          ))}
        </div>
        <div className="ai-panel-body">
          {tab === "cutout" ? (
            <section className="ai-section">
              <div className="ai-section-head"><strong>Remove Background</strong><span>BiRefNet · local GPU</span></div>
              <p className="ai-note">从当前图层生成透明前景和蒙版。结果会作为新图层加入。</p>
              <button className="ai-run" disabled={busy} onClick={runCutout}>{busy ? "Working…" : "Remove Background"}</button>
              {cutout ? (
                <div className="ai-cutout-result">
                  <div className="ai-image-box"><img src={cutout.foreground} alt="" /></div>
                  <div className="ai-image-box ai-mask-box"><img src={cutout.mask} alt="" /></div>
                  <button className="ai-apply" onClick={() => onApplyCutout(cutout.foreground, cutout.mask)}>Add as Layer</button>
                </div>
              ) : null}
            </section>
          ) : null}

          {tab === "material" ? (
            <section className="ai-section">
              <div className="ai-section-head"><strong>Image → PBR</strong><span>Material extraction · local</span></div>
              <p className="ai-note">从当前图层生成 BaseColor、Height、Normal、Roughness、Metallic、AO。</p>
              <div className="ai-options">
                <label><span>Normal</span><select value={normalConvention} onChange={(event) => setNormalConvention(event.target.value)}><option value="opengl">OpenGL</option><option value="directx">DirectX</option></select></label>
                <label className="ai-check"><span>Tileable</span><input type="checkbox" checked={tileable} onChange={(event) => setTileable(event.target.checked)} /></label>
              </div>
              <button className="ai-run" disabled={busy} onClick={runPBR}>{busy ? "Working…" : "Generate PBR"}</button>
              {pbr ? (
                <div className="ai-map-grid">
                  {Object.entries(pbr).map(([key, value]) => (
                    <div className="ai-map-card" key={key}>
                      <div className="ai-map-preview" style={{ backgroundImage: `url("${value}")` }} />
                      <span>{MAP_LABELS[key] ?? key}</span>
                    </div>
                  ))}
                  <button className="ai-apply" onClick={() => onApplyPBR(pbr)}>Add PBR Layers</button>
                </div>
              ) : null}
            </section>
          ) : null}

          {tab === "spine" ? (
            <section className="ai-section">
              <div className="ai-section-head"><strong>Spine Parts</strong><span>See-through · local</span></div>
              <p className="ai-note">把当前角色图拆成独立部件。只输出图层，不生成骨骼或动画。首次拆件较慢，相同图片会命中本地缓存。</p>
              <div className="ai-options">
                <label><span>Resolution</span><select value={resolution} onChange={(event) => setResolution(Number(event.target.value))}><option value={512}>512</option><option value={768}>768</option><option value={1024}>1024</option></select></label>
              </div>
              <button className="ai-run" disabled={busy} onClick={runSpine}>{busy ? "Splitting…" : "Auto Split"}</button>
              {spine ? (
                <div className="ai-spine-result">
                  <div className="ai-spine-grid">
                    {spine.map((part) => (
                      <label className="ai-part" key={part.name}>
                        <input type="checkbox" checked={selectedParts[part.name] !== false} onChange={(event) => setSelectedParts((current) => ({ ...current, [part.name]: event.target.checked }))} />
                        <SpinePartThumb part={part} />
                        <span>{part.name}</span>
                      </label>
                    ))}
                  </div>
                  <button className="ai-apply" disabled={spine.every((part) => selectedParts[part.name] === false)} onClick={() => onApplySpine(spine.filter((part) => selectedParts[part.name] !== false))}>Add Selected Parts ({spine.filter((part) => selectedParts[part.name] !== false).length})</button>
                </div>
              ) : null}
            </section>
          ) : null}
          {error ? <div className="ai-error">{error}</div> : null}
          {busy || status ? <div className="ai-status">{busy ? `${status || "Working…"} · ${elapsed}s` : status}</div> : null}
        </div>
      </div>
    </div>
  );
}
