const {
  app,
  BrowserWindow,
  Menu,
  desktopCapturer,
  ipcMain,
  protocol,
  screen,
  shell,
} = require("electron");
const fs = require("node:fs/promises");
const http = require("node:http");
const path = require("node:path");
const aiService = require("./ai-service.cjs");

const DEV_URL = "http://127.0.0.1:5173";
const APP_SCHEME = "app";
const APP_HOST = "opencanvas";
const isDev = process.argv.includes("--dev") || process.env.OPEN_CANVAS_DEV === "1";
const webRoot = path.join(__dirname, "..", "dist");

protocol.registerSchemesAsPrivileged([
  {
    scheme: APP_SCHEME,
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
    },
  },
]);

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".wasm": "application/wasm",
};

function contentType(file) {
  return MIME[path.extname(file).toLowerCase()] || "application/octet-stream";
}

async function fileResponse(file) {
  try {
    const body = await fs.readFile(file);
    return new Response(body, {
      status: 200,
      headers: {
        "content-type": contentType(file),
        "cache-control": "no-cache",
      },
    });
  } catch {
    return new Response("Not found", { status: 404 });
  }
}

function resolveWebFile(pathname) {
  let rel;
  try {
    rel = decodeURIComponent(pathname).replace(/^\/+/, "");
  } catch {
    return null;
  }
  if (!rel || rel.endsWith("/")) rel += "index.html";
  const file = path.resolve(webRoot, rel);
  if (file !== webRoot && !file.startsWith(webRoot + path.sep)) return null;
  return file;
}

async function handleAppRequest(request) {
  const url = new URL(request.url);
  if (url.host !== APP_HOST) return new Response("Not found", { status: 404 });
  const file = resolveWebFile(url.pathname);
  if (file) {
    try {
      await fs.access(file);
      return await fileResponse(file);
    } catch {
      // SPA history routes fall through to index.html.
    }
  }
  return fileResponse(path.join(webRoot, "index.html"));
}

let mainWindow = null;
let backdropDataUrl = "";
let backdropPromise = null;

async function captureDesktopBackdrop() {
  try {
    const bounds = mainWindow?.getBounds();
    if (!bounds) return "";
    const display = screen.getDisplayMatching(bounds);
    const scale = display.scaleFactor || 1;
    // The backdrop is blurred heavily, so it never needs a full-resolution
    // desktop capture. Request roughly the window's physical size instead of
    // the whole display: desktopCapturer allocates and encodes that bitmap on
    // the main thread, and this was the largest startup stall.
    const targetWidth = Math.max(1, Math.round(bounds.width * Math.min(scale, 1.5)));
    const targetHeight = Math.max(1, Math.round(bounds.height * Math.min(scale, 1.5)));
    const sources = await desktopCapturer.getSources({
      types: ["screen"],
      thumbnailSize: { width: targetWidth, height: targetHeight },
    });
    const source = sources.find((item) => item.display_id === String(display.id)) ?? sources[0];
    if (!source || source.thumbnail.isEmpty()) return "";
    const thumb = source.thumbnail.getSize();
    const scaleX = thumb.width / Math.max(1, display.size.width);
    const scaleY = thumb.height / Math.max(1, display.size.height);
    const crop = {
      x: Math.max(0, Math.round((bounds.x - display.bounds.x) * scaleX)),
      y: Math.max(0, Math.round((bounds.y - display.bounds.y) * scaleY)),
      width: Math.min(Math.round(bounds.width * scaleX), thumb.width),
      height: Math.min(Math.round(bounds.height * scaleY), thumb.height),
    };
    return source.thumbnail.crop(crop).toDataURL();
  } catch {
    return "";
  }
}

function ensureBackdropCapture() {
  if (!backdropPromise) {
    backdropPromise = captureDesktopBackdrop().then((data) => {
      backdropDataUrl = data;
      return data;
    });
  }
  return backdropPromise;
}

ipcMain.handle("desktop:backdrop", () => {
  if (backdropDataUrl) return backdropDataUrl;
  return ensureBackdropCapture();
});

// ------------------------------------------------------------ agent bridge
// The MCP server talks to this loopback HTTP endpoint. The endpoint is a thin
// transport: every operation is executed by the renderer's window.openCanvasAgent
// against the live React document, so the window and localStorage stay in sync.
const AGENT_HOST = process.env.OC_AGENT_BRIDGE_HOST || "127.0.0.1";
const AGENT_PORT = Number(process.env.OC_AGENT_BRIDGE_PORT || 3213);
const AGENT_TOKEN = (process.env.OC_AGENT_BRIDGE_TOKEN || "").trim();
let agentServer = null;

function agentAuthorized(request) {
  if (!AGENT_TOKEN) return true;
  return request.headers.authorization === `Bearer ${AGENT_TOKEN}`;
}

