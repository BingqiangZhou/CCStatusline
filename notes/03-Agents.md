# Claude Code Agents 详解

> 学习笔记系列 · 第三篇
>
> 本篇深入讲解 Claude Code Agents：自定义 subagent 的定义方式、frontmatter 字段、内置 subagent 类型、安全限制和最佳实践。

## 目录

- [1. Agent 是什么](#1-agent-是什么)
- [2. Agent 文件格式](#2-agent-文件格式)
- [3. Frontmatter 详解](#3-frontmatter-详解)
- [4. 内置 Subagent 类型](#4-内置-subagent-类型)
- [5. Fork 模式与命名 Subagent](#5-fork-模式与命名-subagent)
- [6. 插件中的 Agent 安全限制](#6-插件中的-agent-安全限制)
- [7. 存放位置与作用域](#7-存放位置与作用域)
- [8. 最佳实践](#8-最佳实践)
- [9. 本项目实例](#9-本项目实例)

---

## 1. Agent 是什么

Claude Code Agent 是一个**自定义 subagent 定义**。它告诉 Claude Code "当需要执行某类任务时，启动一个隔离的 agent，给它指定的工具、模型和上下文"。

Agent 的核心价值：

- **隔离执行**：subagent 有自己的对话上下文，不会污染主会话
- **工具控制**：可以精确控制 subagent 能使用哪些工具
- **模型选择**：不同任务可以用不同模型（如用 Haiku 做快速分类，Opus 做深度分析）
- **并发能力**：多个 subagent 可以并行工作

```text
主会话
  ├── 用户请求：审查所有文件
  ├── Claude 识别：这是审查任务
  ├── 启动 subagent（agents/reviewer.md）
  │     ├── 只读工具：Read、Grep、Glob
  │     ├── 模型：sonnet
  │     └── 独立上下文，不影响主会话
  └── 收集 subagent 结果，汇报给用户
```

## 2. Agent 文件格式

Agent 定义是一个 Markdown 文件，放在 `agents/` 目录下，使用 YAML frontmatter + Markdown 正文。

### 最小示例

```markdown
---
name: reviewer
description: Review code changes for quality and security issues.
---

## Task

Review the code changes provided. Focus on:

1. Security vulnerabilities
2. Performance issues
3. Code style consistency

Report findings as a structured list.
```

### 带完整 frontmatter 的示例

```markdown
---
name: security-auditor
description: Deep security audit of code changes, checking for OWASP Top 10 and common vulnerabilities.
tools:
  - Read
  - Grep
  - Glob
  - WebSearch
model: sonnet
maxTurns: 30
effort: high
---

## Security Audit

Perform a comprehensive security audit covering:

### OWASP Top 10 Check
- Injection vulnerabilities
- Broken authentication patterns
- Sensitive data exposure
- XML External Entities (XXE)
- Broken access control

### Report Format
For each finding:
- Severity: Critical / High / Medium / Low
- Location: file:line
- Description
- Recommendation
```

## 3. Frontmatter 详解

| 字段 | 类型 | 必需 | 说明 |
| --- | --- | --- | --- |
| `name` | string | 推荐 | Agent 的标识名。如果省略，用文件名（去掉 `.md`）。 |
| `description` | string | 推荐 | 详细描述 agent 的能力和适用场景。Claude 用它判断何时使用。 |
| `tools` | array/string | 否 | Agent 可以使用的工具列表。不设置则继承主会话可用工具。 |
| `disallowedTools` | array/string | 否 | 从继承或指定工具集中移除某些工具。 |
| `model` | string | 否 | 指定模型。常用值是 `sonnet`、`opus`、`haiku`、完整模型 ID 或 `inherit`。默认 `inherit`。 |
| `permissionMode` | string | 否 | 权限模式，如 `default`、`auto`、`plan` 等。插件内 agent 会忽略此字段。 |
| `maxTurns` | number | 否 | 最大执行轮次，防止无限循环。 |
| `skills` | array | 否 | Agent 启动时预加载的 skill 列表。 |
| `mcpServers` | array/object | 否 | 给非插件 agent 指定额外 MCP server。插件内 agent 会忽略此字段。 |
| `hooks` | object | 否 | 只在该 agent 生命周期内生效的 hook。插件内 agent 会忽略此字段。 |
| `isolation` | string | 否 | `worktree` = 在独立 git worktree 中运行，适合会修改文件的操作。 |
| `background` | boolean | 否 | `true` = 后台运行，不阻塞主会话。 |
| `effort` | string | 否 | 推理强度：`low`、`medium`、`high`、`xhigh`、`max`（可用值取决于模型）。 |
| `color` | string | 否 | 在团队/工作流 UI 中的显示颜色。 |

### tools 字段详解

`tools` 控制这个 subagent 可以使用哪些工具。常见的工具名：

| 工具 | 用途 |
| --- | --- |
| `Read` | 读取文件 |
| `Edit` | 编辑文件（部分修改） |
| `Write` | 写入文件（全量替换） |
| `Bash` | 执行 shell 命令 |
| `Grep` | 搜索文件内容 |
| `Glob` | 按模式匹配文件名 |
| `WebSearch` | 搜索网页 |
| `Agent` | 嵌套启动子 agent |
| `TaskCreate` / `TaskUpdate` / `TaskList` | 任务管理 |
| `mcp__server__tool` | MCP 工具（格式：`mcp__服务器名__工具名`） |

### model 字段说明

```yaml
# 用 Sonnet 做平衡任务
model: sonnet

# 用 Haiku 做快速分类
model: haiku

# 用 Opus 做深度分析
model: opus
```

也可以填写完整模型 ID；是否可用以当前 Claude Code `/model` 支持列表为准。

### isolation 字段说明

```yaml
# 在独立 worktree 中运行，文件修改不影响主工作目录
isolation: worktree
```

适合场景：
- 批量修改文件（如代码迁移）
- 可能失败的实验性修改
- 需要并行修改多个文件的场景

## 4. 内置 Subagent 类型

Claude Code 提供了几个内置 subagent 类型，可以在 skill 的 `context: fork` + `agent:` 字段中引用，也可以在自定义 agent 中使用：

| 类型 | 特点 | 可用工具 |
| --- | --- | --- |
| `Explore` | 只读搜索 agent，适合广泛搜索 | 全部只读工具，不能 Edit/Write |
| `Plan` | 架构设计 agent，只读探索和规划 | 全部只读工具，不能 Edit/Write |
| `general-purpose` | 全能 agent，默认类型 | 全部工具 |

### Explore Agent

适合"先大量阅读再汇报结论"的场景：

```text
任务：找到所有使用 deprecated API 的文件
  ├── Explore agent 启动
  │     ├── 只能读，不能改
  │     ├── 使用 Glob/Grep/Read 广泛搜索
  │     └── 汇总搜索结论
  └── 主会话拿到结论，决定如何修改
```

### Plan Agent

适合"设计实现方案"的场景：

```text
任务：设计用户认证模块
  ├── Plan agent 启动
  │     ├── 阅读现有代码结构
  │     ├── 分析依赖关系
  │     └── 输出分步实现计划
  └── 主会话按计划执行
```

## 5. Fork 模式与命名 Subagent

### Fork 模式（通过 Skill）

Skill 的 `context: fork` 会启动一个 subagent：

```yaml
# skills/review/SKILL.md
---
description: Deep code review
context: fork
agent: general-purpose
---

Perform a thorough code review of the current changes.
```

Fork 模式的特点：
- 在独立上下文中运行
- 不消耗主会话的上下文窗口
- 完成后结果返回给主会话

### 命名 Subagent（通过 Agent 文件）

```text
agents/
├── reviewer.md      → Claude 可自动调用
├── security.md      → Claude 可自动调用
└── migrator.md      → Claude 可自动调用
```

Claude 会根据 agent 文件的 `description` 判断何时启动对应的 subagent。

## 6. 插件中的 Agent 安全限制

插件中的 subagent 有额外的安全限制：

1. **工具限制**：插件 subagent 不能使用比主会话更多权限的工具。
2. **不支持部分 frontmatter**：插件内 agent 会忽略 `hooks`、`mcpServers`、`permissionMode`。如果需要这些字段，应把 agent 放到项目或个人 `.claude/agents/` 中。
3. **嵌套限制**：subagent 不能继续启动 subagent。
4. **后台权限限制**：后台 subagent 无法弹出交互式权限请求；需要额外权限时应以前台方式重试。

这些限制确保插件 subagent 不会越权操作。

## 7. 存放位置与作用域

| 位置 | 路径 | 范围 |
| --- | --- | --- |
| 个人 | `~/.claude/agents/<name>.md` | 所有项目 |
| 项目 | `.claude/agents/<name>.md` | 当前项目 |
| 插件 | `<plugin>/agents/<name>.md` | 插件启用处 |

### plugin.json 中的路径配置

可以在 `plugin.json` 中自定义 agents 目录：

```json
{
  "name": "my-plugin",
  "agents": ["./custom/agents/reviewer.md"]
}
```

## 8. 最佳实践

### 8.1 只读 Agent 用 Explore 类型

```yaml
# 好：只读任务用 Explore
---
name: doc-searcher
description: Search documentation for relevant information.
tools:
  - Read
  - Grep
  - Glob
---

# 不好：只读任务给了全部工具
---
name: doc-searcher
description: Search documentation.
---
```

### 8.2 description 要写清适用场景

```yaml
# 好
description: Deep security audit of code changes, checking for OWASP Top 10 and common vulnerabilities. Use when reviewing code for security issues.

# 不好
description: Security audit.
```

### 8.3 设定 maxTurns 防止无限循环

```yaml
---
name: researcher
description: Research a topic thoroughly.
maxTurns: 20
---
```

### 8.4 会修改文件的 Agent 考虑 isolation

```yaml
---
name: migrator
description: Migrate code from v1 API to v2 API.
isolation: worktree
tools:
  - Read
  - Edit
  - Write
  - Grep
  - Glob
---
```

### 8.5 正文写清楚输出格式

```markdown
---
name: reviewer
description: Review code quality.
tools:
  - Read
  - Grep
  - Glob
---

## Review the code

For each finding, output:
- **Severity**: Critical / High / Medium / Low
- **File**: path/to/file:line
- **Issue**: one-line description
- **Fix**: recommended fix

If no issues found, output: "No issues found."
```

## 9. 本项目实例

GLM StatusLine 插件目前**没有自定义 agent**。这是因为插件的核心功能（状态栏渲染、安装配置）都是确定性的脚本操作，不需要 subagent 的隔离执行能力。

如果将来需要扩展，可以考虑添加：

```text
agents/
└── api-diagnostic.md    → 诊断 GLM/Z.ai API 连接问题的 agent
                         → 只读工具 + WebSearch
                         → 检查 API key、URL、缓存状态
```

## 参考资料

- [Claude Code 官方文档 - Plugins reference](https://code.claude.com/docs/en/plugins-reference.md)
- [Claude Code 官方文档 - Extend Claude with skills](https://code.claude.com/docs/en/skills.md)
- [Claude Code 官方文档 - Hooks reference](https://code.claude.com/docs/en/hooks.md)
- [Claude Code GitHub - plugin-dev agents](https://github.com/anthropics/claude-code/tree/main/plugins/plugin-dev)

## 系列导航

| ← 上一篇 | 下一篇 → |
| --- | --- |
| [第二篇：Skill](02-Skill.md) | [第四篇：Hooks](04-Hooks.md) |
