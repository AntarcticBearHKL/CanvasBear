import { useEffect, useState } from "react";
import { clearCosts, clearLogs, readCosts, readLogs } from "../lib/runtimeLog";
import { CloseIcon } from "./Icons";

type Settings = {
  theme: "light" | "dark";
  tint: number;
  blur: number;
};

type Props = {
  settings: Settings;
  onChange: (next: Settings) => void;
  onClose: () => void;
  onOpenPlugins: () => void;
};

const TABS = ["Providers", "Appearance", "Local Models", "Local Storage", "Cost", "Runtime Logs", "About"];

type LocalModel = {
  id: string;
  name: string;
  purpose: string;
  repo: string;
  loadable: boolean;
  installed: boolean;
  loaded: boolean;
  sizeBytes: number;
  download?: { status: string; downloaded: number; total: number; error?: string | null } | null;
};

type SystemStats = {
  gpu: { available: boolean; name?: string; totalBytes?: number; usedBytes?: number; allocatedBytes?: number; reservedBytes?: number; error?: string };
  ram: { totalBytes: number; usedBytes: number; availableBytes: number; percent: number };
  process: { rssBytes: number; pid: number };
  modelsRoot: string;
  hfCache: string;
};

function formatBytes(value: number | undefined): string {
  if (!value || value <= 0) return "—";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let index = 0;
  let size = value;
  while (size >= 1024 && index < units.length - 1) {
    size /= 1024;
    index += 1;
  }
  return `${size.toFixed(index >= 3 ? 2 : 1)} ${units[index]}`;
}

const CHANNELS = [
  { id: "openrouter", name: "OpenRouter", base: "https://openrouter.ai/api/v1", models: "gpt-image-2.6-sunburst · hailuo-3-max" },
  { id: "deepseek", name: "DeepSeek", base: "https://api.deepseek.com/v1", models: "deepseek-flash" },
];

function readKeys(): Record<string, string> {
  try {
    return JSON.parse(localStorage.getItem("open-canvas:electron-api-keys:v1") || "{}") as Record<string, string>;
  } catch {
    return {};
  }
}

