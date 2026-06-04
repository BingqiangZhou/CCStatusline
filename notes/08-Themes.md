# Claude Code Themes 详解

> 学习笔记系列 · 第八篇
>
> 本篇讲解 Claude Code Themes：终端视觉主题的定义方式、插件主题声明、颜色 token 的安全使用方式和最佳实践。

## 目录

- [1. Theme 是什么](#1-theme-是什么)
- [2. 文件格式](#2-文件格式)
- [3. 颜色 Token 参考](#3-颜色-token-参考)
- [4. 内置主题](#4-内置主题)
- [5. 颜色值格式](#5-颜色值格式)
- [6. 插件中的 Themes](#6-插件中的-themes)
- [7. 加载与调试](#7-加载与调试)
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
| `base` | string | 是 | 基础预设，例如 `"dark"` 或 `"light"` |
| `overrides` | object | 是 | 颜色 token 覆盖映射，建议只覆盖需要改变的 token |

`base` 决定未覆盖的 token 使用什么默认值。`dark` 使用暗色默认，`light` 使用亮色默认。

## 3. 颜色 Token 参考

官方插件参考展示的是稀疏覆盖模式：只写你确定要改的 token。不同 Claude Code 版本可能扩展或调整 token 集合，所以不要把下面的表当作完整 schema。

### 常见语义颜色

| Token | 说明 |
| --- | --- |
| `claude` | Claude 品牌/强调色（官方示例使用） |
| `success` | 成功状态 |
| `error` | 错误状态 |
| 其他 token | 以当前 Claude Code 主题编辑器或官方文档为准 |

## 4. 内置主题

Claude Code 通过 `/theme` 菜单提供内置主题和用户自定义主题。内置主题名称可能随版本调整，建议在当前环境的 `/theme` 中查看。

### 切换主题

```text
/theme
```

在会话中切换主题。

### 设置默认主题

在 settings 中可保存主题选择。插件主题被选中后，配置值类似：

```json
{
  "theme": "custom:<plugin-name>:<theme-slug>"
}
```

## 5. 颜色值格式

优先使用 HEX。其他格式是否支持以当前 Claude Code 版本为准。

### HEX（推荐）

```json
{
  "claude": "#bb86fc",
  "success": "#50fa7b"
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

插件安装并启用后，插件提供的主题会出现在 `/theme` 的可选列表中。插件主题是只读的；在 `/theme` 中对插件主题按 `Ctrl+E` 会复制一份到 `~/.claude/themes/`，之后用户可以编辑复制出来的版本。

## 7. 加载与调试

开发本地插件主题时，修改 JSON 后可以先运行 `/reload-plugins` 或重启 Claude Code，再到 `/theme` 中重新选择。不要假设 marketplace 安装后的主题文件会被实时热加载；安装版插件来自缓存目录，更新后路径也可能变化。

## 8. 创建自定义主题

### 8.1 从 base 开始

创建新主题最简单的方式是选择一个 `base`，然后只覆盖想修改的 token：

```json
{
  "name": "My Ocean Theme",
  "base": "dark",
  "overrides": {
    "claude": "#0077b6",
    "success": "#00b4d8",
    "error": "#e63946"
  }
}
```

### 8.2 完整覆盖

```json
{
  "name": "Full Custom",
  "base": "dark",
  "overrides": {
    "claude": "#c586c0",
    "success": "#4ec9b0",
    "error": "#f44747"
  }
}
```

### 8.3 Light 主题

```json
{
  "name": "Solarized Light",
  "base": "light",
  "overrides": {
    "claude": "#268bd2",
    "success": "#859900",
    "error": "#dc322f"
  }
}
```

## 9. 最佳实践

### 9.1 只覆盖需要的 token

```json
// 好：只改少量确定 token
{
  "name": "Minimal Custom",
  "base": "dark",
  "overrides": {
    "claude": "#bb86fc",
    "success": "#50fa7b"
  }
}

// 不好：复制一大批未核实 token 后只改其中一两个
{
  "name": "Verbose Custom",
  "base": "dark",
  "overrides": {
    // ... 很多未确认 token
  }
}
```

### 9.2 确保对比度

- Dark 主题的文本色要足够亮（`#c0c0c0` 以上）
- Light 主题的文本色要足够暗（`#404040` 以下）
- 强调色和状态色要在当前终端背景上都清晰可辨

### 9.3 测试颜色可辨识度

- `success` 和 `error` 要明显不同（色盲友好）
- 不要只依赖颜色传达状态；必要时配合文字或符号
- 在深色、浅色终端里都试一次

### 9.4 用 reload 或新会话验证

修改主题 → `/reload-plugins` 或重启 → 在 `/theme` 中选择 → 再调整 → 直到满意。

## 10. 本项目实例

GLM StatusLine 插件**没有提供 Theme**。状态栏的颜色由终端本身的颜色方案决定，不需要额外主题文件。

如果想让状态栏的颜色更丰富（比如低额度变红、高额度变绿），可以考虑：

1. 使用 ANSI 颜色代码在状态栏输出中添加颜色
2. 这不需要 Theme 插件，直接在 `glm-statusline.js` 的渲染逻辑中处理即可

## 参考资料

- [Claude Code 官方文档 - Plugins reference](https://code.claude.com/docs/en/plugins-reference.md)

## 系列导航

| ← 上一篇 | 下一篇 → |
| --- | --- |
| [第七篇：Output Styles](07-Output-Styles.md) | [第九篇：Monitors](09-Monitors.md) |
