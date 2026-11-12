# OpenCanvas MCP

这个 MCP 直接操作正在运行的 OpenCanvas 桌面窗口。它不读本地文件，也不让你直接改 localStorage / IndexedDB；所有读写都通过桌面端 bridge 完成，窗口会实时刷新。

## 开始前先记住

- 桌面端必须运行。
- 每个画布操作都要带 `projectId`，不要凭记忆猜 id；`app_apply_ops` 省略时使用当前打开的画布。
- 删除是直接删除，没有回收站。
- 节点 id、版本 id、图片 id 都从工具返回里拿，不要自己编。
- 截图用 `app_screenshot`：不传参数截整个窗口；传 `nodeId` 只截该节点的图片输出（SVG 会自动栅格化成 PNG），适合看细节。
- `canvas_get_project` 默认会把 base64 图片替换成 `[base64 image: N chars]`，避免传输过大；要真实图片时用 `includeImages=true`，或只读单个节点 `canvas_get_node_content`。

## 推荐使用流程

### 1. 先找到目标画布

1. `app_get_state`
   - 看当前页面是 library / canvas / studio
   - 看当前打开的是哪个画布
   - 看 selection、viewport、stageSize
2. `canvas_list_projects`
   - 列出库里所有画布，返回 `id`、名称、分组、节点数、连线数
3. 如果目标画布没有打开：
   - `canvas_manage_project(action="open", id="...")`
4. `canvas_get_project(projectId)`
   - 读取真实节点和连线
   - 确认要操作的节点 id、类型、标题、当前版本

### 2. 改节点

- 创建节点：
  - `canvas_create_node(projectId, nodeType="image-attempt", ...)` 新建生成节点
  - `canvas_create_node(projectId, nodeType="image", ...)` 新建图片节点
  - `canvas_create_node(projectId, nodeType="svg", svg="<svg …>…</svg>", ...)` 新建 SVG 节点
  - `canvas_create_node(projectId, copyFromId="...")` 复制已有节点
- 批量改字段：
  - `canvas_update_nodes(projectId, ids, patch)`
  - `patch` 支持 `title/status/x/y/width/height/prompt/svg/src/count/tone`
- 批量删除：
  - `canvas_delete_nodes(projectId, ids)`
- 批量移动/缩放/对齐/分布/复制：
  - `canvas_arrange_nodes(projectId, ids, action)`
  - `action = move / resize / align / distribute / duplicate`
- 选中和视口：
  - `canvas_set_view(projectId, action="select", ids=[...])`
  - `canvas_set_view(projectId, action="deselect")`
  - `canvas_set_view(projectId, action="viewport", x, y, k)`

新建节点不传 `x/y` 时，会放在当前视口中心。

### 3. 画 SVG 并迭代

SVG 节点是唯一能保存矢量源码的节点，适合先画一个图形、看渲染效果、再继续改。image 节点只存位图，不接受 SVG。

1. 新建：
   ```text
   canvas_create_node(projectId, nodeType="svg", title="图标草图", svg="<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 400 300\">...</svg>")
   ```
2. `app_screenshot` 看实际渲染效果。
3. 读回当前源码：
   ```text
   canvas_get_node_content(projectId, nodeId)
   ```
4. 修改：
   ```text
   canvas_update_nodes(projectId, ids=[nodeId], patch={svg: "<svg ...>改过的源码</svg>"})
   ```
5. 再截图，重复直到满意。

注意：

- `svg` 要传完整源码（包含 `<svg …>` 和结束标签），不是 data URL。
- SVG 节点可以像 image 一样连线到生成节点；生成时桌面端会先把 SVG 栅格化成 PNG 再发给模型。
- 导入的 `.svg` 文件会自动栅格化成 PNG，成为普通 image 节点。

### 4. 连线、参考图和生成版本

