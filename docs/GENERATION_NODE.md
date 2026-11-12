# 生成节点：版本与加载状态

## 交互流程

1. 双击画布上的 **生成** 节点，打开生成工作台。
2. 填写 Prompt / Why / Model / Format / Aspect / Quality。
3. 点击 **Generate**，或按 `Ctrl+Enter`：
   - 工作台立即关闭；
   - 节点进入 `生成中…` 状态，显示加载遮罩、旋转指示器和 shimmer 动画；
   - 请求完成后，节点自动替换为新图片。
4. 生成成功后，当前版本锁定：
   - Prompt、Why、Model、Format、Aspect、Quality、GIF 参数全部不可修改；
   - 主按钮变为 **New version**。
5. 点击 **New version**：
   - 创建一个新版本号；
   - 完整继承上一个版本的 Prompt 和所有配置；
   - 新版本没有图片，状态为草稿，可以修改并再次生成。

## 版本切换

- 画布节点上只显示当前版本号 `vN`，**不显示版本切换 tab**。
- 生成工作台顶部是一条扁平化版本栏：
  - 左侧是 `Versions` 标签和版本数量；
  - 中间是一排版本 tab，每个 tab 带一个状态圆点；
  - 当前版本使用品牌色文字和 2px 底部指示线；
  - 右侧是扁平的 **+ New version** 按钮。
- 状态圆点：
  - 绿色：已锁定；
  - 黄色：生成中；
  - 红色：生成失败；
  - 空心：草稿。
- 当前版本是生成中/失败/草稿时，底部指示线会使用对应状态色。
- 切换版本立即生效，没有额外动画；操作简单直接。
- 可以在某个版本生成时切换到其它版本查看；后台生成完成后，对应 tab 的状态会更新。
- 画布节点的图片显示规则：
  - 当前选中版本有图片：显示该版本的图片；
  - 当前选中版本没有图片（草稿 / 生成中 / 失败）：自动显示前一个最近有图片的版本；
  - 版本号仍然显示当前选中的版本号，方便知道正在编辑哪一版。

## 版本规则

**版本必须按顺序锁定：只有最新版本可以是草稿、生成中或失败状态；它之前的所有版本必须已经生成成功并锁定。**

- 当前版本未锁定时，工作台的 **+ New version** 是禁用状态，不能创建下一个版本。
- 只有前面的版本全部锁定后，才能点击进入后面的版本 tab；否则 tab 显示为禁用。
- 新建版本只允许在「当前版本是最新版本且已锁定」时进行，并继承该版本的 Prompt、Why、Model、Format、Aspect、Quality、GIF 设置，不继承图片。
- 历史版本只读；要修改或继续生成，先切换到最新版本。
- 生成失败的版本保留错误信息，可直接修改后重试；重试成功后才算锁定，才能创建下一个版本。
- 如果旧数据出现「v2 未锁定、v3 已锁定」这种非法链，加载时会保留到第一个未锁定版本为止，丢弃它之后的版本。例如 v1 已锁定、v2 是草稿、v3 已锁定，会保留 v1 和 v2，移除 v3。

| 版本状态 | 是否可编辑 | 主按钮 | 能否创建下一个版本 |
|---|---|---|---|
| 草稿（无图片） | 是 | Generate | 否 |
| 生成中 | 否 | Generating… | 否 |
| 生成成功（有图片） | 否 | New version | 是（且必须是最新版本） |
| 生成失败（无图片） | 是 | Generate（可重试） | 否 |
| 历史版本（已锁定） | 否 | New version（禁用） | 否，需先切到最新版本 |

## 加载动效

- 节点图片区域覆盖半透明遮罩；
- 中央旋转指示器使用品牌色顶边；
- 节点内部有 shimmer 扫光动画；
- 节点边框变为品牌色并带轻微光晕；
- 底部状态文字为 `生成中…`；
- 版本 tab 上的黄色圆点同步闪烁；
- 生成中且没有可用图片时，不再渲染 `No image` 占位符，只显示加载遮罩、spinner 和 `生成中…`，避免占位图标与动效重叠；
- 如果已有上一版图片，则保留图片作为背景，加载遮罩覆盖其上。

## GIF 配置

GPT Image 2.6 的 GIF 输出走 OpenRouter `/api/v1/images`：

| 参数 | 当前值 | 官方范围 / 默认 |
|---|---|---|
| `output_format` | `gif` | `gif` |
| `frame_count` | 9（可在 2–16 调整） | 2–16，默认 9 |
| `frame_duration_ms` | 200（可在 20–2000 调整） | 20–2000，默认 200，按 10ms 取整 |
| `size` | 不传，用 `aspect_ratio` | `auto` 或 16 的倍数尺寸 |
| `complexity` | `medium`（GPT Image 2.6） | `low` / `medium` / `high`，省略时默认 `high` |

