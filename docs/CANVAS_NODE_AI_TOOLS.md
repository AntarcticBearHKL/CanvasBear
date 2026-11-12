# 画布节点 AI 工具

## 节点 hover 工具栏

| 动作 | 行为 |
|---|---|
| Info | 打开节点信息弹窗（生成节点不显示） |
| Duplicate | 复制节点 |
| AI Cutout | 打开独立的 Cutout 弹窗 |
| PBR | 打开独立的 PBR 弹窗 |
| Upscale | 打开独立的 Upscale 弹窗 |
| Segment | 打开独立的 Segment 弹窗 |
| Angle | 打开独立的 Angle 弹窗 |
| Delete | 删除节点 |

已移除：Crop、Mask、Split、Analyze、OCR、Layers、Resolution。

- Resolution 与 Upscale 合并，统一在 Upscale 弹窗里配置倍率或目标分辨率。
- 生成节点（`image-attempt`）不显示 Info。
- 所有按钮 hover 后立即显示 label，不依赖浏览器原生 `title` 延迟。
- 多选工具栏和底部 dock 同样使用即时 label。

## 节点层级与删除入口

- 节点层级采用窗口式覆盖：最后 focus / 点击的节点 `z-index` 最高。
- 点击被部分遮挡的节点会把它提到最前；新建、复制、AI 生成节点自动置顶。
- 层级单独持久化到 localStorage `<canvas-key>:z`，刷新或切换画布后保持。
- 拖动时不再临时改 `z-index`，避免松手后层级丢失。
- 删除入口只在 hover 工具栏和选择工具栏；底部 dock 不再显示 Delete。

## 透明图片背景

- 节点图片、生成节点图片、Smart Canvas / Image Stack 封面、图片预览弹窗都使用浅色黑白格背景。
- 透明 PNG / WebP 的透明区域会显示棋盘格；不透明图片正常覆盖。
- 预览弹窗改为 `<img>` + `object-fit: contain`，透明区域和留白都显示棋盘格。
- 棋盘格尺寸 16px，浅灰/白，不抢图片内容。

## 独立弹窗

每个 AI 功能都是独立弹窗，不再共用一个带左侧导航的面板：

| 弹窗 | 宽度 | 配置 |
|---|---|---|
| AI Cutout | 780px | 直接执行 |
| PBR | 920px | Normal 约定、Tileable |
| Upscale | 600px | 倍率 / 目标分辨率、算法 |
| Segment | 980px | 分辨率、部件勾选 |
| Angle | 700px | Yaw、Pitch、Zoom |

### Cutout

- 本地 BiRefNet。
- 结果：透明前景 + mask 预览。
- Apply：新增一个 Cutout 图片节点。

### PBR

- Normal：OpenGL / DirectX。
- Tileable 开关。
- 结果：BaseColor / Height / Normal / Roughness / Metallic / AO 六张图。
- Apply：新增六个图片节点，按 3×2 排列在源节点右侧。

### Upscale

- 两种模式：
  - **Scale**：2x / 3x / 4x。
  - **Target size**：1024 / 2048 / 4096 / 8192，或直接输入目标长边像素。
- 算法下拉：
  - Lanczos + Sharpen
  - Bicubic + Sharpen
  - Bilinear
  - Nearest
- 弹窗实时显示源尺寸和预计输出尺寸。
- 最大输出边长 8192。
- Apply：新增放大图片节点，节点尺寸按实际输出比例放大。

### Segment

- 分辨率：512 / 768 / 1024。
- 使用本地 See-through blockswap。
- 结果：部件网格，可勾选。
- Apply：每个部件裁剪到 bounds，按源图比例放到源节点位置，作为独立图片节点。
- 首次运行较慢，弹窗显示已用时间；相同输入命中本地缓存。

### Angle

- Yaw：-45° ~ 45°
- Pitch：-30° ~ 30°
- Zoom：0.8x ~ 1.4x
- 预览使用 CSS 3D 透视；实际输出使用本地 OpenCV 透视变换。
- Apply：新增角度图片节点。
- 这是本地透视角度工具，不是生成式 3D 重绘。

