# Claude Code 插件构建过程与 GLM StatusLine 分析

## 资料来源

本项目按 Claude Code 官方文档整理和实现：

- [Create plugins](https://code.claude.com/docs/en/plugins.md)
- [Plugins reference](https://code.claude.com/docs/en/plugins-reference.md)
- [Create and distribute a plugin marketplace](https://code.claude.com/docs/en/plugin-marketplaces.md)
- [Customize your status line](https://code.claude.com/docs/en/statusline.md)

## Claude Code 插件的关键规则

Claude Code 插件是一个自包含目录。插件身份写在 `.claude-plugin/plugin.json`，插件能力放在插件根目录的固定目录中，而不是放进 `.claude-plugin/` 下面。

常用结构如下：

```text
plugin-root/
├── .claude-plugin/
│   ├── plugin.json
│   └── marketplace.json
├── skills/
│   └── install/
│       └── SKILL.md
├── bin/
│   ├── glm-statusline.js
│   └── glm-statusline-install.js
└── glm-statusline.js
```

本项目用到这些能力：

- `plugin.json`：定义插件名、显示名、描述、版本、作者和关键词。
- `marketplace.json`：让当前目录可以作为本地 marketplace 被 `/plugin marketplace add` 添加。
- `skills/`：暴露 `/glm-statusline:install`、`/glm-statusline:configure`、`/glm-statusline:uninstall` 和 `/glm-statusline:plan-details` 命令式技能。
- `bin/`：放入 Claude Code Bash 工具的 `PATH`，让技能可以运行安装脚本。

官方文档说明，插件可以包含 `settings.json`，但插件 settings 当前适合配置插件启用后的默认设置，不适合可靠地替用户自动接管主界面的 `statusLine.command`。Claude Code 的主状态栏仍然通过用户或项目 settings 里的 `statusLine` 字段配置。因此本项目采用“插件安装后显式启用”的方式。

## 安装流程

开发调试时可以直接加载当前目录：

```bash
claude --plugin-dir .
```

按 marketplace 方式安装当前本地项目：

```text
/plugin marketplace add /Users/bingqiangzhou/Workspaces/Projects/CCStatusline
/plugin install glm-statusline@bingqiangzhou-tools
/glm-statusline:install
```

`/glm-statusline:install` 会让 Claude Code 运行：

```bash
glm-statusline-install.js install
```

该脚本会读取 `~/.claude/settings.json`，保留已有配置，只写入：

```json
{
  "statusLine": {
    "type": "command",
    "command": "'/path/to/node' '/path/to/plugin/bin/glm-statusline.js'",
    "refreshInterval": 5,
    "padding": 0
  }
}
```

如果已有 settings 文件，安装脚本会先写一个 `*.glm-statusline-plugin.bak.*` 备份。

安装时也可以直接选择显示字段：

```text
/glm-statusline:install --show=plan,5h,mcp,context,session --layout=full --bar-width=8
```

或者安装后单独配置：

```text
/glm-statusline:configure --show=5h,context,session
```

配置会写到 `~/.claude/glm-statusline-config.json`。配置命令会马上运行 `glm-statusline.js --preview` 并把选择后的效果打印在当前会话中；真实底部 status line 则会在下一次 Claude Code 交互或 refresh interval 后刷新。

卸载状态栏配置：

```text
/glm-statusline:uninstall
```

或者直接运行：

```bash
glm-statusline-install.js uninstall
```

## 现有 JS 文件主要功能分析

`glm-statusline.js` 是一个单文件 Node.js Claude Code status line 脚本。Claude Code 调用 status line 命令时，会把当前会话 JSON 通过 stdin 传给脚本，脚本再向 stdout 输出要显示的文本。

它的核心模块如下：

- 配置读取：`mergeEnvFromSettings()` 合并 `~/.claude/settings.json`、项目 `.claude/settings.json`、项目 `.claude/settings.local.json` 和当前进程环境变量；`readStatusConfig()` 读取 `~/.claude/glm-statusline-config.json` 并决定状态栏显示字段。
- GLM API 请求：`fetchQuota()` 根据 `ANTHROPIC_BASE_URL` 推导 GLM/Z.ai API 根地址，请求 `/api/monitor/usage/quota/limit`，提取套餐、5 小时用量、MCP/tool 用量和 API 返回的周额度。
- API 缓存：`loadCache()`、`saveCache()` 和 `isFresh()` 把远程用量缓存在 `~/.claude/glm-statusline-cache.json`，默认 60 秒，避免 status line 每次刷新都打 API。
- 套餐识别：`recursiveFindStringByKeys()` 和 `normalizePlanName()` 在 API 返回里递归查找 `planName`、`packageName`、`tier`、`sku` 等字段，并格式化成 `GLM Lite`、`GLM Pro` 等显示名。
- 用量识别：`classifyLimit()`、`readPercent()` 和 `readUsageDetail()` 兼容不同 API 字段名，从 limit 对象中识别 `5H`、weekly、MCP/tool 等类别，并提取百分比、已用/总量和 reset 时间。
- 模型映射：`mapClaudeModelToGlm()` 根据 Claude Code 当前显示的 `Opus`、`Sonnet`、`Haiku`，读取 `ANTHROPIC_DEFAULT_*_MODEL`，保留给未来扩展使用；当前常驻状态栏和 plan details 不显示模型名。
- Context 统计：`getContextInfo()` 优先读取 stdin 的 `context_window.used_percentage` 和 `context_window.context_window_size`，缺失时用当前 transcript token 数做兜底估算。
- Transcript token 统计：`readJsonlTokenStats()` 解析当前会话 JSONL transcript，把 input、output、cache creation、cache read token 累加成 `Sess`。
- Day/30D 统计：`fetchModelUsage()` 请求智谱/Z.ai `/api/monitor/usage/model-usage`，按官方 `yyyy-MM-dd HH:mm:ss` 时间格式传入当天和近 30 天窗口；这些数据会在 `/glm-statusline:plan-details` 中显示，也会在用户把 `day` 或 `30d` 加入 status line 配置时显示。
- 5H reset：常驻状态栏显示 `5H ... @HH:mm`；优先使用 quota 接口 5H limit 的 `nextResetTime`，接口未返回时使用 quota 数据最后一次成功刷新的时间。
- 渲染：`renderStatusLine()` 按用户选择的字段组合状态栏；`renderBar()`、`formatTokens()` 和 `formatTimeHHmm()` 负责具体格式；`renderPlanDetails()` 负责 plan details 命令输出。

最终输出形态：

```text
5H ██░░░░░░ 22% @18:30 │ Context █████░░░ 68% │ Session 160K
```

`/glm-statusline:plan-details` 输出套餐详情，例如：

```text
GLM Coding Plan
Plan: GLM Max
5H: 22% · 2M / 10M · resets 18:30
MCP: 28% · 28 / 100
Weekly: 12% · 120K / 1M · resets 2026-06-08 09:00
Day: 42.8M tokens
30D: 979.2M tokens
API: api.z.ai · key configured · cache 12s ago
```

脚本的容错策略比较适合 status line：API 失败时用缓存，缓存没有时显示 0%；脚本崩溃时也会输出一个安全兜底状态栏，避免 Claude Code 界面被状态栏错误影响。

## 本项目的插件化设计

本项目没有拆散 `glm-statusline.js`，而是新增一个插件包装层：

- `bin/glm-statusline.js`：插件内 status line launcher，直接加载根目录的 `glm-statusline.js`。
- `bin/glm-statusline-install.js`：显式启用/禁用脚本，负责写入或移除 `~/.claude/settings.json` 的 `statusLine` 字段，也负责写入显示配置和输出预览。
- `skills/install/SKILL.md`：安装技能，用户运行 `/glm-statusline:install` 后，Claude Code 会执行安装脚本。
- `skills/configure/SKILL.md`：配置技能，用户运行 `/glm-statusline:configure` 后，Claude Code 会执行 `glm-statusline-install.js configure`。
- `skills/plan-details/SKILL.md`：详情技能，用户运行 `/glm-statusline:plan-details` 后，Claude Code 会执行 `glm-statusline.js --plan-details`。
- `skills/uninstall/SKILL.md`：卸载技能，移除本插件管理的 status line 配置。
- `.claude-plugin/plugin.json`：插件清单。
- `.claude-plugin/marketplace.json`：本地 marketplace 清单。

采用显式启用脚本的原因：

1. 主 status line 是用户级界面配置，直接自动覆盖有风险。
2. 插件安装和主状态栏启用是两个不同层次：前者让 Claude Code 发现插件，后者修改用户 settings。
3. 安装脚本可以做备份、保留 `env`、检测非本插件管理的状态栏，卸载时也不会误删用户自己的 status line。

## 验证方式

项目提供本地验证：

```bash
npm test
```

验证内容包括：

- `.claude-plugin/plugin.json` 是合法 JSON，并且插件名为 `glm-statusline`。
- `.claude-plugin/marketplace.json` 包含 `glm-statusline`，且 source 为当前目录 `./`。
- `bin/`、`skills/` 和文档文件存在。
- `bin/glm-statusline.js` 能在模拟 Claude Code stdin 下输出一行包含 `5H`、`Context`、`Session` 的状态栏。
- `bin/glm-statusline.js` 能根据 `~/.claude/glm-statusline-config.json` 或测试指定的 config 文件切换显示字段。
- `bin/glm-statusline.js --preview` 能输出 `Preview:` 和当前配置对应的状态栏。
- `bin/glm-statusline.js --plan-details` 能输出 plan、5H、MCP、可选 weekly、Day/30D 和 API/cache 状态。
- `bin/glm-statusline-install.js install` 能在临时 settings 文件中写入正确 `statusLine`。
- `bin/glm-statusline-install.js configure` 能写入显示配置并打印预览。
- `bin/glm-statusline-install.js uninstall` 能移除本插件管理的 `statusLine`。

## 常用配置

GLM/Z.ai 相关配置仍然放在 Claude Code settings 的 `env` 中：

```json
{
  "env": {
    "ANTHROPIC_AUTH_TOKEN": "你的 GLM / Z.ai API Key",
    "ANTHROPIC_BASE_URL": "https://open.bigmodel.cn/api/anthropic",
    "ANTHROPIC_DEFAULT_OPUS_MODEL": "glm-5.1",
    "ANTHROPIC_DEFAULT_SONNET_MODEL": "glm-5.1",
    "ANTHROPIC_DEFAULT_HAIKU_MODEL": "glm-4.5-air",
    "GLM_STATUSLINE_CONTEXT_WINDOW": "200000"
  }
}
```

可选环境变量：

- `GLM_STATUSLINE_PLAN`：API 不返回套餐名时的手动兜底。
- `GLM_STATUSLINE_CONFIG_FILE=~/.claude/glm-statusline-config.json`：调整显示配置文件位置。
- `GLM_STATUSLINE_DISPLAY=5h,context,session`：不写配置文件时，用环境变量控制显示字段。
- `GLM_STATUSLINE_LAYOUT=compact`：控制显示布局，支持 `compact` 和 `full`。
- `GLM_STATUSLINE_CACHE_TTL_MS=60000`：调整 API 缓存时间。
- `GLM_STATUSLINE_CACHE_FILE=~/.claude/glm-statusline-cache.json`：调整缓存文件位置，主要用于测试或隔离运行。
- `GLM_STATUSLINE_TIMEOUT_MS=2200`：调整 API 超时。
- `GLM_STATUSLINE_BAR_WIDTH=8`：调整进度条宽度。

缓存策略建议：

- 默认 `60000` ms 是一个比较稳的折中：status line 每 5 秒刷新一次，但 quota、Day、30D 这类聚合数据没有必要每次都请求 API。
- 日常使用建议保留 60 秒。这样界面足够新，也不会把智谱/Z.ai monitor API 打得太频繁。
- 调试 API 或排查数据问题时，可以临时设置 `GLM_STATUSLINE_CACHE_TTL_MS=1`。
- 如果更关注减少 API 请求，可以设置为 `120000` 到 `300000` ms。代价是 5H 百分比和 Day/30D token 会慢一些更新。
- 不建议长期设置为 `0` 或 `1`，因为 Claude Code status line 刷新频繁，会显著增加接口调用。