- `complexity` 通过 `provider.options.openai.complexity` 传给 OpenAI；OpenRouter 的 `allowed_passthrough_parameters` 包含它。
- GIF Prompt 应写明：主体、动作、循环方式。建议加上“无缝循环 / 固定镜头 / 回到起始姿势 / 背景保持一致”。
- 官方示例使用 9 帧、200ms（1.8 秒循环）。需要更顺滑可用 16 帧，但会增加成本和生成时间。
- 当前画布生成是文生 GIF；如果要让一张已有图片动起来，官方建议用 image edit + 参考图，画布暂未接入 `input_references`。
- `max_tokens` 是 OpenRouter 额度预检用的应用侧参数：静图 8192，GIF 最多 16384。
- 预览弹窗下载会按实际 MIME 选择 `.gif` / `.png` / `.jpg` / `.webp` / `.svg` 扩展名。

## OpenRouter 额度与 max_tokens

- 生成请求会显式带 `max_tokens`：静图 8192，GIF 最多 12288。
- OpenRouter 会在请求前按 `max_tokens` 估算最大 token 成本；如果不传，就按模型的最大 completion 预算估算。
- 当估算值高于账户的 in-flight 额度时，即使余额为正，也会返回：
  `This request's maximum cost exceeds your available credits. Add credits, or request fewer images.`
- 现在限制 `max_tokens` 后，单次静图的预估成本约为 $0.05–0.07，通常远低于可用额度。
- 如果仍提示额度不足，请降低 quality、GIF 帧数，或给 OpenRouter 充值。
- 该错误会翻译成中文提示，原始错误仍写入运行日志。

## 快捷键

- `Ctrl+Enter` / `Cmd+Enter`：在 Prompt 或 Why 输入框中直接开始生成。
- `Escape`：关闭生成工作台（不会取消已经开始的生成）。

## 持久化

- 节点、版本、Prompt、配置和图片都保存在画布 localStorage 中。
- 如果版本图片过多导致 localStorage 超出配额：
  - 应用会保留当前活动版本的图片；
  - 旧版本的图片会从持久化数据中移除，但版本配置和 Prompt 仍保留；
  - 本次会话中旧版本图片仍在内存里，刷新后旧版本可能显示 `No image`。
- 后续可将版本图片迁移到 IndexedDB，避免 localStorage 容量限制。

## 涉及文件

| 文件 | 作用 |
|---|---|
| `src/components/CanvasScreen.tsx` | 生成节点、版本模型、工作台、加载状态、版本切换 |
| `src/styles/app.css` | 版本 tab、加载遮罩、spinner、shimmer、锁定状态样式 |

## 输入参考图

- 新建节点（生成 / 文本 / Assets / Smart Canvas / Image Stack）会出现在当前视角中心。
- 生成节点是**只进不出**：只有左侧输入端口，没有右侧输出端口。
- 只有 image node 有右侧输出端口；生成节点不能直接拉线出来。
- 如果要把生成结果作为下一轮输入：
  1. 在生成节点 hover 工具栏点 **Add as Image**。
  2. 会在生成节点右侧创建一个图片节点。
  3. 从这个图片节点右侧输出端口拉线到下一个生成节点左侧。
- 旧的生成节点 → 生成节点连线会在加载时清理，不会再显示。
- 把 image node 拖到生成节点的**左侧输入区域**才会建立连接：
  - 生成节点左侧高亮。
  - 松开后图片节点回到原位置。
  - 连线从 image node 右侧出发，进入生成节点左侧。
  - 松手在生成节点右侧或其他位置不会连接。
- 参考关系保存在生成节点当前版本的 `referenceIds` 中；切换版本时连线会跟着当前版本变化。
- 生成工作台的 Prompt 上方只显示**通过连线进入的图片**，不再列出画布上的所有图片。
- 输入图片列表中的缩略图可以拖进 Prompt：
  - Prompt 中插入的是对应图片的缩略图，而不是文字引用。
  - 只有插入 Prompt 的图片才会作为本次生成的参考图。
  - 输入列表中已插入的图片会有品牌色描边。
  - 移除输入图片会同时移除 Prompt 中对应的缩略图。
  - 已锁定的版本不能增删参考图。
- 生成请求会把 Prompt 中插入的参考图作为 `input_references` 传给 OpenRouter：
  ```json
  "input_references": [
    { "type": "image_url", "image_url": { "url": "data:image/png;base64,..." } }
  ]
  ```
- 新版本会继承当前版本的 `referenceIds` 和 Prompt。
- 参考图使用画布上的 2048px 版本，避免请求体过大；查看原图仍然走 image node 双击的覆盖式查看器。
- SVG 图片节点可以作为画布图片使用，但 OpenRouter 图像输入只接受 PNG/JPEG/WebP/GIF；发送前会自动把 SVG 栅格化为 PNG（最长边 2048px）。
- GIF 不允许作为生成输入：
  - GIF 节点不会成为连线目标，不会出现在“输入图片”列表。
  - 已有的 GIF 参考会在加载时从 `referenceIds` 和 Prompt 缩略图中清理。
  - `input_references` 发送前会再次过滤 GIF。
  - 生成出来的 GIF 仍可正常显示和查看，只是不能作为下一轮参考图。
