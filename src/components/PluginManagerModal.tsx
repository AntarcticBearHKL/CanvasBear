import { useState } from "react";
import { useArmedDelete } from "../lib/useArmedDelete";
import { CloseIcon, PlusIcon, TrashIcon } from "./Icons";

type Plugin = {
  id: string;
  name: string;
  source: string;
  enabled: boolean;
  official: boolean;
};

const INITIAL: Plugin[] = [
  { id: "html", name: "HTML node", source: "official", enabled: true, official: true },
  { id: "markdown", name: "Markdown node", source: "official", enabled: true, official: true },
  { id: "panorama", name: "3D panorama node", source: "official", enabled: false, official: true },
  { id: "sticky", name: "Sticky note node", source: "official", enabled: true, official: true },
  { id: "svg", name: "SVG node", source: "official", enabled: true, official: true },
];

type Props = { onClose: () => void };

export function PluginManagerModal({ onClose }: Props) {
  const [tab, setTab] = useState("Official");
  const [plugins, setPlugins] = useState<Plugin[]>(INITIAL);
  const [url, setUrl] = useState("");
  const { armed, requestDelete } = useArmedDelete();

  const visible = plugins.filter((plugin) => plugin.source === tab.toLowerCase() || (tab === "Official" && plugin.official));

  return (
    <div className="settings-modal-backdrop" role="dialog" aria-modal="true" aria-label="Plugin manager">
      <div className="plugin-modal">
        <header className="settings-modal-head">
          <strong>Plugin Manager</strong>
          <button className="row-icon" onClick={onClose} aria-label="关闭插件管理器"><CloseIcon /></button>
        </header>
        <div className="plugin-tabs">
          {["Official", "Local", "Third-party"].map((item) => (
            <button key={item} className={tab === item ? "active" : ""} onClick={() => setTab(item)}>{item}</button>
          ))}
        </div>
        <div className="plugin-install">
          <input value={url} onChange={(event) => setUrl(event.target.value)} placeholder="Plugin URL (record only; no code is fetched)" />
          <button
            onClick={() => {
              if (!url.trim()) return;
              setPlugins((current) => [...current, { id: `plugin-${Date.now()}`, name: url.split("/").pop() || "Local plugin", source: "third-party", enabled: false, official: false }]);
              setUrl("");
            }}
          >
            <PlusIcon size={14} /> Install
          </button>
        </div>
        <div className="plugin-list">
          {visible.map((plugin) => (
            <div className="plugin-row" key={plugin.id}>
              <div>
                <strong>{plugin.name}</strong>
                <small>{plugin.source} · record-only</small>
              </div>
              <button
                className={`plugin-enable${plugin.enabled ? " on" : ""}`}
                onClick={() => setPlugins((current) => current.map((item) => item.id === plugin.id ? { ...item, enabled: !item.enabled } : item))}
              >
                {plugin.enabled ? "Disable" : "Enable"}
              </button>
              <button
                className={`row-icon danger${armed === plugin.id ? " armed" : ""}`}
                aria-label={armed === plugin.id ? "再次点击确认卸载插件" : "卸载插件"}
                draggable={false}
                onDragStart={(event) => event.preventDefault()}
                onPointerDown={(event) => event.stopPropagation()}
                onClick={() => {
                  requestDelete(plugin.id, () => {
                    setPlugins((current) => current.filter((item) => item.id !== plugin.id));
                  });
                }}
              >
                <TrashIcon size={14} />
              </button>
            </div>
          ))}
          {visible.length === 0 ? <div className="settings-note">No plugins in this tab.</div> : null}
        </div>
        <footer className="plugin-footer">Install records URL and local source only. No plugin code is executed.</footer>
      </div>
    </div>
  );
}
