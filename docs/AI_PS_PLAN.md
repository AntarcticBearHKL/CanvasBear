# OpenCanvas PS AI 完整实现（本地部署版）

> 范围：**不做文字生成 PBR，不做生成式填充/扩图；放大/修复放到画布；Spine 只拆件，不做骨骼/权重/IK/动画/Spine JSON/atlas。**
>
> 形态：**完全本地部署**。Electron 启动一个本机 Python FastAPI sidecar，模型、推理、文件全部留在本机；不调用 OpenRouter / fal.ai / Hugging Face Space 等云端 AI API，也不要求用户配置任何 AI key。

---

## 1. 最终架构

```text
Renderer (Image Studio / AI Studio 面板)
        │ preload: window.openCanvasDesktop.ai
        ▼
Electron Main
  electron/ai-service.cjs
   ├─ 健康检查 GET /health
   ├─ 按需启动 ai-service/.venv/Scripts/python.exe -m uvicorn app:app
   ├─ 127.0.0.1:3214，仅本机回环
   └─ 退出应用时结束子进程
        │ HTTP (loopback)
        ▼
ai-service/app.py (FastAPI)
   ├─ BiRefNet                    去背景 / mask
   ├─ Depth Anything V2 Small     PBR 高度
   ├─ 确定性图像处理               BaseColor / Normal / Roughness / Metallic / AO
   └─ See-through blockswap       动漫角色拆件
        │ subprocess
        ▼
ai-service/vendor/see-through/inference/scripts/inference_psd_blockswap.py
```

关键点：

- **不经过任何云服务**，没有 API key、没有上传、没有按次计费。
- Renderer 只拿得到本地 IPC 结果，不直接访问 Python 进程。
- 模型按需加载，第一次调用会慢一些，之后常驻显存/内存。
- AI 结果直接写回 PS 的普通图层 / 蒙版，进入现有撤销历史。

---

## 2. 功能范围

| 能力 | 是否做 | 本地实现 |
|---|---|---|
| 去背景 | 是 | BiRefNet（`ZhengPeng7/BiRefNet`） |
| 输出透明前景 + 蒙版 | 是 | 前景 RGBA + 灰度 mask |
| 图片/贴图 → PBR | 是 | Depth Anything V2 Small + 确定性通道生成 |
| BaseColor / Height / Normal / Roughness / Metallic / AO | 是 | 六张全画布尺寸 PNG |
| Normal OpenGL / DirectX | 是 | 绿色通道翻转 |
| 平铺接缝柔化 | 是 | 可选 tileable 边缘混合 |
| Spine / 动漫角色拆件 | 是 | See-through blockswap |
| 拆件结果作为独立图层 | 是 | 保留全画布位置与透明区域 |
| 文字生成 PBR | 否 | 不做 |
| 生成式填充 / 扩图 / 对象替换 | 否 | 不做 |
| PS 放大 / 修复 | 否 | 放到画布模块，不进 PS |
| Spine 骨骼 / 权重 / IK / 动画 / JSON / atlas | 否 | 只拆件 |

---

## 3. 本地模型与管线

### 3.1 去背景：BiRefNet

- Hugging Face 仓库：`ZhengPeng7/BiRefNet`，`trust_remote_code=True`。
- 输入缩放到 1024×1024，ImageNet 归一化；本机 RTX 4060 Ti 上必须使用 **half 精度** 输入，否则会报 dtype 不匹配。
- 输出 sigmoid mask 缩放回原图尺寸，写入前景 alpha，同时返回灰度 mask。
- 依赖：`torch 2.8.0+cu128`、`transformers 5.0.0`、`timm`。

### 3.2 图片 → PBR

不是生成式模型，而是 **Depth Anything V2 Small + 确定性图像处理**：

1. 读取 RGBA，按 alpha 找到实际内容包围盒；透明边不参与计算。
2. BaseColor：大尺度高斯光照估计做去光照（delighting），并保持白场；透明边不参与计算。
3. Height：Depth Anything V2 Small 单目深度，归一化；失败时退回亮度细节。
4. Normal：对高度图做 Sobel，归一化为切线空间法线；支持 OpenGL / DirectX。
5. AO：高度与局部模糊的差值，压出凹槽。
6. Roughness：局部对比度/方差映射。
7. Metallic：低饱和 + 高亮区域启发式。
8. 所有通道放回原画布包围盒，透明区域保持透明。
9. `tileable=true` 时对六张图做边缘 wrap 混合，降低明显接缝。

