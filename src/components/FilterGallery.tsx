import { useEffect, useMemo, useState } from "react";
import { CloseIcon } from "./Icons";
import {
  FILTERS,
  FILTER_CATEGORIES,
  defaultFilterParams,
  getFilter,
  type FilterDefinition,
  type FilterParam,
  type FilterValue,
} from "../lib/filters";

type Props = {
  source: HTMLCanvasElement;
  initialCategory?: string;
  initialFilterId?: string;
  onApply: (filter: FilterDefinition, params: Record<string, FilterValue>) => void;
  onClose: () => void;
};

export function FilterGallery({ source, initialCategory = "All", initialFilterId, onApply, onClose }: Props) {
  const [category, setCategory] = useState(initialCategory);
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState(() => initialFilterId || FILTERS[0].id);
  const [params, setParams] = useState<Record<string, FilterValue>>(() => defaultFilterParams(getFilter(initialFilterId || FILTERS[0].id)));
  const [previewUrl, setPreviewUrl] = useState("");
  const [previewError, setPreviewError] = useState("");

  const categories = useMemo(() => FILTER_CATEGORIES.map((name) => ({
    name,
    count: FILTERS.filter((filter) => filter.category === name).length,
  })), []);

  const visibleFilters = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return FILTERS.filter((filter) => {
      if (category !== "All" && filter.category !== category) return false;
      if (needle && !`${filter.name} ${filter.category}`.toLowerCase().includes(needle)) return false;
      return true;
    });
  }, [category, query]);

  const selected = getFilter(selectedId);

  useEffect(() => {
    if (visibleFilters.length && !visibleFilters.some((filter) => filter.id === selectedId)) {
      setSelectedId(visibleFilters[0].id);
    }
  }, [category, query, selectedId, visibleFilters]);

  useEffect(() => {
    const filter = getFilter(selectedId);
    setParams(defaultFilterParams(filter));
    setPreviewError("");
  }, [selectedId]);

  useEffect(() => {
    const filter = getFilter(selectedId);
    const timer = window.setTimeout(() => {
      try {
        const scale = Math.min(1, 360 / Math.max(1, source.width), 220 / Math.max(1, source.height));
        const width = Math.max(1, Math.round(source.width * scale));
        const height = Math.max(1, Math.round(source.height * scale));
        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        const context = canvas.getContext("2d");
        if (!context) return;
        context.drawImage(source, 0, 0, width, height);
        const image = context.getImageData(0, 0, width, height);
        context.putImageData(filter.apply(image, params), 0, 0);
        setPreviewUrl(canvas.toDataURL("image/png"));
        setPreviewError("");
      } catch (error) {
        setPreviewError(error instanceof Error ? error.message : "Preview failed");
      }
    }, 90);
    return () => window.clearTimeout(timer);
  }, [selectedId, params, source]);

  function updateParam(key: string, value: FilterValue) {
    setParams((current) => ({ ...current, [key]: value }));
  }

  function renderParam(param: FilterParam) {
    const value = params[param.key] ?? param.default;
    if (param.kind === "select") {
      return (
        <label className="filter-param" key={param.key}>
          <span>{param.label}</span>
          <select value={String(value)} onChange={(event) => updateParam(param.key, event.target.value)}>
            {param.options?.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
          </select>
        </label>
      );
    }
    if (param.kind === "check") {
      return (
        <label className="filter-param filter-param-check" key={param.key}>
          <span>{param.label}</span>
          <input type="checkbox" checked={Boolean(value)} onChange={(event) => updateParam(param.key, event.target.checked)} />
        </label>
      );
    }
    if (param.kind === "color") {
      return (
        <label className="filter-param" key={param.key}>
          <span>{param.label}</span>
          <input type="color" value={String(value)} onChange={(event) => updateParam(param.key, event.target.value)} />
        </label>
      );
    }
    return (
      <label className="filter-param" key={param.key}>
        <span>{param.label}</span>
        <input
          type="range"
          min={param.min ?? 0}
          max={param.max ?? 100}
          step={param.step ?? 1}
          value={Number(value)}
          onChange={(event) => updateParam(param.key, Number(event.target.value))}
        />
        <em>{Number(value).toFixed(param.step && param.step < 1 ? 2 : 0)}</em>
      </label>
    );
  }

  return (
    <div className="filter-gallery-backdrop" onClick={onClose}>
      <div className="filter-gallery" onClick={(event) => event.stopPropagation()}>
        <header className="filter-gallery-head">
          <div>
            <strong>Filter Gallery</strong>
            <span>{FILTERS.length} filters · {selected.category}</span>
          </div>
          <button className="row-icon" aria-label="关闭滤镜库" onClick={onClose}><CloseIcon /></button>
        </header>
        <div className="filter-gallery-body">
          <aside className="filter-gallery-categories">
            <input className="studio-search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search filters…" />
            <button className={category === "All" ? "active" : ""} onClick={() => setCategory("All")}>
              <span>All</span><em>{FILTERS.length}</em>
            </button>
            {categories.map((entry) => (
              <button key={entry.name} className={category === entry.name ? "active" : ""} onClick={() => setCategory(entry.name)}>
                <span>{entry.name}</span><em>{entry.count}</em>
              </button>
            ))}
          </aside>
          <section className="filter-gallery-list">
            {visibleFilters.map((filter) => (
              <button key={filter.id} className={selectedId === filter.id ? "active" : ""} onClick={() => setSelectedId(filter.id)}>
                <strong>{filter.name}</strong>
                <span>{filter.category}</span>
              </button>
            ))}
            {!visibleFilters.length ? <div className="settings-note">No filters match.</div> : null}
          </section>
          <section className="filter-gallery-detail">
            <div className="filter-gallery-preview">
              {previewError ? <span>{previewError}</span> : previewUrl ? <img src={previewUrl} alt="" /> : <span>Rendering preview…</span>}
            </div>
            <div className="filter-gallery-title">
              <div><strong>{selected.name}</strong><span>{selected.category}</span></div>
              <span>{selected.params.length ? `${selected.params.length} controls` : "No parameters"}</span>
            </div>
            <div className="filter-gallery-params">
              {selected.params.map(renderParam)}
              {!selected.params.length ? <div className="settings-note">This filter has no adjustable parameters.</div> : null}
            </div>
            <footer className="filter-gallery-actions">
              <button onClick={onClose}>Cancel</button>
              <button className="filter-apply" onClick={() => onApply(selected, params)}>Apply</button>
            </footer>
          </section>
        </div>
      </div>
    </div>
  );
}