## Node Info 滚动优化

- JSON 视图不再序列化 base64 图片。
- 顶层 `src` 和 `versions[].src` 显示为 `[base64 image]`。
- 大版本历史也能流畅滚动。

## 服务与 IPC

本地 AI 服务：

```text
POST /v1/upscale  { image, scale?, targetLongEdge?, method? }
  -> { image, width, height, scale, method }
POST /v1/angle    { image, yaw, pitch, zoom }
  -> { image, width, height }
```

Electron：

- `ai:upscale`
- `ai:angle`
- preload：`window.openCanvasDesktop.ai.upscale/angle`

## 画布性能

- 节点拖动：直接对 `.node-shell` 做 `translate3d`，松手才提交 React state 和一条历史。
- 画布平移：直接对 `.canvas-world` 做 `translate3d`，点阵层同步 `translate3d`，松手才提交 `view`。
- 平移不再每帧 `setView`，也不再用 `background-position` 重绘整张点阵背景。
- `NodeBody` 使用 `memo`，选择、层级、hover 变化不会重新渲染节点图片。
- 悬停工具栏用 `transform` 定位，拖动时不再改 `left/top` 触发布局。
- 画布数据（nodes/wires + 图片）改存 IndexedDB：`open-canvas-store` / `canvases`。
- localStorage 只保留很小的 z-order；旧的 `open-canvas:electron-canvas:<id>` 会在首次加载时迁移到 IndexedDB 并删除。
- IndexedDB 写入异步执行，不再 `JSON.stringify` 十几 MB 到 localStorage。
- 保存延迟到 `requestIdleCallback`，并在拖动/平移/缩放中跳过；交互结束后自动补存。
- 加载时显示“加载画布…”遮罩，直到 IndexedDB 数据就绪。
- 每个画布独立记住视角：`open-canvas:electron-canvas:<id>:view` 保存 `{ x, y, k }`。
- 视角变化后立即写入（数据很小），切换画布 / 重新进入时恢复，不再重置到 0,0,1。
- 删除画布时同时删除 IndexedDB 数据和 localStorage 的旧键（含 view / z）。
- 节点拖动时缓存宽高，避免每帧读取 `offsetWidth/offsetHeight`。

## 涉及文件

| 文件 | 作用 |
|---|---|
| `src/components/NodeAIModals.tsx` | 五个独立 AI 弹窗 |
| `src/components/CanvasScreen.tsx` | 节点 hover 工具栏、结果节点创建、Info JSON 优化 |
| `src/styles/app.css` | 即时 label、独立弹窗与预览样式 |
| `ai-service/app.py` | `/v1/upscale`、`/v1/angle` |
| `electron/main.cjs` | AI IPC |
| `electron/preload.cjs` | AI bridge |
| `src/types.d.ts` | AI bridge 类型 |

## 图片分辨率上限与 8K 查看器

### 画布图片上限

- 画布节点图片统一限制最长边 **2048px**。
- 导入 / AI 生成 / 放大结果超过 2048px 时，画布只保留 2048px 版本。
- 原图保存到 IndexedDB `open-canvas-store` / `images`，节点只保存 `originalSrcId`、`originalWidth`、`originalHeight`。
- 这样 8K 图片不会直接进入节点 DOM，避免画布卡死。
- 处理大图时显示“正在处理图片…”提示。

### 双击 image node

- image node 双击会在当前画布上打开覆盖式 `ImageViewer`，不再切换成全屏页面。
- 查看器只覆盖画布区域，侧栏和标题栏仍然可见；打开时指针、滚轮和拖拽只作用于图片，不会带动后面的画布。
- 查看器加载 IndexedDB 里的原图；如果原图不存在，回退到节点上的 2048px 图片。
- 操作：
  - 左键拖拽：平移
  - 滚轮：缩放
  - 中键拖拽：上下拖动缩放
  - 双击：适应 / 100% 切换
  - `0`：适应，`1`：100%，`Esc`：关闭查看器
