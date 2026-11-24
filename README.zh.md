# dsh-excalidraw-canvas

[English](README.md) | 中文

把 Excalidraw 放进 DeepSeek Harness 的右侧栏，同时给 agent 一套工具，让它读写的
是**你手上同一张画布**。会话里的 `.excalidraw` 文件链接、右侧 Files 树里的
`.excalidraw` 文件，点一下就在这里打开。

```
你：   "画一个下单架构：web → 鉴权 → 订单，订单 → 事件 → worker"
agent：excalidraw_draw(...)     →  面板自己打开并把图画出来
你：   拖一下框、改个文字                          →  自动保存
agent：excalidraw_read("checkout")  →  看到你手改的内容
agent：excalidraw_add_images([shot-1.png, shot-2.png])  →  一行排开、等间距
agent：excalidraw_edit(把 "auth" 改成 "鉴权服务")
```

## 面板能做什么

| 操作 | 说明 |
|---|---|
| 画布选择器 | 选工作区里已有的画布，或 `+` 新建一个 |
| 重新载入 | 从磁盘重读；磁盘被外部改动时弹冲突条，可选「重新载入」或「保留我的」 |
| 适应内容 | 缩放到能看到全部内容（不改变窗口） |
| 全屏 | 整个面板进浏览器全屏，工具栏保留，右上角「退出全屏」或 `Esc` 退出 |
| 保存 PNG | 存到画布 `.excalidraw` 旁边，2× 分辨率、**透明底、零边距** |
| 下载 PNG | 同样的图交给浏览器下载（进你的下载文件夹） |
| 发送选区 | 把选中的元素渲染成图片投进对话框，停在待发送附件里由你确认 |
| 小地图 | 右下角，点/拖可移动视口，只在场景变化时重绘 |

保存与下载都遵守选中状态：**有选中就只导出选中的**（自动带上形状的文字标签，以及两端都在选区里的连线），
没有选中才导出整张画布。

## 安装

需要 DeepSeek Harness **0.2.2-rc.5**（写在 `engines.dsh` 里），从源码构建需要 Node `>=20`。
运行时不会下载任何东西：浏览器包是预构建的，React 取自页面的模块表。

```sh
# Web 版
dsh plugin --profile web add dsh-excalidraw-canvas@latest

# 桌面版
dsh plugin --profile desktop add dsh-excalidraw-canvas@latest
```

装完重启 DSH，并**硬刷新浏览器**（Cmd/Ctrl+Shift+R）：客户端包 id 跟改名前的版本不同，
开着的旧标签会继续用旧包。

也可以直接在 DSH 里用**插件 → 添加插件**（即 `plugin_manager` 的 `install_bundle`），
它接受同样的 npm 名，也接受本地路径。

<details>
<summary><strong>其他安装方式</strong></summary>

```sh
# 本地目录（live link）：改完源码跑 npm run build，再禁用/启用一次
dsh plugin --profile web add /path/to/dsh-excalidraw-canvas

# 用 npm pack 打出来的 tarball
dsh plugin --profile web add ./dsh-excalidraw-canvas-0.1.0.tgz

# 直接从仓库装
dsh plugin --profile web add github:you/dsh-excalidraw-canvas
```

`dsh plugin` 把参数直接转给 profile 目录里的 pnpm，所以 `remove`、`update` 一样可用：
`dsh plugin --profile web remove dsh-excalidraw-canvas`。

配置行写在 `cordis.patch.yml`（插件 id 是 `excalidraw-canvas`），profile 自己的
`cordis.patch.yml` 可以覆盖它，例如改成 `directory: plans` 把画布存到别处。

</details>

## 目录结构

| 路径 | 作用 |
|---|---|
| `index.js` | 宿主半边：画布存储、操作队列、HTTP 路由、五个 agent 工具 |
| `src/client/` | 浏览器半边：面板、标签类型注册、场景构建 |
| `lib/client.js` | 浏览器包（由 `scripts/build.mjs` 生成） |
| `lib/host-runtime.js` | 内置的 `defineTool` 与配置 schema（由 `scripts/build-host.mjs` 生成） |
| `assets/fonts/` | Excalidraw 的手写字体，由宿主提供 |
| `locale/`、`icon.svg`、`docs/DETAIL.md` | 插件管理器的元数据 |
| `skills/excalidraw-diagrams.md` | 作图规范，运行时注册为 `excalidraw-diagrams` 技能 |

## 构建

```sh
npm install
npm run build           # 浏览器包 + 宿主运行时
npm run check:layout    # 布局计算自检
npm run check:selection # 选区推导自检（标签、连线、已删除元素）
```

然后在 DSH 里安装这个目录：**插件 → 添加插件**，或让 `plugin_manager`
的 `install_bundle` 指向本目录。配置行写在 `cordis.patch.yml`。

## 配置

| 字段 | 默认值 | 含义 |
|---|---|---|
| `directory` | `excalidraw` | 画布目录，相对会话工作目录 |
| `openOnDraw` | `true` | agent 画图时是否自动打开面板 |
| `applyTimeoutMs` | `8000` | 一次工具调用等待面板执行的最长时间 |
| `exportTimeoutMs` | `20000` | 一次导出等待浏览器渲染的最长时间 |

## 两边是怎么协作的

宿主负责文档，以及一个内存里的待执行操作队列。面板轮询这个队列，逐条通过
Excalidraw API 执行、保存、回执。面板开着时工具报「已画好」，没开时报「已排队」——
排队的操作会一直等着，直到那张画布被打开。

画布文件就是普通的 `.excalidraw` 文档：excalidraw.com、VS Code 插件、Obsidian
都能直接打开。

## 作图约定

箭头贴形状边界；环形边会绕到外侧，但**表达「重试」更清楚的方式是画一个终止节点，把动作写进标签**
（例如「提示：密码错误\n返回重试」）。完整规范在 `skills/excalidraw-diagrams.md`：
菱形只用于单行的是/否判断、分支箭头标「是」「否」、`direction` 怎么选，以及
画 → 导出 → `read_image` 自检的循环。宿主会把它注册成运行时技能，agent 自动拿到。

## 已知限制

- 没有后台执行：面板不开，操作只会排队；导出必须面板打开。
- PNG 默认 2×（面板按钮和 `excalidraw_export` 都是），可用 `scale: 1–4` 换倍数；
  1× 是「一个场景单位一个像素」，手绘图会显得糊。
- 没有内置 Mermaid 粘贴（省掉约 3.4 MiB 包体），对话框会如实提示。
- 冲突只报告、不自动合并。
- 包里带了 Excalidraw 的字体（约 16 MB，其中 209 个 Xiaolai 分片用于中文手写体）：14.8 MB 的包换来绘制时零网络请求。
- `excalidraw_export` 始终导出整张画布，它不知道你在界面上选了什么；
  「只导出选中」是面板按钮的行为。
