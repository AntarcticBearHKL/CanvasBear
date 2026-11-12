export type RuntimeLogRow = {
  id: string;
  time: string;
  level: "info" | "warn" | "error";
  category: string;
  message: string;
  detail?: string;
};

export type CostRow = {
  id: string;
  time: string;
  model: string;
  amount: number;
};

const LOG_KEY = "open-canvas:electron-runtime-logs:v1";
const COST_KEY = "open-canvas:electron-costs:v1";

function read<T>(key: string): T[] {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T[]) : [];
  } catch {
    return [];
  }
}

export function readLogs(): RuntimeLogRow[] {
  return read<RuntimeLogRow>(LOG_KEY);
}

export function recordLog(level: RuntimeLogRow["level"], category: string, message: string, detail = "") {
  const row: RuntimeLogRow = {
    id: `log-${Date.now()}-${Math.random().toString(36).slice(2, 5)}`,
    time: new Date().toLocaleString(),
    level,
    category,
    message,
    detail,
  };
  localStorage.setItem(LOG_KEY, JSON.stringify([...readLogs(), row].slice(-200)));
}

export function clearLogs() {
  localStorage.removeItem(LOG_KEY);
}

export function readCosts(): CostRow[] {
  return read<CostRow>(COST_KEY);
}

export function recordCost(model: string, amount: number) {
  const row: CostRow = {
    id: `cost-${Date.now()}-${Math.random().toString(36).slice(2, 5)}`,
    time: new Date().toLocaleString(),
    model,
    amount,
  };
  localStorage.setItem(COST_KEY, JSON.stringify([...readCosts(), row].slice(-200)));
}

export function clearCosts() {
  localStorage.removeItem(COST_KEY);
}
