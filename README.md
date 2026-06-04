# GLM StatusLine Claude Code 插件

这是一个用来学习和试玩 Claude Code 插件开发的小项目。

项目最初的目的很简单：想看看 Claude Code 的插件、skill、status line、local marketplace 这些扩展能力怎么组合在一起。后来我直接让 Codex 参与开发，把一个 GLM / Z.ai 用量状态栏脚本包装成了 Claude Code 插件，并补上安装、卸载、验证和过程文档。

它不是 GLM、Z.ai 或 Claude Code 官方插件，只是一个学习型实验项目。如果你也想研究 Claude Code 插件怎么写，这个仓库可以当一个比较小但完整的样例。

## 插件功能

### 1. Claude Code 状态栏

插件会把 `glm-statusline.js` 注册为 Claude Code 的 `statusLine` 命令，在 Claude Code 底部显示 GLM Coding Plan 的关键用量。

当前状态栏输出类似：

```text
5H ██░░░░░░ 22% @18:30 │ Context █████░░░ 68% │ Session 160K
```

显示内容包括：

- `5H`：GLM Coding Plan 的 5 小时额度使用率。
- `@HH:mm`：优先显示 API 返回的下一次 5H 重置时间；接口没有返回时，显示最近一次成功刷新 quota 的时间。
- `Context`：当前 Claude Code 会话上下文占用比例。
- `Session`：当前 transcript 中累计的 token 数。

状态栏显示字段可以配置。支持的字段有 `plan`、`5h`、`mcp`、`context`、`model`、`session`、`day`、`30d`，默认显示 `5h`、`context`、`session`。

### 2. GLM / Z.ai API 用量读取

脚本会根据 Claude Code settings 里的环境变量读取 GLM / Z.ai API：

- `ANTHROPIC_BASE_URL`：用来推导 monitor API 根地址。
- `ANTHROPIC_AUTH_TOKEN`：用于访问 quota 和 usage 接口。
- `/api/monitor/usage/quota/limit`：读取套餐、5H、MCP/tool、weekly 等额度信息。
- `/api/monitor/usage/model-usage`：读取当天和近 30 天 token 用量。

为了避免 Claude Code 状态栏频繁刷新时反复请求接口，插件会把 API 结果缓存到：

```text
~/.claude/glm-statusline-cache.json
```

默认缓存时间是 60 秒，可以通过 `GLM_STATUSLINE_CACHE_TTL_MS` 调整。

### 3. 详细套餐信息命令

插件提供 `/glm-statusline:plan-details`，用于查看更完整的 GLM Coding Plan 明细。这个命令会运行：

```bash
glm-statusline.js --plan-details
```

输出内容包括：

- 当前套餐名。
- 5H 使用率、已用量、总量和重置时间。
- MCP/tool 使用率。
- Weekly limit，如果 API 返回了相关字段。
- 其他可识别 limit。
- Day token 用量。
- 30D token 用量。
- API host、key 是否已配置、缓存新鲜度。

### 4. 显示配置与预览

插件提供 `/glm-statusline:configure`，用于进入一个选择界面，逐个选择状态栏显示哪些字段。每次选择都会保存配置，并立即打印选择后的预览效果：

```text
/glm-statusline:configure
```

配置会写入：

```text
~/.claude/glm-statusline-config.json
```

预览会直接输出在当前 Claude Code 对话中，例如：

```text
Select fields to show. Type a number to toggle it, q to finish.
1. [x] plan
2. [x] 5h quota
3. [ ] mcp/tools
4. [x] context

Preview:
GLM Lite │ 5H ██░░░░░░ 22% @18:30 │ MCP █░░░░░░░ 8% │ Context █████░░░ 68% (200K) │ Session 160K
```

真实底部状态栏会在下一次 Claude Code 交互或 refresh interval 后刷新。

### 5. 安装与卸载 skill

插件内置四个 Claude Code skill：

- `/glm-statusline:install`：启用状态栏，也可以同时传入显示配置参数。
- `/glm-statusline:configure`：选择显示字段并打印预览。
- `/glm-statusline:uninstall`：移除本插件管理的状态栏配置。
- `/glm-statusline:plan-details`：显示详细套餐和用量信息。

安装脚本会写入 `~/.claude/settings.json` 的 `statusLine` 字段，并在修改前自动备份已有 settings 文件。

卸载时只会移除本插件管理的 status line。如果你已经换成了别的 status line，它不会强行删除用户自己的配置。

### 6. 稳定 launcher