`image` 和 `svg` 节点都有右侧输出端口；生成节点 `image-attempt` 只有左侧输入端口，不能输出连线。参考关系不是 `wires`，而是写进生成节点版本的 `referenceIds`。SVG 参考图在生成时自动变成位图，生成结果本身就是 image 节点。

使用 `canvas_manage_generation(projectId, action, ...)`：

- `action="connect"`
  - `fromNodeId` 必须是 `image` 或 `svg`，`toNodeId` 必须是 `image-attempt`
  - 写入最新版本的 `referenceIds`
  - 如果最新版本已经完成/锁定，会自动创建新的草稿版本，继承 Prompt 和配置
  - GIF、没有图片的 image、没有源码的 svg 会被拒绝
- `action="disconnect"`
  - `fromNodeId` + `toNodeId` 移除参考关系，同时删掉 Prompt 里的 `[[image:<id>]]`
- `action="list_versions"`
  - 读取生成节点的全部版本和 `activeVersion`
- `action="create_version"`
  - 只有最新版本已锁定时才能新建草稿
- `action="update_version"`
  - 更新指定版本；省略 `versionId` 时更新最新版本
- `action="extract_image"`
  - 把生成节点当前图片提取成右侧 image 节点（Add as Image）
  - 需要把生成结果继续当参考图时，先 extract，再把新 image 连到下一个生成节点

生成工作台 Prompt 里插入的图片会以缩略图显示；真正发给模型的是该版本 `referenceIds` 与 Prompt 里 `[[image:id]]` 标记的并集，SVG 会在发送前栅格化成 PNG。

### 5. 调用 AI

所有 AI 功能统一走 `canvas_ai(projectId, action, ...)`。AI 工具操作当前打开的画布；如果目标画布没打开，先：

```text
canvas_manage_project(action="open", id="...")
```

本地 AI：

- `action="cutout"`：BiRefNet 去背景，结果作为 image 节点
- `action="pbr"`：六张 PBR 通道图，结果作为 image 节点
- `action="segment"`：See-through 拆件，结果作为多个 image 节点
- `action="upscale"`：本地放大，结果作为 image 节点
- `action="angle"`：透视变换，结果作为 image 节点

常用参数：

- `nodeId`：源 image 节点；省略时用当前选中的 image，没有选中则用第一个 image
- `pbr`：`normalConvention`、`tileable`
- `segment`：`resolution`、`resolutionDepth`、`parts`（按名称过滤）
- `upscale`：`scale`、`targetLongEdge`、`method`
- `angle`：`yaw`、`pitch`、`zoom`

云端生成：

```text
canvas_ai(projectId, action="generate", nodeId="生成节点id")
```

- 传 `nodeId`（必须是 `image-attempt`）时，写入该节点当前版本，使用版本的 prompt 和 `referenceIds`；SVG 参考会自动栅格化。版本已锁定时会自动新建草稿版本。
- 不传 `nodeId` 时，用 `prompt` 新建一个 image 节点。
- 通过 OpenRouter 生成，需要桌面端 Settings 里配置 OpenRouter API key。
- 生成节点必须先把参考图 connect 上；只写在 prompt 里的 `[[image:id]]` 也算参考，但推荐用 connect。
- GIF 由生成节点自己的 `gifMode` / 帧数配置决定。需要完整版本工作台时再回 UI 调。

人物设定流程：

- MCP 提供了一个专用 prompt，名字是 `character design`；在 OpenCode 里会显示为 `/opencanvas:character_design`。
- 人物描述含空格时用引号，例如 `/opencanvas:character_design "银发女剑客，冷峻，皮甲"`。
- 流程：粗描述 → SVG 草图多轮修订 → 白底人物设定图 → 用户确认后四个生成节点（正面 / 四分之三 / 侧面 / 背面）共用同一个 SVG 参考。
- 用户输入的人物描述会作为 prompt 参数传入。

本地 AI 模型：

