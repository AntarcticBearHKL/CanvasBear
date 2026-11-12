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

export function formatModelBytes(value: number | undefined): string {
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

function sleep(ms: number) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

/**
 * Ensure the local AI models needed by an action are installed before the
 * action runs. Missing models trigger a confirmation, then an explicit
 * download with progress. Nothing is downloaded silently.
 */
export async function ensureLocalModels(
  modelIds: string[],
  onStatus?: (message: string) => void,
): Promise<void> {
  const ai = window.openCanvasDesktop?.ai;
  if (!ai?.models || !ai.downloadModel) {
    throw new Error("Local model manager unavailable. Restart the desktop app.");
  }
  const snapshot = await ai.models();
  const missing = modelIds
    .map((id) => snapshot.models.find((model) => model.id === id))
    .filter((model): model is LocalModel => Boolean(model))
    .filter((model) => !model.installed);

  if (!missing.length) return;

  const lines = missing.map((model) => `• ${model.name}（${formatModelBytes(model.sizeBytes)}）`).join("\n");
  const approved = window.confirm(
    `以下本地模型还没有下载：\n\n${lines}\n\n现在下载吗？\n下载位置：${snapshot.modelsRoot}`,
  );
  if (!approved) {
    throw new Error("模型未下载，操作已取消。请到 Settings → Local Models 下载。");
  }

  for (const model of missing) {
    onStatus?.(`正在下载 ${model.name}…`);
    await ai.downloadModel(model.id);
    const started = Date.now();
    while (Date.now() - started < 2 * 60 * 60 * 1000) {
      await sleep(1200);
      const state = await ai.models();
      const current = state.models.find((item) => item.id === model.id);
      if (!current) throw new Error(`模型状态丢失：${model.name}`);
      if (current.download?.status === "error") {
        throw new Error(current.download.error || `${model.name} 下载失败`);
      }
      if (current.installed) break;
      onStatus?.(
        `正在下载 ${model.name}… ${formatModelBytes(current.download?.downloaded || 0)} / ${formatModelBytes(current.download?.total || current.sizeBytes)}`,
      );
    }
    const finalState = await ai.models();
    if (!finalState.models.find((item) => item.id === model.id)?.installed) {
      throw new Error(`${model.name} 下载超时`);
    }
  }
  onStatus?.("模型下载完成");
}
