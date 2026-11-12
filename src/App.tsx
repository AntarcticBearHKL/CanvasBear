import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import { PluginManagerModal } from "./components/PluginManagerModal";
import { SettingsModal } from "./components/SettingsModal";
import { deleteStoredCanvas, loadStoredCanvas, loadStoredImage, saveStoredCanvas, stripTextNodesFromStoredCanvases } from "./lib/canvasStore";
import { captureNodeImage } from "./lib/nodeCapture";
import { useArmedDelete } from "./lib/useArmedDelete";
import {
  ChevronIcon,
  CloseIcon,
  CopyIcon,
  FolderIcon,
  MaximizeIcon,
  MinimizeIcon,
  PencilIcon,
  PlusIcon,
  SettingsIcon,
  TrashIcon,
} from "./components/Icons";

const CanvasScreen = lazy(() =>
  import("./components/CanvasScreen").then((module) => ({ default: module.CanvasScreen })),
);
const ImageStudioScreen = lazy(() =>
  import("./components/ImageStudioScreen").then((module) => ({ default: module.ImageStudioScreen })),
);

type CanvasItem = {
  id: string;
  name: string;
  updatedAt: string;
};

type ProjectGroup = {
  id: string;
  name: string;
  canvases: CanvasItem[];
};

type Settings = {
  theme: "light" | "dark";
  tint: number;
  blur: number;
};

const STORAGE_KEY = "open-canvas:electron-library:v1";
const SETTINGS_KEY = "open-canvas:electron-settings:v1";

