# GLM StatusLine · Claude Code 状态栏插件

**GLM StatusLine** 是一个 Claude Code 状态栏插件，在 Claude Code 底部显示 GLM / Z.ai 的用量：5 小时额度、MCP/tools 额度、上下文占比、会话 token、当天 / 30 天用量、映射后的模型名、effort 等级、输出速度等。全部字段固定显示，按类别分行，终端宽度自适应换行与合并。

它不是 GLM、Z.ai 或 Claude Code 的官方插件，只是一个个人实验项目。

> **注意**：本项目无任何外部依赖，全部使用 Node.js 标准库（`fs`、`path`、`os`、`http`、`https`、`url`、`child_process`、`assert`）。

> 仓库同时附带 11 篇 Claude Code 插件系统学习笔记（`notes/` 目录），以本插件为完整实践案例，作为次要内容放在[文末附录](#claude-code-插件系统学习笔记)。

## 资料可靠性说明

这个仓库同时包含三类内容，阅读时建议区分：

- **官方文档事实**：Claude Code 插件、skill、status line、marketplace 等机制，来自 README 底部列出的 Claude Code 官方文档。
- **本项目实现选择**：比如稳定 launcher、固定全显的字段布局、缓存文件位置，是为了让这个 GLM StatusLine 插件更容易安装、更新和学习。
- **GLM / Z.ai API 兼容式解析**：`/api/monitor/usage/quota/limit` 和 `/api/monitor/usage/model-usage` 的返回结构可能随服务调整而变化。脚本会根据多种字段名做兼容式解析，测试中的 `test/fixtures/` 提供的是当前实现用来验证解析逻辑的样例，不代表官方固定 schema。

---

## 功能

### 1. Claude Code 状态栏

插件会把 `bin/glm-statusline.js` 注册为 Claude Code 的 `statusLine` 命令，在 Claude Code 底部显示 GLM Coding Plan 的关键用量。

当前状态栏输出类似（字段按类别分行；终端更宽时相邻行会自动合并，见下文「布局」一节）：

```text
Model glm-4.6 │ Effort high │ Speed 100 t/s · Avg 96 t/s
Context █▒░░░░░░ 12% │ Session 160K │ Day 42.8M │ 30D 5.98B
GLM Lite │ 5H ██▒░░░░░ 22% @18:30 │ MCP ▓░░░░░░░ 8% @06-14
```

进度条使用渐变字符（`░▒▓█`），每个格子有 4 级灰度，共 24 步（约 4% 一级），视觉上无间隙。

状态栏固定显示下方全部字段，没有字段选择配置。

支持的全部字段：

| 字段 | 说明 |
| --- | --- |
| `plan` | 当前套餐名（如 GLM Lite、GLM Pro） |
| `5h` | 5 小时额度使用率 + 进度条 + 重置时间 |
| `mcp` | MCP/tools 额度使用率 + 进度条 + 到期日期 |
| `context` | 上下文占用比例 + 进度条 |
| `model` | Claude Code 当前模型映射后的 GLM 模型名 |
| `effort` | 当前推理 effort 等级（`low` / `medium` / `high` / `xhigh` / `max`，来自 Claude Code `effort.level`） |
| `session` | 当前会话累计 token 数 |
| `speed` | 输出速度：`Speed <当前> t/s · Avg <会话均值> t/s`。并入所在分组行（与 `model`、`effort` 同行）。当前速度 = 输出 token 增量 ÷ API 耗时增量，空闲时保持上次读数；拿不到可用瞬时读数时（例如缓存被并发写坏、基线丢失）回落到会话平均速度，避免卡在 `--`；平均速度 = 自本会话首次观测以来的吞吐（锚定首 tick 的输出增量 ÷ API 耗时增量），以抵消 `/clear` 后 `cost.total_api_duration_ms` 带过来的旧 API 时间、不被压低 |
| `day` | 当天 GLM / Z.ai token 用量 |
| `30d` | 近 30 天 GLM / Z.ai token 用量 |

#### 运行流程（从安装到每一帧）

**安装期（`/glm-statusline:install`，只发生一次）**：

```text
bin/glm-statusline-install.js install
 ├─ 首次接管时备份 ~/.claude/settings.json
 ├─ 写入稳定 launcher：~/.claude/glm-statusline-launcher.js
 └─ settings.json 写入 statusLine.command = node <launcher>（refreshInterval: 30）
```

**运行期（每次刷新都执行）**。Claude Code 随会话消息更新重跑状态栏（事件驱动，约 300ms 防抖合并），空闲时按 `refreshInterval: 30` 保底每 30 秒一次。定时器取 30 秒的原因：远端字段（额度 / 用量）受 60 秒 API 缓存约束，空闲时最快每分钟才有一档新值，更快的轮询只是重复渲染同一画面；30 秒把空闲渲染量降约 83%（每小时 720 → 120 次），新额度数据平均半个缓存周期内可见。每一帧都是全新的短命进程，跑完即退：

```text
Claude Code 刷新
 └─ 进程①  node ~/.claude/glm-statusline-launcher.js      ← command 指向的稳定入口
     ├─ 扫描 ~/.claude/plugins/cache/bingqiangzhou-tools/glm-statusline/*/
     │  选最高版本号的 bin/glm-statusline.js（每次现场解析 → 插件更新后下一帧即生效）
     ├─ 扫不到 → 回退安装时记录的仓库源码路径
     └─ spawnSync 子进程，转发 stdin/stdout/env，透传退出码
         └─ 进程②  bin/glm-statusline.js（核心本体，经 ../lib/ 引用共享模块）→ 顶层 main()
             ├─ 读 stdin：Claude Code 传入的会话 JSON
             └─ renderStatusLine(…) → stdout 打出 1–3 行 → 进程退出
```

**一帧内部（`renderStatusLine`）**——三条数据来源汇成字段表，再排版输出：

```text
会话 JSON（stdin）
 ├─ context_window.used_percentage ──→ context（null/瞬时 0 视为无可靠读数，按 session_id 沿用上次值）
 ├─ model.display_name ──按 env 映射──→ model
 ├─ effort.level ──→ effort
 └─ cost.total_api_duration_ms ──────┐
transcript JSONL（按 message.id 去重）┼─→ speed（当前速度=输出增量÷API耗时增量；平均=首 tick 锚定的增量比）
 └─ 累计 token ──→ session           │
GLM / Z.ai monitor API（60s 缓存）
 ├─ /api/monitor/usage/quota/limit ──兼容式解析──→ plan / 5h / mcp（每帧尝试，缓存兜底）
 └─ /api/monitor/usage/model-usage ──→ day / 30d（始终请求）

fields 字段表
 → groupRows        按固定分组归入 3 个类别行（lib/display-fields.js）
 → mergeRows        相邻行宽度之和 ≤ 终端宽度时贪心合并成更少行
 → wrapSegments     仍超宽的行在字段边界内换行（CJK 与 ░▒▓█ 按 2 列计）
 → 输出 1–3 行
```

三个要点贯穿这条链路：

- **跨帧状态全部在缓存文件里**（`~/.claude/glm-statusline-cache.json`）：上下文保持值、速度基线、API 结果都存在这里；因为每帧进程即起即灭，且多个项目的进程会并发写同一个文件，所以写入用原子写（临时文件 + `rename`），一帧只读一次、写一次。
- **各字段的取数细节**见下文[「字段数据来源」](#字段数据来源每项怎么来的)，排版规则见[「布局」](#布局分组多行--自动合并)。
- **任何一步失败都不会搞挂 Claude Code**：`main().catch` 兜底输出一行占位文本，API 失败回退缓存值再回退默认值。

#### 布局（分组多行 + 自动合并）

状态栏统一使用分组多行布局，固定渲染全部字段（没有单行布局，也没有字段选择配置；旧配置文件里残留的 `layout` / `display` 键会被完全忽略）。字段按固定分组归入三行，屏幕上的顺序以分组为准：

- 第 1 行：`model`、`effort`、`speed`
- 第 2 行：`context`、`session`、`day`、`30d`
- 第 3 行：`plan`、`5h`、`mcp`

`speed` 并入第 1 行（与 `model`、`effort` 同行）。

**行自动合并**：相邻两行（甚至三行）的总显示宽度不超过终端宽度（`COLUMNS` 环境变量，默认 80）时，会自动合并成一行——宽终端上可能只显示两行甚至一行。合并以整行为单位、按行序贪心累积，绝不把某一行拆散与别行穿插；某一行自身超过终端宽度时，仍在字段边界自动换行。宽度计算正确处理 CJK 字符和 `░▒▓█` 渐变字符（按 2 列计）。

#### 字段数据来源（每项怎么来的）

状态栏的每个字段来自三种数据源之一：GLM / Z.ai 监控 API、Claude Code 经 stdin 传入的会话 JSON，或本地从 transcript 计算。

**来自 GLM / Z.ai 监控 API**（`ANTHROPIC_BASE_URL` 推导出的 monitor 根地址，`ANTHROPIC_AUTH_TOKEN` 鉴权）：

- `plan`：套餐名，取自 `/api/monitor/usage/quota/limit`。接口没返回时用环境变量 `GLM_STATUSLINE_PLAN` 兜底，仍没有则显示 `GLM`。
- `5h`：5 小时额度使用率与重置时间，从 quota/limit 接口解析。
- `mcp`：MCP/tools 额度使用率与窗口到期日期（`@MM-DD`），从 quota/limit 接口解析。
- `day`、`30d`：当天 / 近 30 天 token 用量，取自 `/api/monitor/usage/model-usage`。两个字段恒显，因此每帧都会尝试请求这个接口；结果按 60 秒（`GLM_STATUSLINE_CACHE_TTL_MS`）缓存，实际请求频率受缓存约束。

  由于 monitor API 没有固定 schema，`5h`/`mcp`/`plan` 靠「兼容式解析」拿到：脚本递归遍历响应、按多种候选字段名匹配，并把每个 limit 对象按关键词归类成 5H / MCP / weekly。接口改字段名时通常只需扩展候选名单。

**来自 Claude Code 会话 JSON**（statusLine 经 stdin 收到的当前会话信息）：

- `context`：`context_window.used_percentage`。会话刚开始或 `/compact` 后该值可能为 `null`，此时沿用该会话上一次的已知值（按 `session_id` 缓存），避免进度条闪成 0%；首次仍无值时显示 `--%`。`context_window_size` 没给时用 `GLM_STATUSLINE_CONTEXT_WINDOW`（默认 `200000`）。
- `model`：按 Claude Code 当前模型名（Opus / Sonnet / Haiku）映射到环境变量 `ANTHROPIC_DEFAULT_OPUS_MODEL` / `ANTHROPIC_DEFAULT_SONNET_MODEL` / `ANTHROPIC_DEFAULT_HAIKU_MODEL`（`mapClaudeModelToGlm`，`lib/model-mapping.js`）。
- `effort`：推理 effort 等级，直接读 `effort.level`（需 Claude Code v2.1.119+）；模型不支持或缺失时显示 `--`。

**本地从 transcript 计算**（不请求任何远端接口）：

- `session`：累加 transcript 文件（会话 JSON 里的 `transcript_path`，JSONL）中每条 `usage` 的 token 数（按 `message.id` 去重——一条助手消息在 transcript 里按内容块拆成多行，每行都带完整 `usage`，不去重会重复计数）。
- `speed`：当前速度 = 输出 token 增量 ÷ API 耗时增量（用 `cost.total_api_duration_ms` 的增量做分母——真实 API 时间，渲染之间的空闲不会被算进去，不会虚高）；平均速度 = 自本会话首 tick 锚定的输出增量 ÷ API 耗时增量（`(out - out0) / ((apiMs - api0)/1000)`）。Claude Code 的 `cost.total_api_duration_ms` 是进程级累加器，`/clear` 不会归零、会把上个会话的 API 时间带进新会话；锚定首 tick 让这部分"外来"时间在分子分母里同时抵消，避免均值被压低（首 tick / 重置后那一帧还没有增量，回退到累计比值，不会裸 `--`）。按 `session_id` 缓存，空闲时保持上次读数；拿不到可用瞬时读数时（例如缓存被并发写坏、基线丢失）回落到会话平均速度，避免卡在 `--`。

### 2. GLM / Z.ai API 用量读取

脚本会根据 Claude Code settings 里的环境变量读取 GLM / Z.ai API：

- `ANTHROPIC_BASE_URL`：用来推导 monitor API 根地址。
- `ANTHROPIC_AUTH_TOKEN`：用于访问 quota 和 usage 接口。
- `/api/monitor/usage/quota/limit`：读取套餐名、5H 额度、MCP/tool 额度、weekly 额度和 API 返回的其他 limit。
- `/api/monitor/usage/model-usage`：读取当天和近 30 天 token 用量。

脚本会合并三层 settings 的 `env`（用户级 `~/.claude/settings.json` → 项目级 `.claude/settings.json` → 项目级 `.claude/settings.local.json`），再与当前进程环境变量合并，确保无论在哪个项目目录下都能获取到配置。

为了避免 Claude Code 状态栏频繁刷新时反复请求接口，插件会把 API 结果缓存到：

```text
~/.claude/glm-statusline-cache.json
```

默认缓存时间是 60 秒，可以通过 `GLM_STATUSLINE_CACHE_TTL_MS` 调整。`day` / `30D` 字段恒显，因此每帧都会尝试请求 model-usage API（受上述 60 秒缓存约束）。

### 3. 详细套餐信息命令

插件提供 `/glm-statusline:plan-details`，用于查看更完整的 GLM Coding Plan 明细。这个命令会运行：

```bash
glm-statusline.js --plan-details
```

输出内容包括：

- 当前套餐名。
- 5H 使用率、已用量、总量和重置时间。
- MCP/tool 使用率、已用量和总量。
- Weekly limit 使用率、已用量、总量和重置时间（如果 API 返回了相关字段）。
- 其他可识别 limit（如 API 返回了新的 limit 类型）。
- Day token 用量。
- 30D token 用量。
- API host、key 是否已配置、缓存新鲜度。

示例输出：

```text
GLM Coding Plan
Plan: GLM Max
5H: 22% · 2M / 10M · resets 18:30
MCP: 28% · 28 / 100 · resets 2026-06-14 18:26
Weekly: 12% · 120K / 1M · resets 2026-06-08 09:00
Day: 42.8M tokens
30D: 979.2M tokens
API: api.z.ai · key configured · cache 12s ago
```

### 4. 安装与卸载 skill

插件内置三个 Claude Code skill：

- `/glm-statusline:install`：启用状态栏。
- `/glm-statusline:uninstall`：移除本插件管理的状态栏配置。
- `/glm-statusline:plan-details`：显示详细套餐和用量信息。

安装脚本会写入 `~/.claude/settings.json` 的 `statusLine` 字段，并在修改前自动备份已有 settings 文件。

卸载时只会移除本插件管理的 status line。如果你已经换成了别的 status line，它不会强行删除用户自己的配置。卸载还会顺带清理旧版本遗留的 `~/.claude/glm-statusline-config.json`（字段选择配置文件，现已不再使用）。

### 5. 稳定 launcher

插件安装后会写入一个稳定入口：

```text
~/.claude/glm-statusline-launcher.js
```

这样做是为了避免 Claude Code 插件更新后，`statusLine.command` 仍然指向旧版本插件缓存路径。之后运行：

```bash
claude plugin update glm-statusline@bingqiangzhou-tools
```

稳定 launcher 会自动寻找最新安装版本的 `bin/glm-statusline.js`（每次渲染现场解析，完整链路见上文[「运行流程」](#运行流程从安装到每一帧)）。

### 6. 本地验证

项目提供了验证脚本：

```bash
npm test
```

验证内容包括：

- `.claude-plugin/plugin.json` 和 `.claude-plugin/marketplace.json` 是否正确。
- package、plugin、marketplace 版本是否一致。
- `bin/`、`skills/`、`docs/` 必要文件是否存在。
- status line 在模拟 Claude Code stdin 下能正常输出。
- 遗留的 display 配置文件被完全忽略（状态栏固定全显）。
- 状态栏会根据终端宽度自动换行与合并。
- `--preview` 可以打印状态栏预览。
- `--plan-details` 能展示 5H、MCP、Weekly、Day、30D 等信息。
- install / uninstall 是否正确写入和移除 settings，uninstall 是否清理遗留配置文件。
- 稳定 launcher 是否能正常工作。

## 安装方法

### 前置条件

- Node.js 18 或更高版本。
- 已安装 Claude Code。
- 有 GLM / Z.ai API Key。

### 1. 添加本地 marketplace

先在仓库目录获取当前路径：

```bash
pwd
```

然后在 Claude Code 中运行，把 `<你的仓库绝对路径>` 替换为上一步输出的路径：

```text
/plugin marketplace add <你的仓库绝对路径>
```

或者直接使用 GitHub 仓库路径（`owner/repo` 格式），跳过本地克隆：

```text
/plugin marketplace add bingqiangzhou/CCStatusline
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
状态栏固定显示全部字段，无需任何配置。

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

### 5. 查看详细用量

```text
/glm-statusline:plan-details
```

### 6. 卸载状态栏

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

| 变量 | 作用 | 默认值 |
| --- | --- | --- |
| `ANTHROPIC_AUTH_TOKEN` | GLM / Z.ai API Key | （无） |
| `ANTHROPIC_BASE_URL` | GLM / Z.ai API 根地址 | （无） |
| `ANTHROPIC_DEFAULT_OPUS_MODEL` | Opus 对应的 GLM 模型 | （无） |
| `ANTHROPIC_DEFAULT_SONNET_MODEL` | Sonnet 对应的 GLM 模型 | （无） |
| `ANTHROPIC_DEFAULT_HAIKU_MODEL` | Haiku 对应的 GLM 模型 | （无） |
| `GLM_STATUSLINE_PLAN` | API 不返回套餐名时的手动兜底 | （无） |
| `GLM_STATUSLINE_CONTEXT_WINDOW` | 手动指定上下文窗口大小 | `200000` |
| `GLM_STATUSLINE_CACHE_TTL_MS` | API 缓存时间（毫秒） | `60000` |
| `GLM_STATUSLINE_CACHE_FILE` | 自定义缓存文件位置，常用于测试隔离 | `~/.claude/glm-statusline-cache.json` |
| `GLM_STATUSLINE_TIMEOUT_MS` | API 请求超时时间（毫秒） | `2200` |
| `GLM_STATUSLINE_DEBUG` | 设置为 `1` 时向 stderr 输出调试错误信息 | （无） |

## 开发过程记录

这次开发大致经历了几个阶段：

1. 先研究 Claude Code 的扩展方式，确认 status line 本身由用户 settings 里的 `statusLine.command` 控制。
2. 再把原始 `glm-statusline.js` 保持为单文件脚本，减少拆分成本，让它继续负责 API 请求、缓存、token 统计和状态栏渲染。
3. 然后新增插件包装层：`.claude-plugin/plugin.json`、`.claude-plugin/marketplace.json`、`bin/` launcher 和 `skills/`。
4. 接着实现 `/glm-statusline:install` 和 `/glm-statusline:uninstall`，用安装脚本显式写入或移除 `~/.claude/settings.json`。
5. 后来补上稳定 launcher，解决插件更新后 status line 命令可能指向旧缓存版本的问题。
6. 再补充 `/glm-statusline:configure`（含交互式选择）和 `--preview`，让用户可以选择字段并看到预览。
7. 补充 `--plan-details`，展示 5H、MCP、Weekly、Day/30D 和 API/cache 状态。
8. 增加终端宽度自适应换行，根据 `COLUMNS` 环境变量在字段边界自动换行，并正确处理 CJK 和块字符的显示宽度。
9. 最后补充验证脚本、CHANGELOG 和开发文档。

这中间最值得注意的取舍是：插件可以被安装，但 Claude Code 的主状态栏仍然属于用户界面配置。直接让插件静默覆盖用户 status line 不太合适，所以本项目采用“先安装插件，再由用户运行 install skill 显式启用”的方式。

更详细的开发过程和技术分析见文末附录的 **[Claude Code 插件系统学习笔记](#claude-code-插件系统学习笔记)** 系列（共 11 篇）。

技术文档：

- [Claude Code 插件构建过程与 GLM StatusLine 分析](docs/claude-code-plugin-build-guide.md)
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

- Node.js 标准库：`fs`、`path`、`os`、`http`、`https`、`url`、`child_process`、`assert`。
- Claude Code `statusLine`：通过 stdin 接收当前会话 JSON（包含 `model`、`context_window`、`effort`、`transcript_path`、`workspace` 等字段），通过 stdout 输出状态栏文本。其中 `effort.level` 需要 Claude Code v2.1.119+，`context_window.used_percentage` 在会话开始或 `/compact` 后可能为 `null`（此时状态栏会沿用该会话上一次的已知值，避免闪成 0%）。
- Claude Code plugin：用 `.claude-plugin/plugin.json` 描述插件元信息。
- Claude Code local marketplace：用 `.claude-plugin/marketplace.json` 让本地目录可以被 `/plugin marketplace add` 添加。
- Claude Code skill：用 `skills/<name>/SKILL.md` 暴露 `/glm-statusline:*` 命令。
- GLM / Z.ai monitor API：`/api/monitor/usage/quota/limit` 读取额度，`/api/monitor/usage/model-usage` 读取 token 用量。

## 项目文件结构

```text
CCStatusline/
├── .claude-plugin/
│   ├── plugin.json                  # 插件清单
│   └── marketplace.json             # 本地 marketplace 清单
├── bin/
│   ├── glm-statusline.js            # 状态栏核心编排脚本（入口即实现，引用 ../lib/）
│   └── glm-statusline-install.js    # 安装/卸载 CLI
├── docs/
│   ├── claude-code-plugin-build-guide.md      # 插件构建过程文档
│   └── claude-code-skills-and-extensions-guide.md  # Skill 与扩展能力文档
├── lib/
│   ├── display-fields.js            # 状态栏字段定义与分组行切分
│   ├── file-io.js                   # 共享文件读写：JSON 读取/写入（原子写）、transcript JSONL 遍历去重、遗留配置路径解析、调试日志
│   ├── model-mapping.js             # Claude 模型名 → GLM 模型名映射 + effort 档位读取
│   ├── monitor-api.js               # 监控 API 客户端：配额/用量抓取（60s 缓存 + 多级回退）
│   ├── quota-parsing.js             # 兼容式解析（纯函数）：quota/limit 与 model-usage 响应归一
│   ├── session-metrics.js           # 会话指标：上下文防闪烁保持 + 输出速度解析（增量/锚定）
│   ├── status-cache.js              # 共享缓存层：原子写、TTL 判断、per-session 条目清理
│   ├── statusline-format.js         # 进度条、token、时间、速度和自动换行格式化
│   └── transcript-stats.js          # transcript JSONL 统计：token/输出提取 + 会话/速度读取器
├── notes/                           # Claude Code 插件系统学习笔记
│   ├── 01-插件系统概览.md
│   ├── 02-Skill.md
│   ├── 03-Agents.md
│   ├── 04-Hooks.md
│   ├── 05-MCP.md
│   ├── 06-LSP.md
│   ├── 07-Output-Styles.md
│   ├── 08-Themes.md
│   ├── 09-Monitors.md
│   ├── 10-Bin.md
│   ├── 11-实践案例-GLM-StatusLine.md
│   └── archive/                     # 早期笔记归档
│       ├── old-第一篇-单文件状态栏笔记.md
│       └── old-第二篇-如何写一个Claude-Code插件.md
├── skills/
│   ├── install/SKILL.md             # /glm-statusline:install
│   ├── plan-details/SKILL.md        # /glm-statusline:plan-details
│   └── uninstall/SKILL.md           # /glm-statusline:uninstall
├── test/
│   ├── test.js                      # 验证脚本（npm test）
│   └── fixtures/                    # GLM / Z.ai monitor API 样例响应
├── package.json
├── CHANGELOG.md                      # 更新日志（中文）
└── README.md
```

## 后续可以继续写或做的事

- 增加 README 截图，展示状态栏和 `/glm-statusline:plan-details` 的实际效果。
- 增加 `/glm-statusline:diagnose`，自动检查 API key、base URL、settings、缓存文件和 status line command。
- 把插件发布到更正式的 marketplace，而不只是本地路径安装。
- 给 quota API 返回结构补更多样例测试，避免接口字段变化后解析失效。
- 给 README 增加常见问题，比如状态栏不刷新、显示 0%、API key 缺失、旧版本 launcher 残留等。

---

## 附录：学习笔记与延伸阅读

本仓库同时也是一份 Claude Code 插件系统的学习资料——先通过笔记系统梳理概念与能力边界，再以 GLM StatusLine 作为案例把理解转化为可运行代码。

### 关于学习技术和使用 AI 的一些想法

学习一个工具或技术，核心是理解它的**概念、适用场景和边界**——知道它是什么、能做什么、什么时候该用它。不需要逐行读懂它的源码实现，只要对原理有大致的把握就够了。

把这种思路代入到 AI 工具上：**AI 给出好结果的前提是你能给出清晰的指令。** 而写出清晰指令的能力，恰恰来自你对相关概念的理解——你知道有哪些选项、每个选项意味着什么、哪个选项最适合当前的情况。形成了一个循环：

```text
学习概念和原理
  → 知道该用什么、怎么描述需求
    → 给 AI 明确的指令
      → AI 产出高质量的结果
```

在这个循环中，AI 本身也可以加速学习过程——你可以在和 AI 的对话中快速了解一个领域的概念体系、澄清模糊的理解、验证自己的想法。**用 AI 学习技术和工具，确定要做什么、用什么合适；再用 AI 把具体的事情实现出来。**

本仓库就是这个思路的一个实践：先通过学习笔记系统梳理 Claude Code 插件的概念和能力边界，再以 GLM StatusLine 作为案例把理解转化为可运行的代码。

### Claude Code 插件系统学习笔记

以下 11 篇笔记系统覆盖了 Claude Code 插件的全部能力，每篇都包含配置示例和参考资料：

| 篇号 | 主题 | 内容概要 | 文件 |
| --- | --- | --- | --- |
| 1 | 插件系统概览 | 最小插件、目录映射、plugin.json、marketplace.json、生命周期 | [01-插件系统概览.md](notes/01-插件系统概览.md) |
| 2 | Skill | SKILL.md 写法、frontmatter、参数系统、动态命令注入 | [02-Skill.md](notes/02-Skill.md) |
| 3 | Agents | 自定义 subagent、工具控制、模型选择、isolation | [03-Agents.md](notes/03-Agents.md) |
| 4 | Hooks | 生命周期事件（20+）、hook 类型、matcher、拦截与注入 | [04-Hooks.md](notes/04-Hooks.md) |
| 5 | MCP | 传输类型（stdio/http/sse/ws）、配置、插件 MCP | [05-MCP.md](notes/05-MCP.md) |
| 6 | LSP | 语言服务器集成、代码智能、诊断、导航 | [06-LSP.md](notes/06-LSP.md) |
| 7 | Output Styles | 回答风格定义、内置风格、force-for-plugin | [07-Output-Styles.md](notes/07-Output-Styles.md) |
| 8 | Themes | 终端颜色主题、颜色 token、插件主题加载 | [08-Themes.md](notes/08-Themes.md) |
| 9 | Monitors | 后台监听进程、输出传递、触发条件 | [09-Monitors.md](notes/09-Monitors.md) |
| 10 | Bin | 可执行脚本、PATH 注入、薄入口模式 | [10-Bin.md](notes/10-Bin.md) |
| 11 | 实践案例 | GLM StatusLine 完整案例：需求→选型→设计→实现 | [11-实践案例-GLM-StatusLine.md](notes/11-实践案例-GLM-StatusLine.md) |

早期笔记（归档于 `notes/archive/`）：

- [第一篇（归档）：Claude Code 底部显示 GLM Coding Plan 用量](notes/archive/old-第一篇-单文件状态栏笔记.md)
- [第二篇（归档）：如何写一个 Claude Code 插件](notes/archive/old-第二篇-如何写一个Claude-Code插件.md)