export function SettingsModal({ settings, onChange, onClose, onOpenPlugins }: Props) {
  const [tab, setTab] = useState("Providers");
  const [keys, setKeys] = useState<Record<string, string>>(readKeys);
  const [logs, setLogs] = useState(readLogs);
  const [costs, setCosts] = useState(readCosts);
  const [logFilter, setLogFilter] = useState("all");
  const [storage, setStorage] = useState({ bytes: 0, keys: 0 });
  const [models, setModels] = useState<LocalModel[]>([]);
  const [system, setSystem] = useState<SystemStats | null>(null);
  const [modelBusy, setModelBusy] = useState("");
  const [modelError, setModelError] = useState("");

  async function refreshModels() {
    const ai = window.openCanvasDesktop?.ai;
    if (!ai?.models) {
      setModelError("AI bridge unavailable. Restart the desktop app.");
      return;
    }
    try {
      const [modelState, systemState] = await Promise.all([ai.models(), ai.system()]);
      setModels(modelState.models || []);
      setSystem(systemState);
      setModelError("");
    } catch (error) {
      setModelError(error instanceof Error ? error.message : String(error));
    }
  }

  useEffect(() => {
    if (tab === "Runtime Logs") setLogs(readLogs());
    if (tab === "Cost") setCosts(readCosts());
    if (tab === "Local Storage") {
      let bytes = 0;
      for (let index = 0; index < localStorage.length; index += 1) {
        const key = localStorage.key(index) || "";
        bytes += new Blob([key, localStorage.getItem(key) || ""]).size;
      }
      setStorage({ bytes, keys: localStorage.length });
    }
  }, [tab]);

  useEffect(() => {
    if (tab !== "Local Models") return;
    void refreshModels();
    const timer = window.setInterval(() => void refreshModels(), 1500);
    return () => window.clearInterval(timer);
  }, [tab]);

  async function modelAction(action: "download" | "load" | "unload" | "delete", model: LocalModel) {
    const ai = window.openCanvasDesktop?.ai;
    if (!ai) return;
    if (action === "delete" && !window.confirm(`删除模型 ${model.name}？\n下次使用前需要重新下载。`)) return;
    setModelBusy(`${action}:${model.id}`);
    setModelError("");
    try {
      if (action === "download") await ai.downloadModel(model.id);
      else if (action === "load") await ai.loadModel(model.id);
      else if (action === "unload") await ai.unloadModel(model.id);
      else await ai.deleteModel(model.id);
      await refreshModels();
    } catch (error) {
      setModelError(error instanceof Error ? error.message : String(error));
    } finally {
      setModelBusy("");
    }
  }

  function saveKey(id: string, value: string) {
    const next = { ...keys, [id]: value };
    setKeys(next);
    localStorage.setItem("open-canvas:electron-api-keys:v1", JSON.stringify(next));
  }

  return (
    <div className="settings-modal-backdrop" role="dialog" aria-modal="true" aria-label="Settings">
      <div className="settings-modal">
        <header className="settings-modal-head">
          <strong>Settings</strong>
          <button className="row-icon" aria-label="关闭设置" onClick={onClose}>
            <CloseIcon />
          </button>
        </header>
        <div className="settings-modal-body">
          <nav className="settings-tabs">
            {TABS.map((item) => (
              <button key={item} className={tab === item ? "active" : ""} onClick={() => setTab(item)}>
                {item}
              </button>
            ))}
          </nav>
          <section className="settings-content">
            {tab === "Providers" ? (
              <>
                <h3 className="settings-heading">Channels</h3>
                <p className="settings-note">
                  Two fixed channels. Keys stay on this machine. Model assignments are locked by the Rust desktop design.
                </p>
                {CHANNELS.map((channel) => (
                  <div className="provider-card" key={channel.id}>
                    <div className="provider-card-head">
                      <strong>{channel.name}</strong>
                      <span className="provider-status">Fixed channel</span>
                    </div>
                    <label className="provider-field">
                      <span>Base URL</span>
                      <input value={channel.base} readOnly />
                    </label>
                    <label className="provider-field">
                      <span>Models</span>
                      <input value={channel.models} readOnly />
                    </label>
                    <label className="provider-field">
                      <span>API key</span>
                      <input
                        type="password"
                        placeholder={channel.id === "openrouter" ? "sk-or-v1-…" : "sk-…"}
                        value={keys[channel.id] || ""}
                        onChange={(event) => saveKey(channel.id, event.target.value)}
                      />
                    </label>
                  </div>
                ))}
              </>
            ) : null}

            {tab === "Appearance" ? (
              <>
                <h3 className="settings-heading">Appearance</h3>
                <div className="settings-row">
                  <span>Theme</span>
                  <div className="theme-choice">
                    {(["light", "dark"] as const).map((theme) => (
                      <button
                        key={theme}
                        className={settings.theme === theme ? "active" : ""}
                        onClick={() => onChange({ ...settings, theme })}
                      >
                        {theme === "light" ? "Light" : "Dark"}
                      </button>
                    ))}
                  </div>
                </div>
                <label className="settings-row">
                  <span>Window opacity</span>
                  <input
                    type="range"
                    min={0}
                    max={100}
                    value={settings.tint}
                    onChange={(event) => onChange({ ...settings, tint: Number(event.target.value) })}
                  />
                </label>
                <label className="settings-row">
                  <span>Blur</span>
                  <input
                    type="range"
                    min={0}
                    max={100}
                    value={settings.blur}
                    onChange={(event) => onChange({ ...settings, blur: Number(event.target.value) })}
                  />
                </label>
              </>
            ) : null}

            {tab === "Local Models" ? (
              <>
                <h3 className="settings-heading">Local Models</h3>
                <p className="settings-note">
                  模型权重保存在软件根目录的 <strong>model</strong> 文件夹，不再使用 HuggingFace 用户缓存。
                </p>
                <div className="settings-info-row"><span>Models folder</span><strong>{system?.modelsRoot || "—"}</strong></div>
                <div className="settings-info-row">
                  <span>GPU</span>
                  <strong>{system?.gpu.available ? system.gpu.name || "CUDA" : "CPU / 未检测到 CUDA"}</strong>
                </div>
                <div className="settings-info-row">
                  <span>VRAM</span>
                  <strong>{system?.gpu.available ? `${formatBytes(system.gpu.usedBytes)} / ${formatBytes(system.gpu.totalBytes)}` : "—"}</strong>
                </div>
                <div className="settings-info-row">
                  <span>RAM</span>
                  <strong>{system ? `${formatBytes(system.ram.usedBytes)} / ${formatBytes(system.ram.totalBytes)} (${system.ram.percent.toFixed(0)}%)` : "—"}</strong>
                </div>
                <div className="settings-info-row">
                  <span>AI process</span>
                  <strong>{system ? `PID ${system.process.pid} · ${formatBytes(system.process.rssBytes)}` : "—"}</strong>
                </div>
                {modelError ? <div className="settings-note error">{modelError}</div> : null}
                <div className="model-list">
                  {models.map((model) => {
                    const downloading = model.download?.status === "downloading";
                    const progress = downloading && model.download?.total
                      ? Math.min(100, (model.download.downloaded / model.download.total) * 100)
                      : 0;
                    return (
                      <div className="model-card" key={model.id}>
                        <div className="model-card-head">
                          <div>
                            <strong>{model.name}</strong>
                            <small>{model.purpose}</small>
                          </div>
                          <span className={`model-status${model.loaded ? " loaded" : model.installed ? " installed" : ""}`}>
                            {model.loaded ? "Loaded" : downloading ? "Downloading" : model.installed ? "Installed" : "Not installed"}
                          </span>
                        </div>
                        <div className="model-meta">
                          <span>{model.repo}</span>
                          <span>{formatBytes(model.sizeBytes)}</span>
                        </div>
                        {downloading ? (
                          <div className="model-progress">
                            <div style={{ width: `${progress}%` }} />
                            <span>{formatBytes(model.download?.downloaded)} / {formatBytes(model.download?.total)}</span>
                          </div>
                        ) : null}
                        {model.download?.status === "error" ? (
                          <div className="settings-note error">{model.download.error || "下载失败"}</div>
                        ) : null}
                        <div className="model-actions">
                          {!model.installed && !downloading ? (
                            <button className="settings-action" disabled={Boolean(modelBusy)} onClick={() => void modelAction("download", model)}>
                              {modelBusy === `download:${model.id}` ? "Starting…" : "Download"}
                            </button>
                          ) : null}
                          {model.installed && model.loadable && !model.loaded ? (
                            <button className="settings-action" disabled={Boolean(modelBusy)} onClick={() => void modelAction("load", model)}>
                              {modelBusy === `load:${model.id}` ? "Loading…" : "Load"}
                            </button>
                          ) : null}
                          {model.loaded ? (
                            <button className="settings-action" disabled={Boolean(modelBusy)} onClick={() => void modelAction("unload", model)}>
                              {modelBusy === `unload:${model.id}` ? "Unloading…" : "Unload"}
                            </button>
                          ) : null}
                          {model.installed && !downloading ? (
                            <button className="settings-action danger" disabled={Boolean(modelBusy)} onClick={() => void modelAction("delete", model)}>
                              Delete
                            </button>
                          ) : null}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </>
            ) : null}

            {tab === "Local Storage" ? (
              <>
                <h3 className="settings-heading">Local Storage</h3>
                <div className="settings-info-row"><span>App data</span><strong>Electron userData</strong></div>
                <div className="settings-info-row"><span>Local keys</span><strong>{storage.keys}</strong></div>
                <div className="settings-info-row"><span>Used space</span><strong>{(storage.bytes / 1024).toFixed(1)} KB</strong></div>
                <div className="settings-info-row"><span>Exports</span><strong>app-data\exports</strong></div>
                <button className="settings-action" type="button" onClick={() => {
                  for (let index = localStorage.length - 1; index >= 0; index -= 1) {
                    const key = localStorage.key(index) || "";
                    if (key.startsWith("open-canvas:electron-canvas:")) localStorage.removeItem(key);
                  }
                  setStorage({ bytes: 0, keys: localStorage.length });
                }}>Clear canvas cache…</button>
              </>
            ) : null}

            {tab === "Cost" ? (
              <>
                <h3 className="settings-heading">Cost</h3>
                <div className="settings-info-row"><span>Total spend</span><strong>${costs.reduce((sum, row) => sum + row.amount, 0).toFixed(2)}</strong></div>
                <div className="settings-info-row"><span>Priced records</span><strong>{costs.length}</strong></div>
                {costs.map((row) => <div className="settings-info-row" key={row.id}><span>{row.time} · {row.model}</span><strong>${row.amount.toFixed(2)}</strong></div>)}
                {!costs.length ? <div className="settings-note">No cost records.</div> : null}
                <button className="settings-action" type="button" onClick={() => { clearCosts(); setCosts([]); }}>Clear history</button>
              </>
            ) : null}

            {tab === "Runtime Logs" ? (
              <>
                <h3 className="settings-heading">Runtime Logs</h3>
                <div className="log-filter-row">
                  {["all", "info", "warn", "error"].map((level) => <button key={level} className={logFilter === level ? "active" : ""} onClick={() => setLogFilter(level)}>{level}</button>)}
                </div>
                {logs.filter((row) => logFilter === "all" || row.level === logFilter).map((row) => <div className="settings-info-row" key={row.id}><span>{row.time} · {row.level} · {row.category}</span><strong>{row.message}</strong></div>)}
                {!logs.length ? <div className="settings-note">No runtime records in this Electron session.</div> : null}
                <button className="settings-action" type="button" onClick={() => { clearLogs(); setLogs([]); }}>Clear logs</button>
              </>
            ) : null}

            {tab === "About" ? (
              <>
                <h3 className="settings-heading">About</h3>
                <div className="settings-info-row"><span>Version</span><strong>0.2.0 (Electron)</strong></div>
                <div className="settings-info-row"><span>Source</span><strong>Rust desktop design</strong></div>
                <div className="settings-info-row"><span>Plugins</span><strong>0 installed</strong></div>
                <button className="settings-action" type="button" onClick={onOpenPlugins}>Open plugin manager</button>
              </>
            ) : null}
          </section>
        </div>
      </div>
    </div>
  );
}