async function callRendererAgent(method, args = []) {
  if (!mainWindow || mainWindow.webContents.isDestroyed()) {
    throw new Error("OpenCanvas 窗口未运行");
  }
  if (mainWindow.webContents.isLoading()) {
    throw new Error("OpenCanvas 窗口仍在加载，请稍后重试");
  }
  const methodLiteral = JSON.stringify(method);
  const expression = `(async () => {
    const api = window.openCanvasAgent;
    if (!api) throw new Error("Electron canvas agent is not ready");
    const fn = api[${methodLiteral}];
    if (typeof fn !== "function") throw new Error("Unknown agent method");
    return await fn(...${JSON.stringify(args)});
  })()`;
  return mainWindow.webContents.executeJavaScript(expression, true);
}

function readRequestBody(request) {
  return new Promise((resolve, reject) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      body += chunk;
      if (body.length > 32 * 1024 * 1024) {
        reject(new Error("Request body too large"));
        request.destroy();
      }
    });
    request.on("end", () => {
      if (!body) return resolve({});
      try {
        resolve(JSON.parse(body));
      } catch (error) {
        reject(new Error(`Invalid JSON: ${error.message}`));
      }
    });
    request.on("error", reject);
  });
}

function sendJson(response, status, payload) {
  const body = Buffer.from(JSON.stringify(payload));
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": body.length,
    "cache-control": "no-store",
  });
  response.end(body);
}

async function handleAgentRequest(request, response) {
  if (!agentAuthorized(request)) return sendJson(response, 401, { error: "Unauthorized" });
  const url = new URL(request.url, `http://${AGENT_HOST}:${AGENT_PORT}`);
  try {
    if (request.method === "GET" && url.pathname === "/health") {
      return sendJson(response, 200, {
        ok: true,
        app: "opencanvas",
        version: app.getVersion(),
        renderer: Boolean(mainWindow && !mainWindow.webContents.isDestroyed()),
      });
    }
    if (request.method === "GET" && url.pathname === "/state") {
      return sendJson(response, 200, await callRendererAgent("getState"));
    }
    if (request.method === "GET" && url.pathname === "/library") {
      return sendJson(response, 200, await callRendererAgent("getLibrary"));
    }
    if (request.method === "GET" && url.pathname.startsWith("/project/")) {
      const canvasId = decodeURIComponent(url.pathname.slice("/project/".length));
      return sendJson(response, 200, await callRendererAgent("getProject", [canvasId]));
    }
    if (request.method === "PUT" && url.pathname.startsWith("/project/")) {
      const canvasId = decodeURIComponent(url.pathname.slice("/project/".length));
      const project = await readRequestBody(request);
      return sendJson(response, 200, await callRendererAgent("setProject", [canvasId, project]));
    }
    if (request.method === "GET" && url.pathname === "/screenshot") {
      if (!mainWindow || mainWindow.webContents.isDestroyed()) throw new Error("OpenCanvas 窗口未运行");
      const image = await mainWindow.webContents.capturePage();
      const png = image.toPNG();
      response.writeHead(200, {
        "content-type": "image/png",
        "content-length": png.length,
        "cache-control": "no-store",
      });
      return response.end(png);
    }
    if (request.method === "POST" && url.pathname === "/agent") {
      const body = await readRequestBody(request);
      if (!body || typeof body.method !== "string") throw new Error("method is required");
      const args = Array.isArray(body.args) ? body.args : [];
      return sendJson(response, 200, await callRendererAgent(body.method, args));
    }
    return sendJson(response, 404, { error: "Not found" });
  } catch (error) {
    return sendJson(response, 500, { error: error instanceof Error ? error.message : String(error) });
  }
}