插件安装后会写入一个稳定入口：

```text
~/.claude/glm-statusline-launcher.js
```

这样做是为了避免 Claude Code 插件更新后，`statusLine.command` 仍然指向旧版本插件缓存路径。之后运行：

```bash
claude plugin update glm-statusline@bingqiangzhou-tools
```

稳定 launcher 会自动寻找最新安装版本的 `bin/glm-statusline.js`。

### 7. 本地验证

项目提供了验证脚本：

```bash
npm test
```

验证内容包括：

- `.claude-plugin/plugin.json` 和 `.claude-plugin/marketplace.json` 是否正确。
- package、plugin、marketplace 版本是否一致。
- `bin/`、`skills/`、`docs/` 必要文件是否存在。
- status line 在模拟 Claude Code stdin 下能正常输出。
- 配置文件可以控制状态栏显示字段。
- `--preview` 可以打印选择后的状态栏预览。
- `--plan-details` 能展示 5H、MCP、Weekly、Day、30D 等信息。
- configure 命令可以写入配置文件。
- install / uninstall 是否正确写入和移除 settings。
- 稳定 launcher 是否能正常工作。

## 安装方法

### 前置条件

- Node.js 18 或更高版本。
- 已安装 Claude Code。
- 有 GLM / Z.ai API Key。

### 1. 添加本地 marketplace

在 Claude Code 中运行：

```text
/plugin marketplace add /Users/bingqiangzhou/Workspaces/Projects/CCStatusline
```

### 2. 安装插件

```text
/plugin install glm-statusline@bingqiangzhou-tools
```

### 3. 启用状态栏

```text
/glm-statusline:install
```

启用后，Claude Code 下一次交互时状态栏就会刷新。
安装输出会提示你运行 `/glm-statusline:configure`，用交互式选择界面配置状态栏显示哪些内容。

也可以安装时直接选择显示内容：

```text
/glm-statusline:install --show=plan,5h,mcp,context,session --layout=full --bar-width=8
```

### 4. 配置 GLM / Z.ai 环境变量

把 GLM / Z.ai 相关配置放到 Claude Code settings 的 `env` 中，例如 `~/.claude/settings.json`：

```json
{
  "env": {
    "ANTHROPIC_AUTH_TOKEN": "your GLM or Z.ai API key",
    "ANTHROPIC_BASE_URL": "https://open.bigmodel.cn/api/anthropic",
    "ANTHROPIC_DEFAULT_OPUS_MODEL": "glm-5.1",
    "ANTHROPIC_DEFAULT_SONNET_MODEL": "glm-5.1",
    "ANTHROPIC_DEFAULT_HAIKU_MODEL": "glm-4.5-air",
    "GLM_STATUSLINE_CONTEXT_WINDOW": "200000"
  }
}
```

如果 API 没有返回套餐名，可以手动设置：

```json
{
  "env": {
    "GLM_STATUSLINE_PLAN": "GLM Pro"
  }
}
```

### 5. 选择显示字段并预览

```text
/glm-statusline:configure
```

支持字段：

- `plan`：套餐名。
- `5h`：5 小时额度。
- `mcp`：MCP/tool 额度。
- `context`：上下文占用。
- `model`：Claude Code 当前模型映射后的 GLM 模型名。
- `session`：当前会话 token。
- `day`：当天 token。
- `30d`：近 30 天 token。

如果只想保留最简洁显示：

```text
运行 /glm-statusline:configure 后，只保留 5h、context、session 三项为选中状态，然后输入 q 结束。
```

也保留参数式配置，方便脚本化使用：

```text
/glm-statusline:configure --show=5h,context,session --layout=compact
```

### 6. 查看详细用量

```text
/glm-statusline:plan-details
```

### 7. 卸载状态栏

```text
/glm-statusline:uninstall
```

如果只是更新插件，通常不需要卸载，直接运行：

```bash
claude plugin update glm-statusline@bingqiangzhou-tools
```

## 本地开发

```bash
npm test
npm run statusline
```

也可以直接用当前目录启动 Claude Code：

```bash
claude --plugin-dir .
```

常用环境变量：