function uid(prefix: string) {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

function nowLabel() {
  const date = new Date();
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function seedLibrary(): ProjectGroup[] {
  return [
    {
      id: "ine",
      name: "INE 场景设计",
      canvases: [
        { id: "bamboo", name: "竹林场景概念图", updatedAt: "11-02 22:45" },
        { id: "canvas-2", name: "Canvas 2", updatedAt: "10-30 14:17" },
      ],
    },
  ];
}

function readStorage<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

function App() {
  const [groups, setGroups] = useState<ProjectGroup[]>(() => readStorage(STORAGE_KEY, seedLibrary()));
  const groupsRef = useRef(groups);
  groupsRef.current = groups;
  const [activeGroupId, setActiveGroupId] = useState(() => groups[0]?.id ?? "");
  const [settings, setSettings] = useState<Settings>(() =>
    readStorage(SETTINGS_KEY, { theme: "light", tint: 80, blur: 40 }),
  );
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [openCanvas, setOpenCanvas] = useState<CanvasItem | null>(null);
  const [studioTitle, setStudioTitle] = useState("");
  const [pluginsOpen, setPluginsOpen] = useState(false);
  const { armed: armedDelete, requestDelete, clear: clearArmedDelete } = useArmedDelete();
  const [dragGroup, setDragGroup] = useState<string | null>(null);
  const [dragCanvas, setDragCanvas] = useState<string | null>(null);
  const [editingGroup, setEditingGroup] = useState<string | null>(null);
  const [editingCanvas, setEditingCanvas] = useState<string | null>(null);
  const [groupDraft, setGroupDraft] = useState("");
  const [canvasDraft, setCanvasDraft] = useState("");
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    // Text nodes no longer exist in the canvas model. Clean old documents in
    // the background so no canvas keeps a hidden text node in storage.
    void stripTextNodesFromStoredCanvases().catch(() => undefined);
  }, []);

  useEffect(() => {
    // Warm the canvas chunk while the library is idle. It is split out of the
    // startup bundle, so opening the first canvas stays instant without
    // paying its parse cost at launch.
    const idle = window.requestIdleCallback ?? ((callback: IdleRequestCallback) =>
      window.setTimeout(() => callback({ didTimeout: false, timeRemaining: () => 0 }), 900));
    const handle = idle(() => {
      void import("./components/CanvasScreen");
    });
    return () => {
      if (window.cancelIdleCallback) window.cancelIdleCallback(handle as number);
      else window.clearTimeout(handle as number);
    };
  }, []);

  const activeGroup = useMemo(
    () => groups.find((group) => group.id === activeGroupId) ?? groups[0],
    [groups, activeGroupId],
  );

  useEffect(() => {
    clearArmedDelete();
  }, [activeGroupId, clearArmedDelete]);

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(groups));
  }, [groups]);

  useEffect(() => {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
    document.documentElement.classList.toggle("dark", settings.theme === "dark");
    document.documentElement.style.colorScheme = settings.theme;
    rootRef.current?.style.setProperty("--blur", `${settings.blur}px`);
    const alpha = 0.04 + 0.95 * (settings.tint / 100);
    const light = `rgba(244, 245, 247, ${alpha.toFixed(3)})`;
    const dark = `rgba(18, 18, 18, ${alpha.toFixed(3)})`;
    rootRef.current?.style.setProperty("--window-tint", settings.theme === "dark" ? dark : light);
  }, [settings]);

  useEffect(() => {
    const projectKey = (canvasId: string) => `open-canvas:electron-canvas:${canvasId}`;
    const readProject = (canvasId: string) => {
      const live = (window as any).openCanvasLive;
      if (live?.canvasId === canvasId && Array.isArray(live.nodes)) {
        return { nodes: live.nodes, wires: live.wires ?? [] };
      }
      return readStorage(projectKey(canvasId), { nodes: [], wires: [] });
    };
    const readProjectAsync = async (canvasId: string) => {
      const live = (window as any).openCanvasLive;
      if (live?.canvasId === canvasId && Array.isArray(live.nodes)) {
        return { nodes: live.nodes, wires: live.wires ?? [] };
      }
      const stored = await loadStoredCanvas(canvasId);
      if (stored) return { nodes: stored.nodes, wires: stored.wires };
      return readStorage(projectKey(canvasId), { nodes: [], wires: [] });
    };
    const writeProject = async (canvasId: string, project: { nodes: unknown[]; wires: unknown[] }) => {
      const live = (window as any).openCanvasLive;
      if (live?.canvasId === canvasId) {
        window.dispatchEvent(new CustomEvent("open-canvas:agent-project", { detail: { canvasId, project } }));
      }
      await saveStoredCanvas(canvasId, { nodes: project.nodes, wires: project.wires });
      localStorage.removeItem(projectKey(canvasId));
      return project;
    };
    const api = {
      getState: () => {
        const live = (window as any).openCanvasLive;
        const isOpen = Boolean(openCanvas && live?.canvasId === openCanvas.id);
        return {
          app: "opencanvas",
          page: studioTitle ? "studio" : openCanvas ? "canvas" : "library",
          title: studioTitle || openCanvas?.name || "Canvas",
          libraryId: activeGroup?.id ?? "",
          openCanvasId: openCanvas?.id ?? "",
          openCanvasTitle: openCanvas?.name ?? "",
          groups,
          activeGroupId: activeGroup?.id ?? "",
          selection: isOpen ? live.selected ?? [] : [],
          selectedWire: isOpen ? live.selectedWire ?? "" : "",
          viewport: isOpen ? live.view ?? { x: 0, y: 0, k: 1 } : { x: 0, y: 0, k: 1 },
          stageSize: isOpen ? live.stageSize ?? { width: 0, height: 0 } : { width: 0, height: 0 },
          nodeCount: isOpen ? live.nodes?.length ?? 0 : 0,
          wireCount: isOpen ? live.wires?.length ?? 0 : 0,
        };
      },
      getLibrary: () => ({ groups }),
      getProject: async (canvasId: string) => ({ id: canvasId, ...(await readProjectAsync(canvasId)) }),
      captureNode: async (canvasId: string, nodeId: string) => {
        const project = await readProjectAsync(canvasId);
        const nodes = Array.isArray(project.nodes) ? (project.nodes as Array<Record<string, unknown>>) : [];
        const node = nodes.find((item) => String(item.id) === String(nodeId));
        if (!node) throw new Error(`节点不存在：${nodeId}`);
        const kind = String(node.kind || "");
        let src = typeof node.src === "string" ? node.src : "";
        let originalSrcId = typeof node.originalSrcId === "string" ? node.originalSrcId : "";
        if (kind === "image-attempt") {
          const versions = Array.isArray(node.versions) ? (node.versions as Array<Record<string, unknown>>) : [];
          const index = Math.min(
            Math.max(0, Number(node.activeVersion) || 0),
            Math.max(0, versions.length - 1),
          );
          const version = versions[index];
          src = typeof version?.src === "string" ? version.src : src;
          originalSrcId = typeof version?.originalSrcId === "string" ? version.originalSrcId : "";
        }
        if (originalSrcId) {
          const original = await loadStoredImage(originalSrcId).catch(() => null);
          if (original) src = original;
        }
        return captureNodeImage({
          id: String(node.id),
          kind,
          title: typeof node.title === "string" ? node.title : "",
          src,
          svg: typeof node.svg === "string" ? node.svg : "",
          width: Number(node.width) || undefined,
          height: Number(node.height) || undefined,
        });
      },
      setProject: (canvasId: string, project: { nodes: unknown[]; wires: unknown[] }) => writeProject(canvasId, project),
      createGroup: (name?: string) => {
        const group: ProjectGroup = { id: uid("group"), name: name?.trim() || "新分组", canvases: [] };
        setGroups((current) => [...current, group]);
        setActiveGroupId(group.id);
        return group;
      },
      renameGroup: (groupId: string, name: string) => {
        setGroups((current) => current.map((group) => group.id === groupId ? { ...group, name } : group));
        return { id: groupId, name };
      },
      deleteGroup: (groupId: string) => {
        setGroups((current) => current.filter((group) => group.id !== groupId));
        return { id: groupId, deleted: true };
      },
      createCanvas: (groupId: string, name?: string) => {
        const group = groupsRef.current.find((item) => item.id === groupId) ?? groupsRef.current[0];
        if (!group) throw new Error("没有可用的画布分组");
        const canvas: CanvasItem = {
          id: uid("canvas"),
          name: name?.trim() || `Canvas ${group.canvases.length + 1}`,
          updatedAt: nowLabel(),
        };
        setGroups((current) => current.map((item) => item.id === group.id ? { ...item, canvases: [...item.canvases, canvas] } : item));
        return canvas;
      },
      importCanvas: (canvasId: string, name?: string, groupId?: string) => {
        const group = groupsRef.current.find((item) => item.id === groupId) ?? groupsRef.current[0];
        if (!group) throw new Error("没有可用的画布分组");
        const exists = groupsRef.current.some((item) => item.canvases.some((canvas) => canvas.id === canvasId));
        if (exists) return { id: canvasId, groupId: group.id, imported: false };
        const canvas: CanvasItem = {
          id: canvasId,
          name: name?.trim() || "MCP 设计",
          updatedAt: nowLabel(),
        };
        setGroups((current) => current.map((item) => item.id === group.id ? { ...item, canvases: [...item.canvases, canvas] } : item));
        return { id: canvasId, groupId: group.id, imported: true };
      },
      openCanvas: (canvasId: string) => {
        const canvas = groupsRef.current.flatMap((group) => group.canvases).find((item) => item.id === canvasId);
        if (!canvas) throw new Error("画布不存在");
        setOpenCanvas(canvas);
        return canvas;
      },
      runAiTool: async (action: string, options: Record<string, unknown> = {}) => {
        const live = (window as any).openCanvasLive;
        if (!live?.runAiTool) throw new Error("画布 AI 不可用：请先打开一个画布");
        return live.runAiTool(action, options);
      },
      renameCanvas: (canvasId: string, name: string) => {
        setGroups((current) => current.map((group) => ({
          ...group,
          canvases: group.canvases.map((canvas) => canvas.id === canvasId ? { ...canvas, name, updatedAt: nowLabel() } : canvas),
        })));
        return { id: canvasId, name };
      },
      deleteCanvas: (canvasId: string) => {
        void deleteStoredCanvas(canvasId).catch(() => undefined);
        localStorage.removeItem(`open-canvas:electron-canvas:${canvasId}`);
        localStorage.removeItem(`open-canvas:electron-canvas:${canvasId}:z`);
        localStorage.removeItem(`open-canvas:electron-canvas:${canvasId}:view`);
        setGroups((current) => current.map((group) => ({ ...group, canvases: group.canvases.filter((canvas) => canvas.id !== canvasId) })));
        if (openCanvas?.id === canvasId) setOpenCanvas(null);
        return { id: canvasId, deleted: true };
      },
      moveCanvas: (canvasId: string, direction: number) => {
        setGroups((current) => current.map((group) => {
          const index = group.canvases.findIndex((canvas) => canvas.id === canvasId);
          const target = index + direction;
          if (index < 0 || target < 0 || target >= group.canvases.length) return group;
          const next = [...group.canvases];
          [next[index], next[target]] = [next[target], next[index]];
          return { ...group, canvases: next };
        }));
        return { id: canvasId, direction };
      },
      selectNodes: (ids: string[]) => {
        window.dispatchEvent(new CustomEvent("open-canvas:agent-select", { detail: { ids } }));
        return { ids };
      },
      setViewport: (viewport: { x: number; y: number; k: number }) => {
        window.dispatchEvent(new CustomEvent("open-canvas:agent-viewport", { detail: viewport }));
        return viewport;
      },
    };
    (window as any).openCanvasAgent = api;
    return () => {
      if ((window as any).openCanvasAgent === api) delete (window as any).openCanvasAgent;
    };
  }, [activeGroup, groups, openCanvas, settings, studioTitle]);

  function updateGroup(groupId: string, updater: (group: ProjectGroup) => ProjectGroup) {
    setGroups((current) => current.map((group) => (group.id === groupId ? updater(group) : group)));
  }

  function addGroup() {
    const canvas: CanvasItem = { id: uid("canvas"), name: "Canvas 1", updatedAt: nowLabel() };
    const group: ProjectGroup = { id: uid("group"), name: "新分组", canvases: [canvas] };
    setGroups((current) => [...current, group]);
    setActiveGroupId(group.id);
  }

  function addCanvas() {
    if (!activeGroup) return;
    const canvas: CanvasItem = {
      id: uid("canvas"),
      name: `Canvas ${activeGroup.canvases.length + 1}`,
      updatedAt: nowLabel(),
    };
    updateGroup(activeGroup.id, (group) => ({ ...group, canvases: [...group.canvases, canvas] }));
    setOpenCanvas(canvas);
  }

  function duplicateCanvas(canvas: CanvasItem) {
    if (!activeGroup) return;
    const copy: CanvasItem = {
      ...canvas,
      id: uid("canvas"),
      name: `${canvas.name} copy`,
      updatedAt: nowLabel(),
    };
    updateGroup(activeGroup.id, (group) => ({ ...group, canvases: [...group.canvases, copy] }));
  }

  function removeCanvas(canvasId: string) {
    if (!activeGroup) return;
    updateGroup(activeGroup.id, (group) => ({
      ...group,
      canvases: group.canvases.filter((canvas) => canvas.id !== canvasId),
    }));
  }

  function moveCanvas(canvasId: string, direction: number) {
    if (!activeGroup) return;
    updateGroup(activeGroup.id, (group) => {
      const index = group.canvases.findIndex((canvas) => canvas.id === canvasId);
      const target = index + direction;
      if (index < 0 || target < 0 || target >= group.canvases.length) return group;
      const next = [...group.canvases];
      [next[index], next[target]] = [next[target], next[index]];
      return { ...group, canvases: next };
    });
  }

  function deleteCanvasFromSidebar(canvasId: string) {
    void deleteStoredCanvas(canvasId).catch(() => undefined);
    localStorage.removeItem(`open-canvas:electron-canvas:${canvasId}`);
    localStorage.removeItem(`open-canvas:electron-canvas:${canvasId}:z`);
    localStorage.removeItem(`open-canvas:electron-canvas:${canvasId}:view`);
    removeCanvas(canvasId);
    if (openCanvas?.id === canvasId) setOpenCanvas(null);
  }

  function saveGroupName(groupId: string) {
    const name = groupDraft.trim();
    if (name) updateGroup(groupId, (group) => ({ ...group, name }));
    setEditingGroup(null);
  }

  function saveCanvasName(groupId: string, canvasId: string) {
    const name = canvasDraft.trim();
    if (name) {
      updateGroup(groupId, (group) => ({
        ...group,
        canvases: group.canvases.map((canvas) =>
          canvas.id === canvasId ? { ...canvas, name, updatedAt: nowLabel() } : canvas,
        ),
      }));
    }
    setEditingCanvas(null);
  }

  function minimize() {
    window.openCanvasDesktop?.windowControls?.minimize();
  }
  function maximize() {
    window.openCanvasDesktop?.windowControls?.toggleMaximize();
  }
  function close() {
    window.openCanvasDesktop?.windowControls?.close();
  }

  // The old build captured the desktop with desktopCapturer before first
  // paint. That call blocks Electron's main thread for seconds on Windows.
  // The CSS gradient is the same fallback the capture used, so the shell now
  // paints immediately and never waits on OS screen capture.
  const backdropLayer = <div className="desktop-backdrop" aria-hidden="true" />;

  if (studioTitle) {
    return (
      <>
        {backdropLayer}
        <Suspense fallback={<div className="screen-loading">加载 Image Studio…</div>}>
          <ImageStudioScreen title={studioTitle} onHome={() => setStudioTitle("")} />
        </Suspense>
      </>
    );
  }

  if (openCanvas) {
    return (
      <>
        {backdropLayer}
        <Suspense fallback={<div className="screen-loading">加载画布…</div>}>
          <CanvasScreen
            key={openCanvas.id}
            canvasId={openCanvas.id}
            title={openCanvas.name}
            canvases={activeGroup?.canvases ?? []}
            onSelectCanvas={(canvas) => setOpenCanvas(canvas as CanvasItem)}
            onCreateCanvas={addCanvas}
            onDeleteCanvas={deleteCanvasFromSidebar}
            onMoveCanvas={moveCanvas}
            onHome={() => setOpenCanvas(null)}
            onOpenSettings={() => setSettingsOpen(true)}
            onOpenStudio={(title) => setStudioTitle(title)}
          />
        </Suspense>
        {settingsOpen ? (
          <SettingsModal
            settings={settings}
            onChange={setSettings}
            onClose={() => setSettingsOpen(false)}
            onOpenPlugins={() => setPluginsOpen(true)}
          />
        ) : null}
        {pluginsOpen ? <PluginManagerModal onClose={() => setPluginsOpen(false)} /> : null}
      </>
    );
  }

  return (
    <>
      {backdropLayer}
      <div className="app-shell" ref={rootRef}>
      <header className="titlebar">
        <div className="brand-title">Canvas</div>
        <div className="titlebar-actions">
          <button
            className="icon-btn"
            aria-label="设置"
            title="设置"
            onClick={() => setSettingsOpen((open) => !open)}
          >
            <SettingsIcon />
          </button>
          <div className="window-controls">
            <button className="window-btn" aria-label="最小化" onClick={minimize}>
              <MinimizeIcon />
            </button>
            <button className="window-btn" aria-label="最大化" onClick={maximize}>
              <MaximizeIcon />
            </button>
            <button className="window-btn close" aria-label="关闭" onClick={close}>
              <CloseIcon />
            </button>
          </div>
        </div>
      </header>

      <div className="library-layout">
        <aside className="project-sidebar">
          <div>
            {groups.map((group) => (
              <div
                key={group.id}
                className={`project-group${group.id === activeGroup?.id ? " active" : ""}`}
                onClick={() => setActiveGroupId(group.id)}
                onDoubleClick={() => {
                  if (group.canvases[0]) setOpenCanvas(group.canvases[0]);
                }}
                draggable
                onDragStart={() => setDragGroup(group.id)}
                onDragOver={(event) => event.preventDefault()}
                onDrop={() => {
                  if (!dragGroup || dragGroup === group.id) return;
                  setGroups((current) => {
                    const from = current.findIndex((item) => item.id === dragGroup);
                    const to = current.findIndex((item) => item.id === group.id);
                    if (from < 0 || to < 0) return current;
                    const next = [...current];
                    const [moved] = next.splice(from, 1);
                    next.splice(to, 0, moved);
                    return next;
                  });
                  setDragGroup(null);
                }}
                role="button"
                tabIndex={0}
              >
                <FolderIcon size={16} />
                {editingGroup === group.id ? (
                  <input
                    autoFocus
                    value={groupDraft}
                    onChange={(event) => setGroupDraft(event.target.value)}
                    onBlur={() => saveGroupName(group.id)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") saveGroupName(group.id);
                      if (event.key === "Escape") setEditingGroup(null);
                    }}
                    onClick={(event) => event.stopPropagation()}
                    style={{
                      minWidth: 0,
                      flex: 1,
                      height: 24,
                      border: "1px solid var(--brand)",
                      borderRadius: 4,
                      background: "var(--card)",
                      color: "var(--node-text)",
                      padding: "0 5px",
                    }}
                  />
                ) : (
                  <span className="project-group-name">{group.name}</span>
                )}
                <span className="project-group-actions">
                  <button
                    className="row-icon"
                    aria-label="重命名分组"
                    onClick={(event) => {
                      event.stopPropagation();
                      setGroupDraft(group.name);
                      setEditingGroup(group.id);
                    }}
                  >
                    <PencilIcon size={13} />
                  </button>
                  <button
                    className={`row-icon danger${armedDelete === `group:${group.id}` ? " armed" : ""}`}
                    aria-label={armedDelete === `group:${group.id}` ? "再次点击确认删除分组" : "删除分组"}
                    draggable={false}
                    onDragStart={(event) => event.preventDefault()}
                    onPointerDown={(event) => event.stopPropagation()}
                    onClick={(event) => {
                      event.stopPropagation();
                      requestDelete(`group:${group.id}`, () => {
                        setGroups((current) => current.filter((item) => item.id !== group.id));
                        if (activeGroupId === group.id) {
                          setActiveGroupId(groups.find((item) => item.id !== group.id)?.id ?? "");
                        }
                      });
                    }}
                  >
                    <TrashIcon size={13} />
                  </button>
                </span>
              </div>
            ))}
          </div>
          <button className="sidebar-add" onClick={addGroup} aria-label="新建分组">
            <PlusIcon />
          </button>
        </aside>

        <main className="library-main">
          <div className="table-head">
            <div>Name</div>
            <div>Last edited</div>
            <div>Actions</div>
          </div>
          {activeGroup && activeGroup.canvases.length > 0 ? (
            <div className="canvas-list">
              {activeGroup.canvases.map((canvas) => (
                <div
                  className="canvas-row"
                  key={canvas.id}
                  role="button"
                  tabIndex={0}
                  onClick={() => setOpenCanvas(canvas)}
                  draggable
                  onDragStart={() => setDragCanvas(canvas.id)}
                  onDragOver={(event) => event.preventDefault()}
                  onDrop={() => {
                    if (!dragCanvas || dragCanvas === canvas.id || !activeGroup) return;
                    updateGroup(activeGroup.id, (group) => {
                      const from = group.canvases.findIndex((item) => item.id === dragCanvas);
                      const to = group.canvases.findIndex((item) => item.id === canvas.id);
                      if (from < 0 || to < 0) return group;
                      const next = [...group.canvases];
                      const [moved] = next.splice(from, 1);
                      next.splice(to, 0, moved);
                      return { ...group, canvases: next };
                    });
                    setDragCanvas(null);
                  }}
                >
                  <div className="canvas-name">
                    {editingCanvas === canvas.id ? (
                      <input
                        autoFocus
                        value={canvasDraft}
                        onChange={(event) => setCanvasDraft(event.target.value)}
                        onBlur={() => saveCanvasName(activeGroup.id, canvas.id)}
                        onKeyDown={(event) => {
                          if (event.key === "Enter") saveCanvasName(activeGroup.id, canvas.id);
                          if (event.key === "Escape") setEditingCanvas(null);
                        }}
                        style={{
                          width: 260,
                          height: 26,
                          border: "1px solid var(--brand)",
                          borderRadius: 4,
                          background: "var(--card)",
                          color: "var(--node-text)",
                          textAlign: "center",
                        }}
                      />
                    ) : (
                      canvas.name
                    )}
                  </div>
                  <div className="canvas-date">{canvas.updatedAt}</div>
                  <div className="canvas-actions">
                    <button
                      className="row-icon"
                      aria-label="重命名画布"
                      onClick={(event) => {
                        event.stopPropagation();
                        setCanvasDraft(canvas.name);
                        setEditingCanvas(canvas.id);
                      }}
                    >
                      <PencilIcon size={14} />
                    </button>
                    <button
                      className="row-icon"
                      aria-label="复制画布"
                      onClick={(event) => {
                        event.stopPropagation();
                        duplicateCanvas(canvas);
                      }}
                    >
                      <CopyIcon size={14} />
                    </button>
                    <button
                      className={`row-icon danger${armedDelete === `canvas:${canvas.id}` ? " armed" : ""}`}
                      aria-label={armedDelete === `canvas:${canvas.id}` ? "再次点击确认删除画布" : "删除画布"}
                      draggable={false}
                      onDragStart={(event) => event.preventDefault()}
                      onPointerDown={(event) => event.stopPropagation()}
                      onClick={(event) => {
                        event.stopPropagation();
                        requestDelete(`canvas:${canvas.id}`, () => deleteCanvasFromSidebar(canvas.id));
                      }}
                    >
                      <TrashIcon size={14} />
                    </button>
                  </div>
                </div>
              ))}
              <button className="canvas-add-row" onClick={addCanvas} aria-label="新建画布">
                <PlusIcon />
              </button>
            </div>
          ) : (
            <div className="empty-library">
              <button
                className="canvas-add-row"
                onClick={activeGroup ? addCanvas : addGroup}
                aria-label={activeGroup ? "新建画布" : "新建项目"}
              >
                <PlusIcon />
              </button>
            </div>
          )}
        </main>
      </div>

      {settingsOpen ? (
        <SettingsModal
          settings={settings}
          onChange={setSettings}
          onClose={() => setSettingsOpen(false)}
          onOpenPlugins={() => setPluginsOpen(true)}
        />
      ) : null}
      {pluginsOpen ? <PluginManagerModal onClose={() => setPluginsOpen(false)} /> : null}
      </div>
    </>
  );
}

export { App };