输出为六张 PNG data URL，前端作为六个图层加入；只显示 BaseColor，其余默认隐藏，避免盖住画面。所有彩色通道按 RGB→BGR 编码，避免红蓝互换。

### 3.3 Spine 拆件：See-through blockswap

- 仓库：`shitagaki-lab/see-through`，已 vendored 到 `ai-service/vendor/see-through`。
- 使用 `inference/scripts/inference_psd_blockswap.py`，这是当前能在 16GB 显存上跑通的量化/分块版本。
- 输入单张动漫角色图，输出语义部件（back hair、face、topwear、bottomwear、legwear、footwear 等）以及每件的 alpha 边界。
- 只取部件 PNG 和 bounds；**不生成骨骼、不写 Spine JSON、不生成 atlas**。
- 1024 分辨率实测 18 个部件，耗时约 691 秒；默认改为 768，降低等待时间。
- 首次运行会下载 See-through 权重，之后从本机缓存加载。

---

## 4. AI Service API

服务地址：`http://127.0.0.1:3214`

### `GET /health`

```json
{
  "ok": true,
  "gpu": true,
  "gpuName": "NVIDIA GeForce RTX 4060 Ti",
  "birefnetLoaded": true,
  "depthLoaded": true,
  "seeThrough": true
}
```

### `POST /v1/cutout`

```json
{ "image": "data:image/png;base64,..." }
```

返回：

```json
{
  "ok": true,
  "foreground": "data:image/png;base64,...",
  "mask": "data:image/png;base64,..."
}
```

### `POST /v1/pbr`

```json
{
  "image": "data:image/png;base64,...",
  "normalConvention": "opengl",
  "tileable": false
}
```

返回：

```json
{
  "ok": true,
  "maps": {
    "baseColor": "data:image/png;base64,...",
    "height": "...",
    "normal": "...",
    "roughness": "...",
    "metallic": "...",
    "ao": "..."
  },
  "normalConvention": "opengl",
  "tileable": false,
  "size": { "width": 640, "height": 360 }
}
```

### `POST /v1/spine`

```json
{
  "image": "data:image/png;base64,...",
  "resolution": 768,
  "resolutionDepth": 720
}
```

返回：

```json
{
  "ok": true,
  "parts": [
    {
      "name": "face",
      "png": "data:image/png;base64,...",
      "bounds": { "x": 120, "y": 40, "width": 180, "height": 200 }
    }
  ],
  "partCount": 18,
  "elapsed": 300.0
}
```

错误统一返回 FastAPI 的 `detail`，Electron 会把它抛给面板显示。

---

## 5. Electron 接入

### 5.1 主进程

- `electron/ai-service.cjs`
  - `health()`：5 秒超时探测。
  - `ensureStarted()`：未启动时 spawn Python，最多等 90 秒健康检查。
  - `request(endpoint, payload, timeout)`：使用 Node `http.request` 发送 JSON；spine 默认 20 分钟超时，避免 fetch 默认 5 分钟响应头超时。
  - `stop()`：应用退出时用 `taskkill /T` 结束服务及其推理子进程。
- `electron/main.cjs`
  - `ai:status` / `ai:cutout` / `ai:pbr` / `ai:spine` 四个 IPC handler。
  - `before-quit` 调用 `aiService.stop()`。
- `electron/preload.cjs`
  - 暴露 `window.openCanvasDesktop.ai.status/cutout/pbr/spine`。
- `src/types.d.ts`
  - 对应 TypeScript 类型。

### 5.2 服务目录解析

`ai-service.cjs` 按顺序查找：

1. 环境变量 `OC_AI_SERVICE_DIR`
2. `process.resourcesPath/ai-service`
3. 可执行文件同级的 `ai-service`
4. 开发仓库路径 `D:\Dev\opencanvas\ai-service`

找到包含 `app.py` 的目录即使用。venv 路径固定为 `<serviceDir>/.venv/Scripts/python.exe`。

### 5.3 端口

默认 `3214`，可用 `OC_AI_PORT` 覆盖。服务只绑定 `127.0.0.1`。

---

## 6. PS 内的 AI Studio

### 入口

- 顶部菜单 **Filter → AI Studio…**
- 顶栏右侧 **AI Studio** 按钮

### 面板

三个标签：

