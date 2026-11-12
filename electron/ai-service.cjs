const { spawn } = require("node:child_process");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");

const HOST = "127.0.0.1";
const PORT = Number(process.env.OC_AI_PORT || 3214);
const BASE_URL = `http://${HOST}:${PORT}`;
let configuredModelDir = "";

function setModelDir(dir) {
  configuredModelDir = String(dir || "");
}

function modelDir() {
  return process.env.OC_MODEL_DIR || configuredModelDir || path.join(path.dirname(process.execPath), "model");
}

function serviceDir() {
  const candidates = [
    process.env.OC_AI_SERVICE_DIR,
    process.resourcesPath ? path.join(process.resourcesPath, "ai-service") : "",
    path.join(path.dirname(process.execPath), "ai-service"),
    "D:\\Dev\\opencanvas\\ai-service",
  ].filter(Boolean);
  for (const dir of candidates) {
    if (fs.existsSync(path.join(dir, "app.py"))) return dir;
  }
  return candidates[0] || "D:\\Dev\\opencanvas\\ai-service";
}

function pythonPath() {
  return path.join(serviceDir(), ".venv", "Scripts", "python.exe");
}

let child = null;
let starting = null;

async function health() {
  try {
    const response = await fetch(`${BASE_URL}/health`, { signal: AbortSignal.timeout(5000) });
    return response.ok ? response.json() : null;
  } catch {
    return null;
  }
}

async function waitForHealth(timeoutMs = 90000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const result = await health();
    if (result) return result;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error("Local AI service did not start");
}

async function ensureStarted() {
  const current = await health();
  if (current) return current;
  if (starting) return starting;
  starting = (async () => {
    const dir = serviceDir();
    const python = pythonPath();
    if (!fs.existsSync(python)) {
      throw new Error(`Local AI service venv missing: ${python}`);
    }
    const models = modelDir();
    fs.mkdirSync(models, { recursive: true });
    child = spawn(python, ["-m", "uvicorn", "app:app", "--host", HOST, "--port", String(PORT)], {
      cwd: dir,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, OC_MODEL_DIR: models, PYTHONUTF8: "1" },
    });
    child.stdout.on("data", (chunk) => console.log(`[ai] ${chunk.toString().trim()}`));
    child.stderr.on("data", (chunk) => console.error(`[ai] ${chunk.toString().trim()}`));
    child.on("exit", () => {
      child = null;
    });
    return waitForHealth();
  })().finally(() => {
    starting = null;
  });
  return starting;
}

async function request(endpoint, payload, timeoutMs = 1200000, method = "POST") {
  await ensureStarted();
  const body = payload === undefined || payload === null ? null : JSON.stringify(payload);
  return new Promise((resolve, reject) => {
    const headers = {};
    if (body !== null) {
      headers["content-type"] = "application/json";
      headers["content-length"] = Buffer.byteLength(body);
    }
    const req = http.request(
      {
        host: HOST,
        port: PORT,
        path: endpoint,
        method,
        headers,
      },
      (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          let parsed = {};
          try {
            parsed = JSON.parse(text);
          } catch {
            parsed = {};
          }
          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve(parsed);
          } else {
            const detail = parsed.detail;
            const message = typeof detail === "string"
              ? detail
              : detail
                ? JSON.stringify(detail)
                : parsed.error || `AI request failed (${res.statusCode})`;
            reject(new Error(message));
          }
        });
        res.on("error", reject);
      },
    );
    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error("AI request timed out"));
    });
    req.on("error", reject);
    if (body !== null) req.write(body);
    req.end();
  });
}

async function get(endpoint, timeoutMs = 30000) {
  return request(endpoint, null, timeoutMs, "GET");
}

async function remove(endpoint, timeoutMs = 30000) {
  return request(endpoint, null, timeoutMs, "DELETE");
}

function stop() {
  const running = child;
  child = null;
  if (!running) return;
  try {
    if (process.platform === "win32" && running.pid) {
      spawn("taskkill", ["/pid", String(running.pid), "/T", "/F"], {
        windowsHide: true,
        stdio: "ignore",
      });
    } else {
      running.kill();
    }
  } catch {
    // The process may already have exited.
  }
}

module.exports = {
  health,
  ensureStarted,
  request,
  get,
  remove,
  stop,
  serviceDir,
  setModelDir,
  modelDir,
};
