# Claude Code Skill 写法与扩展能力地图

## 资料来源

本篇基于 Claude Code 官方文档整理，重点参考：

- [Extend Claude with skills](https://code.claude.com/docs/en/skills.md)
- [Extend Claude Code](https://code.claude.com/docs/en/features-overview.md)
- [Commands](https://code.claude.com/docs/en/commands.md)
- [Create custom subagents](https://code.claude.com/docs/en/sub-agents.md)
- [Hooks reference](https://code.claude.com/docs/en/hooks.md)
- [Connect Claude Code to tools via MCP](https://code.claude.com/docs/en/mcp.md)
- [How Claude remembers your project](https://code.claude.com/docs/en/memory.md)
- [Output styles](https://code.claude.com/docs/en/output-styles.md)
- [Plugins reference](https://code.claude.com/docs/en/plugins-reference.md)
- [Dynamic workflows](https://code.claude.com/docs/en/workflows.md)

## Skill 的基本结构

Claude Code Skill 是一个可复用的 Markdown 指令包。它可以作为 `/skill-name` 命令手动调用，也可以由 Claude 根据 `description` 自动加载。

推荐目录结构：

```text
my-skill/
├── SKILL.md
├── reference.md
├── examples.md
└── scripts/
    └── helper.sh
```

最小结构只有一个 `SKILL.md`：

```markdown
---
description: Summarizes uncommitted changes and flags risky edits. Use when the user asks what changed or wants a commit summary.
---

## Current changes

!`git diff HEAD`

## Instructions

Summarize the changes in two or three bullets, then list risks and missing tests.
```

关键点：

- 目录名决定命令名：`.claude/skills/deploy/SKILL.md` 对应 `/deploy`。
- 插件里的 skill 会带命名空间：`plugins/foo/skills/install/SKILL.md` 对应 `/foo:install`。
- `description` 很重要。Claude 根据它判断何时自动使用这个 skill。
- `SKILL.md` 内容只在 skill 被调用或自动匹配时加载；比把长流程写进 `CLAUDE.md` 更节省上下文。
- 支持文件要在 `SKILL.md` 里说明用途，否则 Claude 不一定知道何时读取。

## SKILL.md 写法

`SKILL.md` 分为两部分：YAML frontmatter 和 Markdown 指令正文。

常用 frontmatter：

```yaml
---
name: deploy
description: Deploy the application to production. Use only when the user explicitly asks to deploy.
argument-hint: "[environment]"
arguments:
  - environment
disable-model-invocation: true
allowed-tools:
  - Bash(npm test)
  - Bash(npm run build)
  - Bash(git status)
context: fork
agent: general-purpose
---
```

字段说明：

- `name`：显示名称；通常不改变命令名，命令名主要来自目录名。插件根目录单文件 `SKILL.md` 是例外。
- `description`：推荐必写。写清“做什么”和“什么时候用”，把关键词放前面。
- `when_to_use`：补充触发场景，会和 description 一起用于自动匹配。
- `argument-hint`：在 `/` 自动补全中提示参数格式。
- `arguments`：给位置参数命名，正文中可用 `$environment`。
- `disable-model-invocation: true`：Claude 不会自动触发，只能用户手动 `/name` 调用。适合部署、提交、发消息、修改设置等有副作用流程。
- `user-invocable: false`：用户菜单隐藏，只让 Claude 在相关场景自动加载。适合背景知识类 skill。
- `allowed-tools`：skill 激活时预批准指定工具；不是工具白名单，未列出的工具仍按全局权限规则处理。
- `disallowed-tools`：skill 激活时移除某些工具。
- `model`、`effort`：为当前 turn 指定模型或推理强度。
- `context: fork`：在隔离 subagent 上运行这个 skill，适合大量检索、审查、研究。
- `agent`：配合 `context: fork` 指定使用哪个 subagent，例如 `Explore`、`Plan`、`general-purpose` 或自定义 agent。
- `hooks`：定义只在这个 skill 生命周期内生效的 hook。
- `paths`：限制自动激活范围，例如只在 `src/api/**/*.ts` 相关文件上触发。
- `shell`：为动态命令注入选择 `bash` 或 `powershell`。

## 参数与动态上下文

Skill 支持字符串替换：

- `$ARGUMENTS`：用户在 skill 名称后的完整参数。
- `$ARGUMENTS[0]` 或 `$0`：第一个参数。
- `$name`：使用 `arguments` 声明的位置参数名。
- `${CLAUDE_SESSION_ID}`：当前会话 ID。
- `${CLAUDE_EFFORT}`：当前 effort。
- `${CLAUDE_SKILL_DIR}`：当前 skill 目录，适合引用 skill 附带脚本。

动态命令注入使用 `` !`command` ``。Claude Code 会先执行命令，再把输出替换进 skill 内容。例如：

```markdown
## Git status

!`git status --short`

## Diff

!`git diff HEAD`
```

适合把“当前状态”注入 prompt，比如 git diff、PR 信息、测试摘要、配置快照。不要用它执行危险动作；有副作用的操作应该写在正文步骤里，让 Claude 明确执行。

## Skill 类型选择

可以把 skill 分成三类：

| 类型 | 特点 | 推荐配置 | 例子 |
| --- | --- | --- | --- |
| 背景知识 | Claude 需要偶尔参考，不一定由用户手动调用 | 默认允许自动触发，或 `user-invocable: false` | API 规范、数据库 schema、代码风格 |
| 手动工作流 | 用户明确发起，可能有副作用 | `disable-model-invocation: true` | `/deploy`、`/commit`、`/release` |
| 隔离任务 | 会读很多文件或产生大量中间输出 | `context: fork` | 深度审查、研究、迁移计划 |

写 skill 时建议：

- 让 `description` 像触发规则，不要只写标题。
- 正文写“要做什么”和“输出什么”，少写背景故事。
- 把长 API 文档、示例、模板放在旁边的 reference 文件，正文只说明何时读取。
- 对有副作用的 skill 加 `disable-model-invocation: true`。
- 对重复、易错、确定性的动作提供 `scripts/`，让 Claude 执行脚本，而不是每次重写命令。
- 对必须强制执行的规则，不要只写 skill；用 hook 才能保证触发。

## 存放位置与优先级

Skill 可以放在不同位置：

| 位置 | 路径 | 范围 |
| --- | --- | --- |
| 个人 | `~/.claude/skills/<name>/SKILL.md` | 所有项目 |
| 项目 | `.claude/skills/<name>/SKILL.md` | 当前项目 |
| 插件 | `<plugin>/skills/<name>/SKILL.md` | 插件启用处 |
| 旧 commands | `.claude/commands/<name>.md` | 与 skill 类似，但不如 skill 支持文件方便 |

同名 skill 的优先级是 enterprise > personal > project。插件 skill 有命名空间，所以不会和普通 skill 冲突。

Claude Code 会监听已存在的 skill 目录，`SKILL.md` 修改可在当前 session 生效。插件内的 hooks、MCP、agents、output styles 等组件修改后通常需要 `/reload-plugins` 或重启。

## Claude Code 还能扩展什么

除了 status line，Claude Code 的扩展面很大，可以按“上下文、工具、自动化、并行、包装分发、界面行为”来理解。

### 1. CLAUDE.md 与 rules

用途：给每个 session 都需要知道的项目规则、构建命令、代码约定。

可开发内容：

- 项目级 `CLAUDE.md`
- 用户级 `~/.claude/CLAUDE.md`
- `.claude/rules/*.md`
- 带 `paths` frontmatter 的路径规则

适合放“永远适用”的规则。多步骤流程和长参考资料更适合 skill。

### 2. Skills 与自定义命令

用途：复用知识、流程和指令。用户可以 `/name` 调用，Claude 也可以自动加载。

可开发内容：

- 项目 skill
- 个人 skill
- 插件 skill
- 旧式 `.claude/commands/*.md`
- 带 supporting files 的复杂 skill
- 带 `context: fork` 的隔离 skill

本项目已经有 `/glm-statusline:install`、`/glm-statusline:configure`、`/glm-statusline:uninstall` 和 `/glm-statusline:plan-details` 四个插件 skill，可以继续扩展出 `/glm-statusline:diagnose`。

### 3. Subagents

用途：创建专门 agent，在隔离上下文中处理任务，最后只把摘要返回主会话。

可开发内容：

- `.claude/agents/*.md` 项目 subagent
- `~/.claude/agents/*.md` 个人 subagent
- 插件 `agents/` 目录里的 subagent
- 限制工具、模型、effort、maxTurns
- 给 subagent 预加载 skills
- 使用 `isolation: worktree` 做隔离实现

适合代码审查、安全扫描、性能分析、大规模检索、迁移规划等会污染主上下文的任务。

### 4. Hooks

用途：在 Claude Code 生命周期事件上自动执行命令、HTTP 请求、MCP 工具、prompt 或 agent。

可开发内容：

- `SessionStart` 初始化
- `UserPromptSubmit` 预处理用户输入
- `PreToolUse` 阻止危险命令
- `PostToolUse` 在写文件后运行 formatter/linter
- `Stop` 发送通知或保存摘要
- `PreCompact` / `PostCompact` 记录压缩前后信息
- 插件内 `hooks/hooks.json`
- skill/agent frontmatter 内局部 hook

如果某个规则必须强制执行，比如“禁止改 `.env`”或“写 TS 后必须跑 formatter”，hook 比 skill 或 CLAUDE.md 更合适。

### 5. MCP 服务器

用途：把外部系统变成 Claude Code 可调用工具。

可开发内容：

- 本地 stdio MCP server
- 远程 HTTP MCP server
- WebSocket server
- OAuth 认证 server
- 数据库、GitHub、JIRA、Slack、Figma、监控系统连接器
- 插件内 `.mcp.json` 或 `plugin.json` 内联 MCP 配置
- MCP prompts，暴露为 `/mcp__server__prompt`
- MCP channels，把外部事件推送进 Claude Code session

适合解决“我总要把外部系统信息复制进 Claude”的问题。

### 6. LSP / Code Intelligence

用途：接入语言服务器，让 Claude 能看到诊断、跳转定义、查找引用、类型信息。

可开发内容：

- 插件 `.lsp.json`
- `plugin.json` 内联 `lspServers`
- 自定义语言的 LSP 插件
- 给已有语言服务器写 Claude Code 包装

注意：LSP 插件通常只配置连接方式，不自带语言服务器二进制。用户仍需要安装 `pyright`、`typescript-language-server`、`rust-analyzer` 等。

### 7. Output styles 与 themes

用途：改变 Claude 的默认回答角色、语气、格式或终端视觉主题。

可开发内容：

- `~/.claude/output-styles/*.md`
- `.claude/output-styles/*.md`
- 插件 `output-styles/`
- 插件 `themes/`

Output style 改的是系统提示风格，不是项目知识。比如“所有解释先画 Mermaid 图”、“以教学模式回答”、“作为数据分析助手回答”。

### 8. Plugins 与 marketplace

用途：把 skills、agents、hooks、MCP、LSP、monitors、output styles、themes、bin 工具打包成可安装单元。

可开发内容：

- `.claude-plugin/plugin.json`
- `.claude-plugin/marketplace.json`
- `skills/`
- `agents/`
- `hooks/hooks.json`
- `.mcp.json`
- `.lsp.json`
- `monitors/monitors.json`
- `output-styles/`
- `themes/`
- `bin/`
- `userConfig`
- plugin dependencies

本项目就是这种形态：用插件包装 status line，并提供安装、配置、详情、卸载 skill 和 bin 脚本。

### 9. Monitors

用途：插件启用后启动后台命令，把 stdout 每一行作为通知推给 Claude。

可开发内容：

- 监听本地日志
- 轮询部署状态
- 监听 CI 状态
- 监听服务健康检查
- `when: always`
- `when: on-skill-invoke:<skill-name>`

Monitors 适合“Claude 应该被动知道外部状态变化”的场景。它和 hooks 一样要谨慎，因为运行在本地且有安全影响。

### 10. Dynamic workflows

用途：让 Claude 写一个 JavaScript 编排脚本，批量调度大量 subagents，在后台执行复杂流程。

可开发内容：

- 保存到 `.claude/workflows/` 的项目 workflow
- 保存到 `~/.claude/workflows/` 的个人 workflow
- 审计型 workflow
- 大规模迁移 workflow
- 多 agent 交叉验证 workflow

适合几十到上百个 agent 的大任务；如果只是单个可复用流程，先写 skill。

### 11. Agent teams 与 background agents

用途：管理多个 Claude Code session，让多个 agent 并行工作、沟通或后台运行。

可开发内容：

- 用 subagent 定义作为 teammate 类型
- 团队式代码审查
- 多假设 debugging
- 并行调研
- 后台 session 管理流程

这类能力比普通 subagent 成本更高，适合复杂任务。

### 12. Settings、权限与安全策略

用途：控制 Claude Code 的默认配置、权限、插件启用、技能可见性和组织策略。

可开发内容：

- `.claude/settings.json`
- `.claude/settings.local.json`
- `~/.claude/settings.json`
- `skillOverrides`
- `permissions.allow` / `permissions.deny`
- managed settings
- `enabledPlugins`
- plugin `userConfig`

如果扩展会运行命令、访问外部系统或写 settings，应该同时设计卸载、备份和权限边界。

## 给本项目的后续扩展想法

围绕 GLM StatusLine，可以继续做这些扩展：

1. `/glm-statusline:diagnose`
   - 检查 Node 版本、插件安装位置、`~/.claude/settings.json`、GLM env、API 连通性、缓存文件。
   - 输出可复制的诊断报告。

2. 增强 `/glm-statusline:configure`
   - 当前已经支持选择 status line 显示字段并打印预览。
   - 后续可以继续扩展为交互式生成 GLM/Z.ai `env` 配置。
   - 支持国内 `open.bigmodel.cn` 和国际 `api.z.ai`。

3. 更独立的 `/glm-statusline:preview`
   - 当前 `glm-statusline.js --preview` 已经能打印选择后的状态栏效果。
   - 后续可以单独包装成 skill，用模拟 stdin 或当前 session 数据预览状态栏输出。
   - 适合用户修改显示字段、`BAR_WIDTH`、`CONTEXT_WINDOW` 后确认效果。

4. Hook 自动诊断
   - 在 `ConfigChange` 或 `SessionStart` 时检查 status line 配置是否仍指向有效脚本。
   - 只提示，不自动覆盖用户设置。

5. MCP GLM usage server
   - 把 quota、model usage、account plan 做成 MCP 工具。
   - StatusLine 仍负责显示，MCP 负责让 Claude 在会话里查询和解释用量。

6. Subagent 审计
   - 提供 `glm-statusline-auditor` agent，专门检查 API 返回结构变化、token 统计误差、跨平台路径问题。

7. Output style
   - 提供一个 GLM provider troubleshooting 风格，让 Claude 回答 GLM/Z.ai 配置问题时按“环境、认证、模型映射、网络、日志”顺序排查。

## 选型速查

| 需求 | 首选扩展 |
| --- | --- |
| 每次会话都要知道的项目约定 | `CLAUDE.md` 或 `.claude/rules/` |
| 重复 prompt、流程、参考资料 | Skill |
| 用户手动触发的有副作用流程 | Skill + `disable-model-invocation: true` |
| 必须每次自动执行或阻止 | Hook |
| 连接外部服务/API/数据库 | MCP |
| 读很多文件但不污染主上下文 | Subagent |
| 大规模并行审计/迁移 | Dynamic workflow |
| 分享给团队或跨项目复用 | Plugin + marketplace |
| 改变回答风格和格式 | Output style |
| 提升代码导航和诊断 | LSP/code intelligence plugin |
| 让 Claude 被动接收外部状态 | Monitor 或 MCP channel |

## 实践建议

从轻到重添加扩展：

1. 先用 `CLAUDE.md` 记录总是适用的规则。
2. 重复两三次的流程改成 skill。
3. 需要强制执行的规则改成 hook。
4. 需要外部系统数据时接 MCP。
5. 需要上下文隔离时加 subagent。
6. 多仓库复用时打包成 plugin。
7. 大规模并行工作再考虑 workflow 或 agent team。

这套顺序能避免一开始就把项目做成“全家桶”，也能让每个扩展点承担它最适合的职责。