1. **Cutout**
   - 调用 BiRefNet。
   - 预览透明前景 + mask。
   - **Add as Layer**：新增 `Cutout` 图层，同时把 mask 写入图层蒙版，图层面板显示 `mask` 徽标。
2. **Material**
   - Normal 约定：OpenGL / DirectX。
   - Tileable 开关。
   - 六张通道预览。
   - **Add PBR Layers**：新增六个 `PBR *` 图层；BaseColor 可见，其余隐藏。
3. **Spine Parts**
   - 分辨率：512 / 768 / 1024，默认 768。
   - 拆件后显示部件网格，可勾选。
   - **Add Selected Parts**：每个部件一个独立图层，保留全画布位置和透明区域。

### 源图

打开面板时取当前活动图层；如果活动图层完全透明，则取合成画布。这样导入图片后直接点 AI Studio 即可。

### 图层应用与撤销

- 所有 AI 结果都通过 `addAIImageLayers()` 写入普通 `layerCanvases`。
- 应用完成后调用 `remember({ layers, activeLayer })`，把新图层一次性写入历史快照。
- `Ctrl+Z` / Edit → Undo 可整体撤销一次 AI 应用。
- PBR 的六层是一次历史步骤，不是六步。
- Cutout 的 mask 也包含在历史快照里。

### 图片导入

`File → Open Image…` 会把图片按比例居中绘制到当前图层。此前 PS 没有导入入口，AI 面板也就没有可用源图，本次一并补上。

---

## 7. 本地环境安装

### 7.1 Python 环境

```powershell
cd D:\Dev\opencanvas\ai-service
uv venv --python 3.12 .venv
uv pip install --python .venv/Scripts/python.exe `
  torch==2.8.0+cu128 torchvision==0.23.0+cu128 torchaudio==2.8.0+cu128 `
  --index-url https://download.pytorch.org/whl/cu128
uv pip install --python .venv/Scripts/python.exe `
  numpy==2.2.6 opencv-python==4.13.0.92 pillow==12.1.1 scipy==1.15.3 `
  scikit-image==0.25.2 einops==0.8.2 transformers==5.0.0 diffusers==0.37.0 `
  huggingface-hub==1.7.2 tokenizers==0.22.2 accelerate==1.13.0 safetensors==0.7.0 `
  simple-parsing==0.1.8 kornia==0.8.2 omegaconf==2.3.0 pycocotools==2.0.11 `
  tqdm==4.67.3 psd-tools==1.14.2 bitsandbytes==0.49.2 fastapi==0.116.1 `
  uvicorn==0.46.0 python-multipart timm matplotlib==3.9.4 pandas==2.3.3 scikit-learn==1.7.2
uv pip install --python .venv/Scripts/python.exe -e vendor/see-through/common
```

### 7.2 启动服务

```powershell
cd D:\Dev\opencanvas\ai-service
.venv\Scripts\python.exe -m uvicorn app:app --host 127.0.0.1 --port 3214
```

或：

```powershell
powershell -ExecutionPolicy Bypass -File ai-service\start.ps1
```

正常使用时不需要手动启动：Electron 会在第一次 AI 请求时自动拉起。

### 7.3 模型缓存

- Hugging Face：默认用户缓存目录（`%USERPROFILE%\.cache\huggingface`）。
- See-through：首次运行自动下载到同一缓存。
- 临时任务：`ai-service/workspace/`，可安全删除。

### 7.4 显存

- BiRefNet：约 2–3 GB（half）。
- Depth Anything V2 Small：约 1 GB。
- See-through：峰值接近 16 GB；1024 分辨率在 RTX 4060 Ti 16GB 上可跑通，但很慢。
- 三个模型不会同时加载；按调用顺序懒加载。

---

## 8. 实测性能

| 任务 | 分辨率 | 耗时 | 备注 |
|---|---|---|---|
| Cutout | 1024 内部 | 数秒 | 首次含模型加载 |
| PBR | 原图 | 约 2.6 秒（预热后） | 首次含 Depth 模型加载约 11 秒 |
| Spine | 1024 | 约 691 秒 | 18 个部件 |
| Spine | 768 | 约 9–10 分钟 | 19–21 个部件，默认档位 |

第一次 AI 请求还需要等待 Python 进程启动和 torch 初始化，通常 5–15 秒。

