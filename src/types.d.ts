export {};

declare global {
  interface Window {
    openCanvasDesktop?: {
      isElectron: boolean;
      platform: string;
      getDesktopBackdrop?: () => Promise<string>;
      generateImage?: (payload: { key: string; body: unknown }) => Promise<{ ok: boolean; status: number; body: string }>;
      ai?: {
        status: () => Promise<{ ok: boolean; gpu?: boolean; gpuName?: string; birefnetLoaded?: boolean; depthLoaded?: boolean; seeThrough?: boolean; modelsRoot?: string; hfCache?: string; error?: string }>;
        models: () => Promise<{
          ok: boolean;
          modelsRoot: string;
          hfCache: string;
          models: Array<{
            id: string;
            name: string;
            purpose: string;
            repo: string;
            loadable: boolean;
            installed: boolean;
            loaded: boolean;
            sizeBytes: number;
            download?: { status: string; downloaded: number; total: number; error?: string | null } | null;
          }>;
        }>;
        system: () => Promise<{
          ok: boolean;
          gpu: { available: boolean; name?: string; totalBytes?: number; usedBytes?: number; allocatedBytes?: number; reservedBytes?: number; error?: string };
          ram: { totalBytes: number; usedBytes: number; availableBytes: number; percent: number };
          process: { rssBytes: number; pid: number };
          modelsRoot: string;
          hfCache: string;
        }>;
        downloadModel: (id: string) => Promise<{ ok: boolean; model: unknown }>;
        loadModel: (id: string) => Promise<{ ok: boolean; model: unknown; note?: string }>;
        unloadModel: (id: string) => Promise<{ ok: boolean; model: unknown; note?: string }>;
        deleteModel: (id: string) => Promise<{ ok: boolean; deleted: string; model: unknown }>;
        cutout: (image: string) => Promise<{ ok: boolean; foreground: string; mask: string }>;
        pbr: (payload: { image: string; normalConvention?: string; tileable?: boolean }) => Promise<{ ok: boolean; maps: Record<string, string>; normalConvention: string; tileable: boolean; size: { width: number; height: number } }>;
        spine: (payload: { image: string; resolution?: number; resolutionDepth?: number }) => Promise<{ ok: boolean; parts: Array<{ name: string; png: string; bounds: { x: number; y: number; width: number; height: number } }>; partCount: number; elapsed: number; cached?: boolean }>;
        upscale: (payload: { image: string; scale?: number; targetLongEdge?: number; method?: string }) => Promise<{ ok: boolean; image: string; width: number; height: number; scale: number; method: string }>;
        angle: (payload: { image: string; yaw?: number; pitch?: number; zoom?: number }) => Promise<{ ok: boolean; image: string; width: number; height: number }>;
      };
      windowControls?: {
        minimize: () => void;
        toggleMaximize: () => void;
        close: () => void;
        beginDrag?: () => void;
        endDrag?: () => void;
      };
    };
  }
}