function startAgentBridge() {
  if (agentServer) return;
  agentServer = http.createServer((request, response) => {
    void handleAgentRequest(request, response);
  });
  agentServer.on("error", (error) => {
    console.error(`[agent bridge] ${error.message}`);
  });
  agentServer.listen(AGENT_PORT, AGENT_HOST, () => {
    console.log(`[agent bridge] http://${AGENT_HOST}:${AGENT_PORT}`);
  });
}
ipcMain.handle("ai:image", async (_event, payload) => {
  try {
    const response = await fetch("https://openrouter.ai/api/v1/images", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${payload?.key || ""}`,
      },
      body: JSON.stringify(payload?.body || {}),
    });
    return { ok: response.ok, status: response.status, body: await response.text() };
  } catch (error) {
    return { ok: false, status: 0, body: JSON.stringify({ error: { message: String(error) } }) };
  }
});
ipcMain.handle("ai:status", async () => {
  try {
    return { ok: true, ...(await aiService.ensureStarted()) };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
});
ipcMain.handle("ai:models", async () => aiService.get("/v1/models"));
ipcMain.handle("ai:system", async () => aiService.get("/v1/system"));
ipcMain.handle("ai:download-model", async (_event, id) => aiService.request(`/v1/models/${encodeURIComponent(String(id))}/download`, {}, 60000));
ipcMain.handle("ai:load-model", async (_event, id) => aiService.request(`/v1/models/${encodeURIComponent(String(id))}/load`, {}, 600000));
ipcMain.handle("ai:unload-model", async (_event, id) => aiService.request(`/v1/models/${encodeURIComponent(String(id))}/unload`, {}, 60000));
ipcMain.handle("ai:delete-model", async (_event, id) => aiService.remove(`/v1/models/${encodeURIComponent(String(id))}`));
ipcMain.handle("ai:cutout", async (_event, image) => aiService.request("/v1/cutout", { image }, 600000));
ipcMain.handle("ai:pbr", async (_event, payload) => aiService.request("/v1/pbr", payload, 600000));
ipcMain.handle("ai:spine", async (_event, payload) => aiService.request("/v1/spine", payload, 1200000));
ipcMain.handle("ai:upscale", async (_event, payload) => aiService.request("/v1/upscale", payload, 600000));
ipcMain.handle("ai:angle", async (_event, payload) => aiService.request("/v1/angle", payload, 600000));

let windowDragState = null;
let windowDragTimer = null;
function endWindowDrag() {
  if (windowDragTimer) clearInterval(windowDragTimer);
  windowDragTimer = null;
  windowDragState = null;
}
ipcMain.on("window:drag-begin", () => {
  if (!mainWindow) return;
  endWindowDrag();
  const [x, y] = mainWindow.getPosition();
  // Sample the native cursor in the main process instead of accepting
  // renderer pointer coordinates. Moving the window changes the renderer's
  // client coordinates, which created a feedback loop and made the old drag
  // jitter/flicker across the screen.
  windowDragState = {
    winX: x,
    winY: y,
    cursorX: screen.getCursorScreenPoint().x,
    cursorY: screen.getCursorScreenPoint().y,
  };
  windowDragTimer = setInterval(() => {
    if (!mainWindow || !windowDragState) return;
    const cursor = screen.getCursorScreenPoint();
    const x = Math.round(windowDragState.winX + cursor.x - windowDragState.cursorX);
    const y = Math.round(windowDragState.winY + cursor.y - windowDragState.cursorY);
    const [currentX, currentY] = mainWindow.getPosition();
    if (x !== currentX || y !== currentY) mainWindow.setPosition(x, y, false);
  }, 8);
});
ipcMain.on("window:drag-end", endWindowDrag);
ipcMain.on("window:minimize", () => mainWindow?.minimize());
ipcMain.on("window:toggle-maximize", () => {
  if (!mainWindow) return;
  if (mainWindow.isMaximized()) mainWindow.unmaximize();
  else mainWindow.maximize();
});
ipcMain.on("window:close", () => mainWindow?.close());

async function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 640,
    show: true,
    title: "OpenCanvas",
    icon: path.join(__dirname, "assets", "icon.ico"),
    frame: false,
    transparent: false,
    backgroundColor: "#F4F1EB",
    roundedCorners: true,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false,
    },
  });

  Menu.setApplicationMenu(null);

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: "deny" };
  });

  mainWindow.webContents.on("will-navigate", (event, url) => {
    const allowed = isDev
      ? url.startsWith(DEV_URL)
      : url.startsWith(`${APP_SCHEME}://${APP_HOST}/`);
    if (!allowed) {
      event.preventDefault();
      if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    }
  });

  // Start loading the UI immediately. The desktop capture is deliberately not
  // awaited: it needs the OS screen-capture path and used to delay the first
  // paint by seconds. The renderer already has a gradient fallback, and the
  // IPC handler below resolves the real backdrop whenever it is ready.
  await mainWindow.loadURL(isDev ? DEV_URL : `${APP_SCHEME}://${APP_HOST}/`);

}

const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  });

  app.whenReady().then(async () => {
    if (!isDev) protocol.handle(APP_SCHEME, handleAppRequest);
    aiService.setModelDir(path.join(app.isPackaged ? path.dirname(process.execPath) : app.getAppPath(), "model"));
    await createWindow();
    startAgentBridge();
    // The desktop app owns the local AI service: start it with the app and
    // stop it on quit, so users never need to launch uvicorn themselves.
    void aiService.ensureStarted().catch((error) => {
      console.error(`[ai] failed to start local AI service: ${error instanceof Error ? error.message : String(error)}`);
    });
    app.on("activate", async () => {
      if (BrowserWindow.getAllWindows().length === 0) await createWindow();
    });
  });
}

app.on("before-quit", () => {
  aiService.stop();
  endWindowDrag();
  agentServer?.close();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