Spine 结果按「输入图片 + 分辨率 + 深度分辨率」缓存在 `ai-service/workspace/spine-cache`；同一张图再次拆件会直接返回缓存，面板状态显示「本地缓存」。缓存读取时会自动把 See-through 的方形输出映射回源图宽高比，保证部件与画布位置对齐。

---

## 9. 打包与更新

- 安装目录：`C:\Users\antar\AppData\Local\Programs\opencanvas`
- 用户数据：`%APPDATA%\opencanvas`
- 构建：`npm run build`
- 直接更新桌面版：

```powershell
npm run update:desktop
```

该命令构建 `release-install/win-unpacked`，复制 `app.asar` 到安装目录并重启，不重新跑安装器。

**注意**：`ai-service` 及 venv 目前不打进 `app.asar`，仍从开发仓库路径加载。移动项目目录时设置 `OC_AI_SERVICE_DIR` 指向新的 `ai-service`。

---

## 10. 隐私与安全

- 服务只监听 `127.0.0.1`，不接受局域网/公网连接。
- 图片只在 Renderer → Electron IPC → 本机 HTTP 之间传递，不上传云端。
- 不读取、不保存任何第三方 AI key。
- `ai-service/workspace` 里的拆件中间文件是本机临时文件，可随时清理。
- 面板会显示本地引擎状态（GPU / CPU / 错误），不会伪造成功结果。

---

## 11. 验收清单

已完成并实测：

- [x] 本地 AI 服务启动、健康检查、GPU 识别。
- [x] BiRefNet 去背景返回前景 + mask。
- [x] Cutout 结果作为新图层 + 蒙版加入，撤销可移除。
- [x] PBR 六通道生成；透明边不产生黑边。
- [x] PBR 六层作为一次历史步骤加入，撤销可整体移除。
- [x] Normal OpenGL / DirectX、Tileable 参数透传。
- [x] Spine API 在 1024 分辨率下返回 18 个部件。
- [x] Spine API 在 768 分辨率下返回 21 个部件，耗时约 545 秒。
- [x] PS 内新增 `File → Open Image…`。
- [x] AI Studio 面板可从菜单和顶栏按钮打开。
- [x] 面板显示本地引擎状态。
- [x] Cutout 应用后自动隐藏源图层，撤销恢复。
- [x] PBR BaseColor 白底不被压灰，RGB 通道顺序正确。
- [x] Spine 结果在 PS 内作为 19 个图层叠加，位置与源图对齐，撤销可整体移除。
- [x] 相同图片再次拆件命中本地缓存，面板即时返回。

待补：

- [ ] 大图/4K 输入的内存与耗时测试。

---

## 12. 已知限制

- See-through 很慢，1024 约 11 分钟；默认 768，但仍不是实时交互。
- 没有任务队列/进度条，面板只显示任务文字和已用时间，长任务期间不能取消。
- PBR 是启发式 + 单目深度，不是真实材质反照率；金属/粗糙度是近似值。
- 没有 ORM 打包、EXR 导出、3D 材质预览。
- 没有通用物体拆件；Spine 拆件只针对动漫角色。
- 没有文字生成 PBR、生成式填充、扩图、对象替换。
- 放大/修复尚未实现，按计划放在画布模块。
- `ai-service` 未随安装包分发，依赖本机仓库路径或 `OC_AI_SERVICE_DIR`。

---

## 13. 文件地图

| 文件 | 作用 |
|---|---|
| `ai-service/app.py` | FastAPI 服务与三个推理端点 |
| `ai-service/start.ps1` | 手动启动脚本 |
| `ai-service/.venv/` | Python 3.12 + torch cu128 环境 |
| `ai-service/vendor/see-through/` | See-through 源码与推理脚本 |
| `ai-service/workspace/` | 拆件中间文件 |
| `electron/ai-service.cjs` | 本地服务生命周期与 HTTP 客户端 |
| `electron/main.cjs` | AI IPC handler |
| `electron/preload.cjs` | `window.openCanvasDesktop.ai` |
| `src/types.d.ts` | AI 桥接类型 |
| `src/components/AIPanel.tsx` | Cutout / Material / Spine Parts 面板 |
| `src/components/ImageStudioScreen.tsx` | 入口、源图、图层应用、撤销 |
| `src/components/StudioIcons.tsx` | AI 图标 |
| `src/styles/app.css` | AI 面板与引擎状态样式 |
| `docs/AI_PS_PLAN.md` | 本文档 |