| 变量 | 作用 |
| --- | --- |
| `GLM_STATUSLINE_PLAN` | API 不返回套餐名时的手动兜底 |
| `GLM_STATUSLINE_CONFIG_FILE` | 自定义显示配置文件，默认 `~/.claude/glm-statusline-config.json` |
| `GLM_STATUSLINE_DISPLAY` | 不写配置文件时，用逗号分隔字段控制显示内容 |
| `GLM_STATUSLINE_LAYOUT` | `compact` 或 `full` |
| `GLM_STATUSLINE_CONTEXT_WINDOW` | 手动指定上下文窗口大小，默认 `200000` |
| `GLM_STATUSLINE_CACHE_TTL_MS` | API 缓存时间，默认 `60000` |
| `GLM_STATUSLINE_CACHE_FILE` | 自定义缓存文件位置，常用于测试隔离 |
| `GLM_STATUSLINE_TIMEOUT_MS` | API 请求超时时间，默认 `2200` |
| `GLM_STATUSLINE_BAR_WIDTH` | 进度条宽度，默认 `8` |
| `GLM_STATUSLINE_DEBUG` | 设置为 `1` 时输出调试错误信息 |

## 开发过程记录

这次开发大致经历了几个阶段：

1. 先研究 Claude Code 的扩展方式，确认 status line 本身由用户 settings 里的 `statusLine.command` 控制。
2. 再把原始 `glm-statusline.js` 保持为单文件脚本，减少拆分成本，让它继续负责 API 请求、缓存、token 统计和状态栏渲染。
3. 然后新增插件包装层：`.claude-plugin/plugin.json`、`.claude-plugin/marketplace.json`、`bin/` launcher 和 `skills/`。
4. 接着实现 `/glm-statusline:install` 和 `/glm-statusline:uninstall`，用安装脚本显式写入或移除 `~/.claude/settings.json`。
5. 后来补上稳定 launcher，解决插件更新后 status line 命令可能指向旧缓存版本的问题。
6. 再补充 `/glm-statusline:configure` 和 `--preview`，让用户可以选择字段并看到预览。
7. 最后补充 `--plan-details`、验证脚本、CHANGELOG 和开发文档。

这中间最值得注意的取舍是：插件可以被安装，但 Claude Code 的主状态栏仍然属于用户界面配置。直接让插件静默覆盖用户 status line 不太合适，所以本项目采用“先安装插件，再由用户运行 install skill 显式启用”的方式。

更详细的过程写在这里：

- [Claude Code 插件构建过程与 GLM StatusLine 分析](docs/claude-code-plugin-build-guide.md)
- [Claude Code Skill 写法与扩展能力地图](docs/claude-code-skills-and-extensions-guide.md)
- [Changelog](CHANGELOG.md)

## 参考资料

Claude Code 官方文档：

- [Create plugins](https://code.claude.com/docs/en/plugins.md)
- [Plugins reference](https://code.claude.com/docs/en/plugins-reference.md)
- [Create and distribute a plugin marketplace](https://code.claude.com/docs/en/plugin-marketplaces.md)
- [Customize your status line](https://code.claude.com/docs/en/statusline.md)
- [Extend Claude with skills](https://code.claude.com/docs/en/skills.md)
- [Commands](https://code.claude.com/docs/en/commands.md)
- [Hooks reference](https://code.claude.com/docs/en/hooks.md)
- [Connect Claude Code to tools via MCP](https://code.claude.com/docs/en/mcp.md)

项目里参考和使用到的运行时能力：

- Node.js 标准库：`fs`、`path`、`os`、`http`、`https`、`url`、`child_process`。
- Claude Code `statusLine`：通过 stdin 接收当前会话 JSON，通过 stdout 输出状态栏文本。
- Claude Code plugin：用 `.claude-plugin/plugin.json` 描述插件。
- Claude Code local marketplace：用 `.claude-plugin/marketplace.json` 让本地目录可以被 `/plugin marketplace add` 添加。
- Claude Code skill：用 `skills/<name>/SKILL.md` 暴露 `/glm-statusline:*` 命令。
- GLM / Z.ai monitor API：读取 quota limit 和 model usage。

## 后续可以继续写或做的事

- 增加 README 截图，展示状态栏和 `/glm-statusline:plan-details` 的实际效果。
- 增加 `/glm-statusline:diagnose`，自动检查 API key、base URL、settings、缓存文件和 status line command。
- 增强 `/glm-statusline:configure`，继续加入 GLM/Z.ai `env` 的交互式配置。
- 把插件发布到更正式的 marketplace，而不只是本地路径安装。
- 给 quota API 返回结构补更多样例测试，避免接口字段变化后解析失效。
- 给 README 增加常见问题，比如状态栏不刷新、显示 0%、API key 缺失、旧版本 launcher 残留等。
