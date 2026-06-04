# Claude Code Themes 详解

> 学习笔记系列 · 第八篇
>
> 本篇深入讲解 Claude Code Themes：终端视觉主题的定义方式、颜色 token、内置主题、热加载和最佳实践。

## 目录

- [1. Theme 是什么](#1-theme-是什么)
- [2. 文件格式](#2-文件格式)
- [3. 颜色 Token 参考](#3-颜色-token-参考)
- [4. 内置主题](#4-内置主题)
- [5. 颜色值格式](#5-颜色值格式)
- [6. 插件中的 Themes](#6-插件中的-themes)
- [7. 热加载](#7-热加载)
- [8. 创建自定义主题](#8-创建自定义主题)
- [9. 最佳实践](#9-最佳实践)
- [10. 本项目实例](#10-本项目实例)

---

## 1. Theme 是什么

Theme 是改变 Claude Code **终端视觉外观**的配置。它通过覆盖颜色 token 来调整文本颜色、背景色和样式。

```text
默认主题：
  Claude Code 使用标准终端颜色

Dracula 主题：
  紫色调背景、绿色高亮、橙色警告

One Dark 主题：
  深色背景、蓝色关键字、黄色字符串
```

Theme 只影响颜色，不影响功能。它是一种纯视觉定制。

> **注意**：Themes 目前标记为 **experimental**，API 可能变化。

## 2. 文件格式

Theme 是 JSON 文件，放在 `themes/` 目录下。

### 基本结构

```json
{
  "name": "My Theme",
  "base": "dark",
  "overrides": {
    "text": "#e0e0e0",
    "text.dim": "#808080",
    "accent": "#bb86fc",
    "success": "#03dac6"
  }
}
```

### 字段说明

| 字段 | 类型 | 必需 | 说明 |
| --- | --- | --- | --- |
| `name` | string | 是 | 主题显示名称 |
| `base` | string | 是 | 基础主题：`"dark"` 或 `"light"` |
| `overrides` | object | 是 | 颜色 token 覆盖映射 |

`base` 决定未覆盖的 token 使用什么默认值。`dark` 使用暗色默认，`light` 使用亮色默认。

## 3. 颜色 Token 参考

### 文本颜色

| Token | 说明 |
| --- | --- |
| `text` | 主要文本颜色 |
| `text.dim` | 次要/弱化文本 |
| `text.bold` | 粗体文本 |
| `text.italic` | 斜体文本 |
| `text.link` | 链接/URL |

### 语义颜色

| Token | 说明 |
| --- | --- |
| `accent` | 强调色（按钮、高亮） |
| `success` | 成功状态 |
| `warning` | 警告状态 |
| `error` | 错误状态 |
| `info` | 信息提示 |

### 界面元素

| Token | 说明 |
| --- | --- |
| `background` | 主背景色 |
| `background.hover` | 鼠标悬停背景 |
| `border` | 边框颜色 |
| `divider` | 分隔线颜色 |

### 代码高亮

| Token | 说明 |
| --- | --- |
| `code.keyword` | 关键字（if、for、function） |
| `code.string` | 字符串 |
| `code.comment` | 注释 |
| `code.number` | 数字 |
| `code.function` | 函数名 |
| `code.type` | 类型名 |
| `code.variable` | 变量名 |
| `code.operator` | 操作符 |

### 工具相关

| Token | 说明 |
| --- | --- |
| `tool.name` | 工具名 |
| `tool.input` | 工具输入 |
| `tool.output` | 工具输出 |

> Claude Code 有约 69 个颜色 token，上面列出的是最常用的约 35 个。其余 token 可以在官方文档中查找完整列表。

## 4. 内置主题

Claude Code 提供了 6 个内置主题变体：

| 主题 | base | 特点 |
| --- | --- | --- |
| Default Dark | dark | 标准暗色主题 |
| Default Light | light | 标准亮色主题 |
| High Contrast Dark | dark | 高对比度暗色 |
| High Contrast Light | light | 高对比度亮色 |
| Monokai | dark | 经典代码编辑器风格 |
| Nord | dark | 北极色调冷色系 |

### 切换主题

```text
/theme
```

在会话中切换主题。

### 设置默认主题

在 `~/.claude/settings.json` 中：

```json
{
  "theme": "monokai"
}
```

## 5. 颜色值格式

支持多种颜色格式：

### HEX（推荐）

```json
{
  "text": "#e0e0e0",
  "accent": "#bb86fc"
}
```

### RGB

```json
{
  "text": "rgb(224, 224, 224)",
  "accent": "rgb(187, 134, 252)"
}
```

### ANSI 颜色名

```json
{
  "text": "white",
  "accent": "magenta",
  "success": "cyan"
}
```

支持的 ANSI 颜色名：`black`、`red`、`green`、`yellow`、`blue`、`magenta`、`cyan`、`white`、`bright-black`、`bright-red` 等。

### 256 色

```json
{
  "text": "color-252",
  "accent": "color-183"
}
```

## 6. 插件中的 Themes

### 目录结构

```text
my-plugin/
├── themes/
│   ├── ocean.json
│   └── sunset.json
└── .claude-plugin/
    └── plugin.json
```

### 在 plugin.json 中配置

Themes 目前是 experimental 功能，在 `plugin.json` 中通过 `experimental.themes` 配置：

```json
{
  "name": "my-theme-pack",
  "experimental": {
    "themes": "./themes/"
  }
}
```

或指定单个文件：

```json
{
  "name": "my-theme-pack",
  "experimental": {
    "themes": ["./themes/ocean.json"]
  }
}
```

### 主题生效

插件安装后，插件提供的主题会出现在 `/theme` 的可选列表中。

## 7. 热加载

主题支持**热加载**：修改主题 JSON 文件后，Claude Code 会自动重新加载，无需重启。

这使得主题开发非常方便：修改 → 保存 → 立即看到效果。

## 8. 创建自定义主题

### 8.1 从 base 开始

创建新主题最简单的方式是选择一个 `base`，然后只覆盖想修改的 token：

```json
{
  "name": "My Ocean Theme",
  "base": "dark",
  "overrides": {
    "accent": "#0077b6",
    "success": "#00b4d8",
    "warning": "#f77f00",
    "code.keyword": "#48cae4",
    "code.string": "#90e0ef"
  }
}
```

### 8.2 完整覆盖

```json
{
  "name": "Full Custom",
  "base": "dark",
  "overrides": {
    "text": "#d4d4d4",
    "text.dim": "#6a6a6a",
    "text.bold": "#ffffff",
    "text.link": "#569cd6",
    "accent": "#c586c0",
    "success": "#4ec9b0",
    "warning": "#dcdcaa",
    "error": "#f44747",
    "info": "#9cdcfe",
    "background": "#1e1e1e",
    "background.hover": "#2d2d2d",
    "border": "#3c3c3c",
    "code.keyword": "#569cd6",
    "code.string": "#ce9178",
    "code.comment": "#6a9955",
    "code.number": "#b5cea8",
    "code.function": "#dcdcaa",
    "code.type": "#4ec9b0"
  }
}
```

### 8.3 Light 主题

```json
{
  "name": "Solarized Light",
  "base": "light",
  "overrides": {
    "text": "#657b83",
    "text.dim": "#93a1a1",
    "accent": "#268bd2",
    "success": "#859900",
    "warning": "#b58900",
    "error": "#dc322f",
    "background": "#fdf6e3",
    "code.keyword": "#859900",
    "code.string": "#2aa198",
    "code.comment": "#93a1a1"
  }
}
```

## 9. 最佳实践

### 9.1 只覆盖需要的 token

```json
// 好：只改 accent 和 code 颜色
{
  "name": "Minimal Custom",
  "base": "dark",
  "overrides": {
    "accent": "#bb86fc",
    "code.keyword": "#c792ea"
  }
}

// 不好：复制所有默认值然后改
{
  "name": "Verbose Custom",
  "base": "dark",
  "overrides": {
    // ... 69 个 token 全部列出
  }
}
```

### 9.2 确保对比度

- Dark 主题的文本色要足够亮（`#c0c0c0` 以上）
- Light 主题的文本色要足够暗（`#404040` 以下）
- accent 色要在两种背景上都清晰可辨

### 9.3 测试颜色可辨识度

- `success` 和 `error` 要明显不同（色盲友好）
- `warning` 和 `accent` 要能区分
- `text.dim` 要比 `text` 暗但仍可读

### 9.4 利用热加载快速迭代

修改主题 → 保存 → 立即看到效果 → 再调整 → 直到满意。

## 10. 本项目实例

GLM StatusLine 插件**没有提供 Theme**。状态栏的颜色由终端本身的颜色方案决定，不需要额外主题文件。

如果想让状态栏的颜色更丰富（比如低额度变红、高额度变绿），可以考虑：

1. 使用 ANSI 颜色代码在状态栏输出中添加颜色
2. 这不需要 Theme 插件，直接在 `glm-statusline.js` 的渲染逻辑中处理即可

## 参考资料

- [Claude Code 官方文档 - Plugins reference](https://code.claude.com/docs/en/plugins-reference.md)
- [Claude Code 官方文档 - Themes](https://code.claude.com/docs/en/themes.md)
- [Claude Code GitHub - Built-in themes](https://github.com/anthropics/claude-code/tree/main/themes)

## 系列导航

| ← 上一篇 | 下一篇 → |
| --- | --- |
| [第七篇：Output Styles](07-Output-Styles.md) | [第九篇：Monitors](09-Monitors.md) |