- 顶部显示原图尺寸、缩放比例，支持下载原图。

## SVG 节点

- 底部 dock 的 SVG 按钮创建 SVG 节点；MCP 用 `canvas_create_node(nodeType="svg", svg="...")` 创建。
- 节点源码保存在 `svg` 字段，渲染时转成 `data:image/svg+xml` 放进 `<img>`，脚本不会执行。
- 双击 SVG 节点打开源码编辑器，`Ctrl+Enter` 应用，`Esc` 取消。
- Agent 流程：创建 SVG 节点 → `app_screenshot` 看效果 → `canvas_get_node_content` 读回源码 → `canvas_update_nodes(patch={svg})` 修改 → 再截图。
- image 节点只存位图，不再接受 SVG；导入 `.svg` 文件会自动栅格化成 PNG。
- SVG 节点和 image 节点一样有右侧输出端口，可以连线到生成节点；生成时自动栅格化成 PNG，结果是位图 image 节点。

## MCP 节点截图

- `app_screenshot()` 截整个窗口。
- `app_screenshot(nodeId="…", projectId="…")` 只输出该节点的图片内容，返回 PNG 和尺寸/类型元数据。
- 不需要把目标节点滚进视口，也不需要切到前台画布；节点截图直接从项目数据渲染。
- SVG 节点按源码重新栅格化到最长边 2048，细节比窗口截图清楚。
- image / 生成节点优先使用 IndexedDB 里的原图；GIF 只取第一帧。

## 人物设定流程（MCP prompt）

- MCP 内置 prompt `character design`，OpenCode 里的命令是 `/opencanvas:character_design`。
- 传入的人物描述会附在 prompt 末尾；不传也可以，prompt 会先要求补充描述。
- 固定流程：
  1. 粗描述 → 复述要点，只问最多 2 个关键问题。
  2. 新建 SVG 节点，480×720 竖版，多轮修改并用节点截图检查。
  3. 人物确认后，用 SVG 参考生成纯白底人物设定图。
  4. 设定图满意后，创建四个生成节点（正面 / 四分之三 / 侧面 / 背面），共用同一个 SVG 参考。
  5. 四个节点只改视角句，其余提示词完全一致。
- 生成用 `canvas_ai(action="generate", nodeId=生成节点)`，会使用该节点版本的 prompt 和 referenceIds；SVG 自动栅格化。

### 8K 查看器性能

- 使用 `createImageBitmap` 解码原图，避免 `<img>` + CSS 大图缩放。
- 缩放 < 100% 时使用 2048px 预览位图；100% 以上使用原图。
- 每帧只 `drawImage` 可见区域（源矩形裁剪），不绘制整张 8K 图。
- 平移 / 缩放只更新 ref，`requestAnimationFrame` 合并绘制，不触发 React 重渲染。
- 实测 8K（7680×4320）在 100% 下拖拽平均帧间隔约 8.3ms。

## 本地模型管理

- 本地模型权重统一放在软件根目录的 `model` 文件夹：
  - 开发环境：`D:\Dev\opencanvas\model`
  - 安装版：`%LOCALAPPDATA%\Programs\opencanvas\model`
- `model/huggingface/hub` 是 HuggingFace 缓存，`model/torch` 是 Torch 缓存。
- Settings → Local Models 可以查看：
  - 模型名称、用途、仓库、大小
  - 是否安装、是否加载
  - GPU 名称、VRAM 使用量、系统 RAM、AI 进程内存
- 支持手工操作：Download、Delete、Load、Unload。
- 第一次使用 Cutout / PBR / Segment 前会提示缺少模型，确认后才开始下载；不会静默下载到 HuggingFace 用户缓存。
- BiRefNet 和 Depth Anything 可以手工 Load/Unload；See-through 每次拆件启动子进程，不常驻显存。
- `model` 文件夹已加入 `.gitignore`，不会提交进仓库。
