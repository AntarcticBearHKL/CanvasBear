const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("openCanvasDesktop", {
  isElectron: true,
  platform: process.platform,
  getDesktopBackdrop: () => ipcRenderer.invoke("desktop:backdrop"),
  generateImage: (payload) => ipcRenderer.invoke("ai:image", payload),
  ai: {
    status: () => ipcRenderer.invoke("ai:status"),
    models: () => ipcRenderer.invoke("ai:models"),
    system: () => ipcRenderer.invoke("ai:system"),
    downloadModel: (id) => ipcRenderer.invoke("ai:download-model", id),
    loadModel: (id) => ipcRenderer.invoke("ai:load-model", id),
    unloadModel: (id) => ipcRenderer.invoke("ai:unload-model", id),
    deleteModel: (id) => ipcRenderer.invoke("ai:delete-model", id),
    cutout: (image) => ipcRenderer.invoke("ai:cutout", image),
    pbr: (payload) => ipcRenderer.invoke("ai:pbr", payload),
    spine: (payload) => ipcRenderer.invoke("ai:spine", payload),
    upscale: (payload) => ipcRenderer.invoke("ai:upscale", payload),
    angle: (payload) => ipcRenderer.invoke("ai:angle", payload),
  },
  windowControls: {
    minimize: () => ipcRenderer.send("window:minimize"),
    toggleMaximize: () => ipcRenderer.send("window:toggle-maximize"),
    close: () => ipcRenderer.send("window:close"),
    beginDrag: () => ipcRenderer.send("window:drag-begin"),
    endDrag: () => ipcRenderer.send("window:drag-end"),
  },
});
