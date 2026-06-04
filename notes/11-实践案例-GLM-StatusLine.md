# 实践案例：GLM StatusLine 插件

> 学习笔记系列 · 第十一篇（完结篇）
>
> 本篇以 GLM StatusLine 插件为完整案例，展示如何组合 Claude Code 插件系统的各项能力来构建一个实用插件。

## 目录

- [1. 项目背景](#1-项目背景)
- [2. 需求分析](#2-需求分析)
- [3. 能力选型](#3-能力选型)
- [4. 插件结构设计](#4-插件结构设计)
- [5. 核心脚本设计](#5-核心脚本设计)
- [6. 插件包装层](#6-插件包装层)
- [7. 稳定 Launcher 方案](#7-稳定-launcher-方案)
- [8. Skill 设计](#8-skill-设计)
- [9. 安装脚本设计](#9-安装脚本设计)
- [10. 验证与测试](#10-验证与测试)
- [11. 开发过程回顾](#11-开发过程回顾)
- [12. 设计决策总结](#12-设计决策总结)
- [13. 可扩展方向](#13-可扩展方向)

---

## 1. 项目背景

GLM（智谱 AI）和 Z.ai 是提供 Claude Code 兼容 API 的平台。用户使用这些平台时，需要关注自己的用量配额（5 小时额度、MCP/tool 额度、token 用量等）。

**问题**：用户需要频繁切换到 GLM/Z.ai 网页查看用量，或者用量耗尽才知道需要等待。

**解决方案**：把用量信息显示在 Claude Code 底部的状态栏，实时可见。

## 2. 需求分析

### 核心需求

1. 在 Claude Code 底部状态栏显示 GLM/Z.ai 用量
2. 显示内容包括：5 小时额度、上下文占用、会话 token
3. 可配置显示哪些字段
4. 安装和卸载要方便

### 扩展需求

5. 显示套餐名、MCP/tool 额度、当天/30天用量
6. 详细用量信息命令
7. 交互式配置界面
8. 插件更新后状态栏不失效

### 约束

- 不引入外部依赖（只用 Node.js 标准库）
- 单文件核心脚本（方便维护）
- 尊重用户现有 settings（不强制覆盖）

## 3. 能力选型

根据 [第一篇](01-插件系统概览.md) 的能力地图，本插件需要用到：

| 能力 | 是否使用 | 理由 |
| --- | --- | --- |
| **plugin.json** | ✅ | 插件身份和元数据 |
| **marketplace.json** | ✅ | 本地分发 |
| **skills/** | ✅ | 安装、配置、卸载、详情四个命令 |
| **bin/** | ✅ | 状态栏脚本和安装脚本，加入 PATH |
| hooks/ | ❌ | 不需要自动触发逻辑 |
| .mcp.json | ❌ | 直接用 http 模块调 API，不需要 MCP 中间层 |
| .lsp.json | ❌ | JavaScript 项目，不需要语言服务器 |
| output-styles/ | ❌ | 不需要改变 Claude 的回答风格 |
| themes/ | ❌ | 不需要改变终端视觉主题 |
| monitors/ | ❌ | 状态栏用 statusLine.command 机制，不需要 Monitor |

**选型思路**：用最少的插件能力完成任务。不用的能力就不放，保持插件结构简洁。

## 4. 插件结构设计

最终的插件目录结构：

```text
CCStatusline/
├── .claude-plugin/
│   ├── plugin.json              ← 插件身份
│   └── marketplace.json         ← 本地 marketplace
│
├── bin/                         ← 可执行脚本（加入 PATH）
│   ├── glm-statusline.js        ← 状态栏入口（薄入口，4 行）
│   └── glm-statusline-install.js ← 安装/配置/卸载 CLI（约 440 行）
│
├── skills/                      ← Skill 定义
│   ├── install/SKILL.md         ← /glm-statusline:install
│   ├── configure/SKILL.md       ← /glm-statusline:configure
│   ├── plan-details/SKILL.md    ← /glm-statusline:plan-details
│   └── uninstall/SKILL.md       ← /glm-statusline:uninstall
│
├── glm-statusline.js            ← 核心脚本（单文件，约 1100 行）
├── scripts/
│   └── verify.js                ← 验证脚本
├── package.json
├── CHANGELOG.md
└── README.md
```

### 设计原则

1. **核心脚本在根目录**：`glm-statusline.js` 作为独立文件存在，不拆分
2. **bin/ 只有薄入口**：`bin/glm-statusline.js` 只有 4 行，转发到根目录脚本
3. **Skill 做指令层**：告诉 Claude 该做什么，不包含实际逻辑
4. **Bin 脚本做执行层**：包含实际的安装、配置、卸载逻辑

## 5. 核心脚本设计

### 5.1 为什么单文件

`glm-statusline.js` 约 1100 行，保持单文件的原因：

1. **statusLine 机制**：Claude Code 的 `statusLine.command` 指向一个可执行文件，单文件最简单
2. **零依赖**：不需要 `npm install`，用 Node.js 标准库即可
3. **方便调试**：`echo '{}' | node glm-statusline.js` 就能测试
4. **避免路径问题**：不需要处理模块查找路径

### 5.2 核心模块

```text
glm-statusline.js
│
├── 配置层
│   ├── mergeEnvFromSettings()     ← 合并三层 settings 的 env
│   └── readStatusConfig()         ← 读取显示配置
│
├── API 层
│   ├── fetchQuota()               ← 获取额度信息
│   ├── fetchModelUsage()          ← 获取 token 用量
│   └── 缓存系统                   ← loadCache / saveCache / isFresh
│
├── 数据处理层
│   ├── mapClaudeModelToGlm()      ← 模型名映射
│   ├── getContextInfo()           ← 上下文信息
│   ├── readJsonlTokenStats()      ← 会话 token 统计
│   └── classifyLimit()            ← 额度分类
│
├── 渲染层
│   ├── renderStatusLine()         ← 状态栏渲染
│   ├── renderPlanDetails()        ← 详细信息渲染
│   ├── renderBar()                ← 进度条渲染
│   ├── wrapSegments()             ← 终端宽度换行
│   └── displayLength()            ← 显示宽度计算
│
└── 容错层
    └── main() catch handler       ← 崩溃时输出安全兜底
```

### 5.3 数据流

```text
Claude Code 每 5 秒调用 statusLine command
  ↓
stdin JSON（model、context_window、transcript_path、workspace）
  ↓
glm-statusline.js
  ├── 合并环境变量（settings env + process env）
  ├── 读取显示配置（~/.claude/glm-statusline-config.json）
  ├── 检查缓存是否新鲜（默认 60 秒）
  │     ├── 新鲜 → 用缓存
  │     └── 过期 → 请求 GLM API
  │           ├── /api/monitor/usage/quota/limit
  │           └── /api/monitor/usage/model-usage（仅 day/30d 字段需要）
  ├── 解析 transcript 文件获取 session token
  ├── 渲染状态栏文本
  └── stdout 输出

  ↓
Claude Code 底部显示
  5H ██░░░░░░ 22% @18:30 │ Context █████░░░ 68% │ Session 160K
```

### 5.4 关键设计决策

#### 三层 Settings 合并

```text
用户级 ~/.claude/settings.json (env)
  ↓ 合并
项目级 .claude/settings.json (env)
  ↓ 合并
项目级 .claude/settings.local.json (env)
  ↓ 合并
当前进程环境变量
```

这确保了无论在哪个项目目录下运行，都能获取到 GLM API 配置。

#### 缓存与字段联动

```text
配置了 day 或 30d 字段？
  ├── 是 → 请求 model-usage API + quota API
  └── 否 → 只请求 quota API
```

没有配置就不浪费 API 调用。

#### 终端宽度换行

```text
COLUMNS=80
  5H ██░░░ 22% @18:30 │ Context █████░░░ 68% │ Session 160K
  ←────────── 一行放得下 ──────────→

COLUMNS=50
  5H ██░░░ 22% @18:30 │ Context █████░░░ 68%
  Session 160K
  ←── 第一行 ──→ ←──── 第二行 ────→
```

换行只在字段边界进行，不会在字段中间断开。显示宽度正确处理 CJK 和 `█░` 块字符。

## 6. 插件包装层

### 6.1 plugin.json

```json
{
  "name": "glm-statusline",
  "displayName": "GLM StatusLine",
  "description": "Configurable GLM / Z.ai usage status line for Claude Code.",
  "version": "1.2.3",
  "author": {
    "name": "CCStatusline"
  },
  "license": "MIT",
  "keywords": ["claude-code", "statusline", "glm"]
}
```

### 6.2 marketplace.json

```json
{
  "name": "bingqiangzhou-tools",
  "owner": { "name": "CCStatusline" },
  "description": "Local marketplace for the GLM StatusLine Claude Code plugin.",
  "version": "1.2.3",
  "plugins": [{
    "name": "glm-statusline",
    "displayName": "GLM StatusLine",
    "source": "./",
    "description": "Configurable GLM / Z.ai usage status line...",
    "version": "1.2.3",
    "category": "interface",
    "tags": ["statusline", "glm"]
  }]
}
```

### 6.3 为什么"安装插件"和"启用状态栏"是两步

```text
第一步：/plugin install glm-statusline@bingqiangzhou-tools
  → Claude Code 发现插件，加载 skill 和 bin

第二步：/glm-statusline:install
  → 安装脚本写入 settings.json 的 statusLine.command
```

**不自动启用的原因**：

1. `statusLine` 是用户级界面配置，自动覆盖有风险
2. 用户可能已经有别的 statusLine，不应该静默替换
3. 安装脚本可以做备份、检测和提示

## 7. 稳定 Launcher 方案

### 7.1 问题

Claude Code 通过 marketplace 安装插件时会把插件复制到缓存目录，每个版本一个子目录：

```text
~/.claude/plugins/cache/bingqiangzhou-tools/glm-statusline/
├── 1.2.2/
│   └── bin/glm-statusline.js    ← 旧版本
└── 1.2.3/
    └── bin/glm-statusline.js    ← 新版本
```

如果 `settings.json` 中的 `statusLine.command` 指向旧版本路径，更新后会失效。

### 7.2 解决方案

安装时写入一个稳定 launcher：

```text
~/.claude/glm-statusline-launcher.js
```

launcher 的逻辑：

```javascript
// 简化版 launcher
const fs = require('fs');
const path = require('path');

// 查找最新版本的插件缓存
const cacheDir = path.join(
  process.env.HOME, '.claude', 'plugins', 'cache',
  'bingqiangzhou-tools', 'glm-statusline'
);

// 列出所有版本目录，按 semver 排序
const versions = fs.readdirSync(cacheDir)
  .filter(d => /^\d+\.\d+\.\d+$/.test(d))
  .sort((a, b) => compareSemver(b, a));  // 降序

// 使用最新版本
const latest = versions[0];
const scriptPath = path.join(cacheDir, latest, 'bin', 'glm-statusline.js');

require(scriptPath);
```

### 7.3 效果

```text
settings.json 中的 statusLine.command：
  'node ~/.claude/glm-statusline-launcher.js'
    ↓
launcher 自动找到最新版本
    ↓
插件更新后状态栏继续工作，不需要重新安装
```

## 8. Skill 设计

四个 Skill 的设计决策：

### install

```yaml
description: Enable the GLM status line in Claude Code user settings after
             the plugin is installed.
disable-model-invocation: true
```

- **设 disable-model-invocation**：安装会写入 `~/.claude/settings.json`，必须由用户显式触发
- **不接收显示参数**：字段选择统一交给 `/glm-statusline:configure`

### configure

```yaml
description: Open an interactive selector for choosing GLM StatusLine fields.
disable-model-invocation: true
```

- **设 disable-model-invocation**：配置修改是用户主动操作

### plan-details

```yaml
description: Show detailed GLM Coding Plan quota and usage information.
disable-model-invocation: true
```

### uninstall

```yaml
description: Remove the GLM status line from Claude Code user settings.
disable-model-invocation: true
```

- **设 disable-model-invocation**：卸载会修改 settings，同样只允许用户手动触发

## 9. 安装脚本设计

`glm-statusline-install.js` 处理三个子命令：

### 9.1 install 子命令

```text
1. 读取 ~/.claude/settings.json
2. 检查是否已有 statusLine 配置
   ├── 有 → 提醒用户当前配置
   └── 无 → 继续
3. 写入稳定 launcher（~/.claude/glm-statusline-launcher.js）
4. 写入 statusLine.command 指向 launcher
5. 输出安装结果和预览
```

### 9.2 configure 子命令

```text
1. 显示当前配置
2. 逐个字段让用户选择
3. 每次选择后保存配置
4. 运行 --preview 显示预览
5. 输入 q 结束
```

### 9.3 uninstall 子命令

```text
1. 读取 ~/.claude/settings.json
2. 检查 statusLine 是否是本插件管理的
   ├── 是 → 移除
   └── 否 → 提示"非本插件配置，不删除"
3. 输出卸载结果
```

关键安全设计：**只移除自己管理的配置**。如果用户已经换成别的 statusLine，不会误删。

## 10. 验证与测试

`scripts/verify.js` 包含约 20 个测试用例：

```text
验证内容：
  ├── 插件文件结构
  │     ├── plugin.json 合法
  │     ├── marketplace.json 正确
  │     └── 版本号一致
  │
  ├── 状态栏脚本
  │     ├── 默认输出包含 5H、Context、Session
  │     ├── 配置字段切换正确
  │     ├── 终端宽度换行正确
  │     ├── --preview 输出预览
  │     └── --plan-details 输出详情
  │
  ├── 安装脚本
  │     ├── install 写入 settings.json
  │     ├── configure 交互选择
  │     ├── uninstall 正确移除
  │     └── 不误删非本插件配置
  │
  └── 稳定 launcher
        └── 自动找到最新版本
```

运行方式：

```bash
npm test
```

## 11. 开发过程回顾

这个插件的开发经历了 9 个阶段：

### 阶段 1：研究 Claude Code 扩展方式

确认 `statusLine.command` 机制——Claude Code 定期调用命令，通过 stdin/stdout 交互。

### 阶段 2：实现单文件状态栏脚本

`glm-statusline.js` 作为独立脚本，不依赖任何插件能力。可以直接在终端测试。

### 阶段 3：添加插件包装层

创建 `.claude-plugin/`、`bin/`、`skills/`，让 Claude Code 能发现和加载。

### 阶段 4：实现安装/卸载 skill

`/glm-statusline:install` 和 `/glm-statusline:uninstall`。

### 阶段 5：稳定 Launcher

解决插件更新后 statusLine 失效的问题。

### 阶段 6：交互式配置

`/glm-statusline:configure` 支持逐个字段选择和即时预览。

### 阶段 7：详细用量命令

`/glm-statusline:plan-details` 展示完整的套餐信息。

### 阶段 8：终端宽度自适应

根据 `COLUMNS` 环境变量在字段边界换行，正确处理 CJK 和块字符宽度。

### 阶段 9：验证和文档

补全验证脚本、CHANGELOG 和开发文档。

## 12. 设计决策总结

| 决策 | 选择 | 原因 |
| --- | --- | --- |
| 核心脚本 | 单文件 | statusLine 机制最适合单文件，方便调试 |
| 依赖管理 | 零依赖 | 用户不需要 npm install，任何 Node.js 环境都能用 |
| 安装方式 | 显式两步 | statusLine 是用户配置，自动覆盖有风险 |
| 入口模式 | 薄入口 | bin/ 只有 4 行，逻辑在根目录 |
| 版本稳定 | Launcher | 插件更新后自动找到最新版本 |
| 配置存储 | 独立文件 | `glm-statusline-config.json` 不混入 settings.json |
| 缓存策略 | 按需 + 60秒 | 减少API调用，只在需要时请求 |
| 错误处理 | 兜底输出 | 即使崩溃也输出一行有效状态栏 |

## 13. 可扩展方向

基于当前插件结构，可以继续添加的能力：

### 使用 Hooks

```json
{
  "hooks": {
    "SessionStart": [{
      "matcher": "startup",
      "hooks": [{
        "type": "command",
        "command": "${CLAUDE_PLUGIN_ROOT}/bin/glm-statusline-install.js check"
      }]
    }]
  }
}
```

会话启动时自动检查状态栏配置是否有效。

### 使用 Monitors

```json
[
  {
    "name": "quota-watch",
    "command": "${CLAUDE_PLUGIN_ROOT}/scripts/quota-watch.sh",
    "when": "always",
    "description": "Warns when GLM/Z.ai quota is running low"
  }
]
```

额度低于 10% 时主动通知 Claude。

### 使用 Agents

```text
agents/
└── api-diagnostic.md
```

当用户报告状态栏问题时，Claude 自动启动诊断 agent。

### 使用 Output Styles

```markdown
---
name: usage-aware
description: When discussing GLM/Z.ai usage, suggest optimizations.
---
```

讨论用量时 Claude 主动提供建议。

## 系列导航

本系列以 GLM StatusLine 插件为贯穿案例，逐一讲解了 Claude Code 插件系统的各项能力：

| 篇号 | 主题 | 文件 |
| --- | --- | --- |
| 1 | 插件系统概览 | [01-插件系统概览.md](01-插件系统概览.md) |
| 2 | Skill | [02-Skill.md](02-Skill.md) |
| 3 | Agents | [03-Agents.md](03-Agents.md) |
| 4 | Hooks | [04-Hooks.md](04-Hooks.md) |
| 5 | MCP | [05-MCP.md](05-MCP.md) |
| 6 | LSP | [06-LSP.md](06-LSP.md) |
| 7 | Output Styles | [07-Output-Styles.md](07-Output-Styles.md) |
| 8 | Themes | [08-Themes.md](08-Themes.md) |
| 9 | Monitors | [09-Monitors.md](09-Monitors.md) |
| 10 | Bin | [10-Bin.md](10-Bin.md) |
| 11 | **实践案例：GLM StatusLine** | 本篇 |

## 参考资料

- [Claude Code 官方文档 - Create plugins](https://code.claude.com/docs/en/plugins.md)
- [Claude Code 官方文档 - Plugins reference](https://code.claude.com/docs/en/plugins-reference.md)
- [Claude Code 官方文档 - Customize your status line](https://code.claude.com/docs/en/statusline.md)
- [Claude Code 官方文档 - Plugin marketplaces](https://code.claude.com/docs/en/plugin-marketplaces.md)
- [GLM StatusLine GitHub 仓库](https://github.com/bingqiangzhou/CCStatusline)