- 模型权重统一放在软件根目录 `model` 文件夹
- 第一次使用前需要在 Settings → Local Models 下载
- 桌面端会提示缺少的模型和大小；确认后才下载
- BiRefNet / Depth Anything 可以手工 Load / Unload；See-through 每次拆件启动子进程，不常驻显存
- 本地 AI 服务由桌面端自动启停，默认 `127.0.0.1:3214`

### 6. 验证结果

- `canvas_get_project` 看节点/版本是否写对
- `canvas_get_node_content` 看单张图片或 SVG 源码
- `app_screenshot()` 看窗口实际效果
- `app_screenshot(nodeId="…")` 只看该节点的图片输出，不依赖节点在视口里
- 不要只看“操作成功”就结束，尤其是图片、版本和参考图

## 常见任务示例

新建一个生成节点：

```text
canvas_create_node(projectId, nodeType="image-attempt")
```

新建一个 SVG 节点并写入源码：

```text
canvas_create_node(projectId, nodeType="svg", title="图标草图", svg="<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 400 300\"><circle cx=\"200\" cy=\"150\" r=\"90\" fill=\"#2f5d50\"/></svg>")
```

迭代 SVG 源码：

```text
canvas_update_nodes(projectId, ids=["svg-node-id"], patch={svg: "<svg ...>新的源码</svg>"})
```

只截某个节点的输出：

```text
app_screenshot(nodeId="svg-node-id", projectId="canvas-id")
```

把图片连接到生成节点：

```text
canvas_manage_generation(projectId, action="connect", fromNodeId="img1", toNodeId="gen1")
```

把 SVG 连接到生成节点（生成时自动转成位图）：

```text
canvas_manage_generation(projectId, action="connect", fromNodeId="svg1", toNodeId="gen1")
```

把生成结果提取成图片节点：

```text
canvas_manage_generation(projectId, action="extract_image", nodeId="gen1")
```

对当前选中的图片做抠图：

```text
canvas_ai(projectId, action="cutout")
```

用 Prompt 生成一张图片：

```text
canvas_ai(projectId, action="generate", prompt="古风少女，工笔淡彩，正面全身")
```

## 画布模型速查

- 节点类型：`image`、`image-attempt`、`image-stack`、`assets`、`smart-canvas`、`svg`
- 生成节点 `image-attempt` 有 `versions[]` + `activeVersion`；历史版本只读，只有最新版本可以是草稿/生成中/失败
- 画布节点图片最长边 2048px；原图在 IndexedDB，节点只保存 `originalSrcId` / `originalWidth` / `originalHeight`
- `svg` 节点的源码存在 `svg` 字段；image 节点只存位图，导入 SVG 会自动栅格化成 PNG
- `svg` 节点和 `image` 节点都可以作为生成参考图；生成时 SVG 自动栅格化，结果是 image 节点
- 所有文字内容都写在生成节点的 `prompt` 里，没有独立的文本节点
- 双击图片的 8K 查看器、AI 弹窗、窗口拖动属于 UI 交互，MCP 不控制

## 注意

- GIF 不能作为生成输入。
- SVG 节点是矢量源码，连线到生成节点后会在生成时自动栅格化成 PNG；生成结果是位图 image 节点。
- Upscale 是本地重采样，不是 AI 超分。
- Angle 是透视变换，不是生成式 3D 重绘。
- PBR 是启发式通道提取，不是训练出来的材质模型。
- See-through 拆件较慢，第一次运行可能需要数分钟。
- 写操作是“读取完整 project → 修改 → 覆盖写回”；不要和 UI 高频同时改同一个画布。

## 底层逃生口

`app_apply_ops` 用于批量或新工具覆盖不了的场景。先 `app_describe_actions` 看可用 op，再提交扁平操作：

```text
app_apply_ops(projectId, ops=[{ "type": "update_node", "id": "...", "patch": { ... } }])
```

不要用大量 `canvas_update_nodes` 高频模拟拖动；拖动是 UI 交互，MCP 只适合做最终位置调整。
