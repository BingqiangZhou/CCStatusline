# Claude Code Hooks 详解

> 学习笔记系列 · 第四篇
>
> 本篇深入讲解 Claude Code Hooks：生命周期事件、hooks.json 配置、hook 类型（command/http/prompt/agent）、输入输出格式和实战模式。

## 目录

- [1. Hook 是什么](#1-hook-是什么)
- [2. 生命周期事件全景](#2-生命周期事件全景)
- [3. hooks.json 配置格式](#3-hooksjson-配置格式)
- [4. Hook 类型](#4-hook-类型)
- [5. Matcher 过滤](#5-matcher-过滤)
- [6. if 条件过滤](#6-if-条件过滤)
- [7. 输入输出格式](#7-输入输出格式)
- [8. 配置位置与作用域](#8-配置位置与作用域)
- [9. 插件中的 Hooks](#9-插件中的-hooks)
- [10. 实战模式](#10-实战模式)
- [11. 调试技巧](#11-调试技巧)
- [12. 本项目实例](#12-本项目实例)

---

## 1. Hook 是什么

Hook 是在 Claude Code **生命周期特定节点**自动执行的脚本或动作。它提供确定性控制——确保某些操作**始终发生**，而不是依赖 LLM 来决定是否执行。

```text
用户提交 prompt
  ↓
UserPromptSubmit hook → 注入额外上下文
  ↓
Claude 处理
  ↓
Claude 调用 Edit 工具
  ↓
PreToolUse hook → 检查是否允许编辑该文件
  ↓
Edit 执行
  ↓
PostToolUse hook → 自动格式化编辑后的文件
  ↓
Claude 完成回复
  ↓
Stop hook → 检查是否遗漏了什么
```

Hook 的三个特点：

1. **确定性**：不依赖 LLM 判断，事件触发就执行
2. **可拦截**：`PreToolUse` 可以阻止工具调用
3. **可注入**：可以在 prompt 提交时注入额外上下文

## 2. 生命周期事件全景

### 会话级（每会话一次）

| 事件 | 何时触发 | Matcher 过滤对象 |
| --- | --- | --- |
| `SessionStart` | 会话开始或恢复 | `startup`、`resume`、`clear`、`compact` |
| `Setup` | `--init-only`、`--init`、`--maintenance` 启动时 | `init`、`maintenance` |
| `SessionEnd` | 会话终止 | `clear`、`resume`、`logout`、`other` |

### Turn 级（每轮一次）

| 事件 | 何时触发 | Matcher 过滤对象 |
| --- | --- | --- |
| `UserPromptSubmit` | 用户提交 prompt，Claude 处理前 | （无 matcher） |
| `UserPromptExpansion` | 用户输入的命令展开为 prompt 前 | 展开命令名 |
| `Stop` | Claude 完成回复时 | （无 matcher） |
| `StopFailure` | turn 因 API 错误结束时 | （无 matcher） |

### 工具级（每个工具调用）

| 事件 | 何时触发 | Matcher 过滤对象 |
| --- | --- | --- |
| `PreToolUse` | 工具执行前，**可阻止** | 工具名：`Bash`、`Edit\|Write`、`mcp__.*` |
| `PermissionRequest` | 权限对话框出现时 | 工具名 |
| `PermissionDenied` | 工具调用被自动模式分类器拒绝时 | 工具名 |
| `PostToolUse` | 工具执行成功后 | 工具名 |
| `PostToolUseFailure` | 工具执行失败后 | 工具名 |
| `PostToolBatch` | 一批并行工具调用全部完成后 | （无 matcher） |

### 其他事件

| 事件 | 何时触发 | Matcher 过滤对象 |
| --- | --- | --- |
| `Notification` | Claude Code 发送通知时 | 通知类型 |
| `MessageDisplay` | 助手消息显示时 | （无 matcher） |
| `SubagentStart` | subagent 被创建时 | agent 类型 |
| `SubagentStop` | subagent 完成时 | agent 类型 |
| `TaskCreated` | TaskCreate 被调用时 | （无 matcher） |
| `TaskCompleted` | 任务标记完成时 | （无 matcher） |
| `InstructionsLoaded` | CLAUDE.md 或 rules 文件加载时 | （无 matcher） |
| `ConfigChange` | 配置文件变更时 | （无 matcher） |
| `FileChanged` | 监视的文件变更时 | 文件路径 |
| `PreCompact` | 上下文压缩前 | （无 matcher） |
| `PostCompact` | 上下文压缩后 | （无 matcher） |
| `Elicitation` | MCP server 请求用户输入时 | （无 matcher） |
| `TeammateIdle` | 团队 agent 即将空闲时 | （无 matcher） |

## 3. hooks.json 配置格式

### 基本结构

```json
{
  "hooks": {
    "EventName": [
      {
        "matcher": "可选的匹配模式",
        "hooks": [
          {
            "type": "command",
            "command": "your-script.sh"
          }
        ]
      }
    ]
  }
}
```

### 多个 matcher 的示例

```json
{
  "hooks": {
    "PostToolUse": [
      {
        "matcher": "Edit|Write",
        "hooks": [
          {
            "type": "command",
            "command": "jq -r '.tool_input.file_path' | xargs npx prettier --write"
          }
        ]
      },
      {
        "matcher": "Bash",
        "hooks": [
          {
            "type": "command",
            "command": "echo \"Bash command executed\" >> /tmp/claude-commands.log"
          }
        ]
      }
    ]
  }
}
```

### 多个 hook 的示例（同一 matcher）

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Write",
        "hooks": [
          {
            "type": "command",
            "command": "$HOME/scripts/check-protected-files.sh"
          },
          {
            "type": "prompt",
            "prompt": "Verify that the file being written follows project conventions."
          }
        ]
      }
    ]
  }
}
```

## 4. Hook 类型

### 4.1 command 类型（最常用）

执行 shell 命令。输入通过 stdin 传入 JSON，通过 exit code 控制行为。

```json
{
  "type": "command",
  "command": "bash ${CLAUDE_PLUGIN_ROOT}/scripts/format.sh",
  "args": [],
  "timeout": 30
}
```

| 字段 | 必需 | 说明 |
| --- | --- | --- |
| `type` | 是 | `"command"` |
| `command` | 是 | 要执行的 shell 命令 |
| `args` | 否 | 命令参数数组；设置后使用 exec form，不经 shell 解释，适合传 `${CLAUDE_PLUGIN_ROOT}` 这类路径 |
| `timeout` | 否 | 超时秒数。`command`/`http`/`mcp_tool` 多数事件默认 600 秒；`UserPromptSubmit` 默认 30 秒，`MessageDisplay` 默认 10 秒 |
| `async` / `asyncRewake` | 否 | 让 hook 后台运行；`asyncRewake` 可在特定失败时唤醒 Claude |
| `shell` | 否 | `bash` 或 `powershell`；设置 `args` 时忽略 |

### 4.2 http 类型

向 HTTP 端点发送 POST 请求。

```json
{
  "type": "http",
  "url": "https://my-service.com/hooks/validate",
  "headers": {
    "Authorization": "Bearer ${API_TOKEN}"
  },
  "timeout": 10
}
```

### 4.3 prompt 类型

让 LLM 评估 prompt 并做出决策。适合需要语义理解的场景。

```json
{
  "type": "prompt",
  "prompt": "Analyze the tool call and determine if it follows project conventions. Block any destructive operations."
}
```

prompt 类型适合：
- 检查代码编辑是否符合项目规范
- 评估 Bash 命令的安全性
- 验证文件路径是否合规

### 4.4 mcp_tool 类型

调用 MCP server 上的工具。

```json
{
  "type": "mcp_tool",
  "server": "my-mcp-server",
  "tool": "validate-code"
}
```

### 4.5 agent 类型

启动一个 agent 来处理 hook 事件。

```json
{
  "type": "agent",
  "prompt": "Review the code changes and report any issues."
}
```

## 5. Matcher 过滤

Matcher 决定 hook 何时触发。不设置 matcher 等同于匹配所有。

### matcher 语法

```text
"Edit"              → 精确匹配 Edit 工具
"Edit|Write"        → 匹配 Edit 或 Write（管道分隔）
"Bash"              → 匹配所有 Bash 调用
"mcp__.*"           → 正则匹配所有 MCP 工具
省略 matcher 或 "*"  → 匹配所有支持 matcher 的事件
```

### 各事件的 matcher 值

| 事件 | matcher 过滤对象 | 示例值 |
| --- | --- | --- |
| `PreToolUse` / `PostToolUse` / `PostToolUseFailure` | 工具名 | `Bash`、`Edit\|Write`、`mcp__.*` |
| `PermissionRequest` / `PermissionDenied` | 工具名 | 同上 |
| `SessionStart` | 启动方式 | `startup`、`resume`、`clear`、`compact` |
| `Setup` | CLI 标志 | `init`、`maintenance` |
| `SessionEnd` | 结束原因 | `clear`、`resume`、`logout`、`other` |
| `Notification` | 通知类型 | `permission_prompt`、`idle_prompt`、`auth_success` |
| `SubagentStart` / `SubagentStop` | agent 类型 | `general-purpose`、`Explore`、自定义名 |
| `InstructionsLoaded` | 加载原因 | `session_start`、`path_glob_match`、`nested_traversal` |
| `FileChanged` | 文件路径 | `*.ts`、`src/**` |

`UserPromptSubmit`、`PostToolBatch`、`Stop`、`TaskCreated`、`TaskCompleted`、`WorktreeCreate`、`WorktreeRemove`、`MessageDisplay`、`CwdChanged` 等事件不支持 matcher；即使写了也会被忽略。`PreCompact` / `PostCompact` 当前也不是按 `auto`、`manual` matcher 过滤。

## 6. if 条件过滤

`if` 字段使用**权限规则语法**进行更精细的过滤，只在 `PreToolUse`、`PostToolUse`、`PostToolUseFailure`、`PermissionRequest`、`PermissionDenied` 事件上有效。

```json
{
  "matcher": "Bash",
  "if": "Bash(rm *)",
  "hooks": [
    {
      "type": "command",
      "command": "echo 'Dangerous rm command blocked' >&2 && exit 2"
    }
  ]
}
```

```json
{
  "matcher": "Edit",
  "if": "Edit(*.prod.*)",
  "hooks": [
    {
      "type": "prompt",
      "prompt": "This is a production config file. Verify the edit is safe."
    }
  ]
}
```

**注意**：设置了 `if` 的事件如果不是上面列出的工具事件，hook 将永远不会运行。

## 7. 输入输出格式

### 7.1 输入（stdin JSON）

所有 hook 通过 stdin 接收 JSON 数据。通用字段：

```json
{
  "session_id": "abc-123",
  "cwd": "/path/to/project",
  "event": "PreToolUse"
}
```

工具事件额外字段：

```json
{
  "tool_name": "Edit",
  "tool_input": {
    "file_path": "/path/to/file.ts",
    "old_string": "old",
    "new_string": "new"
  }
}
```

### 7.2 输出（stdout JSON）

通过 stdout 输出 JSON 控制行为：

#### PreToolUse 输出

```json
{
  "hookSpecificOutput": {
    "hookEventName": "PreToolUse",
    "permissionDecision": "deny",
    "permissionDecisionReason": "Cannot edit production config files."
  }
}
```

`permissionDecision` 值：

| 值 | 效果 |
| --- | --- |
| `allow` | 允许执行 |
| `deny` | 阻止执行 |
| `ask` | 询问用户 |
| `defer` | 不做决定，继续走正常权限流程 |

Hook 要么用 exit code，要么用 `exit 0 + stdout JSON`。如果 exit code 是 2，stdout JSON 会被忽略。

#### 顶层 decision 输出

`UserPromptSubmit`、`UserPromptExpansion`、`PostToolUse`、`PostToolUseFailure`、`PostToolBatch`、`Stop`、`SubagentStop`、`ConfigChange`、`PreCompact` 等事件可以用顶层 `decision: "block"` 阻止后续处理：

```json
{
  "decision": "block",
  "reason": "This task is incomplete; tests were not run."
}
```

#### 注入额外上下文

支持上下文注入的事件可以通过 `hookSpecificOutput.additionalContext` 注入信息给 Claude：

```json
{
  "hookSpecificOutput": {
    "hookEventName": "PostToolUse",
    "additionalContext": "Project uses TypeScript strict mode. All new files must include type annotations."
  }
}
```

### 7.3 Exit Code

| Exit Code | 含义 |
| --- | --- |
| 0 | 成功，无特殊行为 |
| 2 | 对支持阻止的事件表示阻止/反馈；具体效果取决于事件 |

不同事件对 exit code 2 的处理不同。比如 `PreToolUse` 会阻止工具调用，`UserPromptSubmit` 会阻止 prompt 继续处理，`PostToolUse` 只能把 stderr 反馈给 Claude，因为工具已经执行完成。需要精细控制时优先使用 `exit 0 + JSON`。

## 8. 配置位置与作用域

| 位置 | 范围 | 可共享 |
| --- | --- | --- |
| `~/.claude/settings.json` | 所有项目 | 否，仅本机 |
| `.claude/settings.json` | 当前项目 | 是，可提交到 repo |
| `.claude/settings.local.json` | 当前项目 | 否，gitignored |
| Managed policy settings | 组织范围 | 是，管理员控制 |
| 插件 `hooks/hooks.json` | 插件启用时 | 是，随插件分发 |
| Skill/Agent frontmatter | 组件激活期间 | 是，定义在组件文件中 |

### 企业管理

管理员可以用 `allowManagedHooksOnly` 阻止用户、项目和插件 hook，只允许托管 hook 运行。但 `enabledPlugins` 中强制启用的插件 hook 豁免此限制。

## 9. 插件中的 Hooks

### hooks.json 格式

插件 hook 放在 `hooks/hooks.json`，需要额外的 `hooks` 包裹层：

```json
{
  "description": "Automatic code formatting",
  "hooks": {
    "PostToolUse": [
      {
        "matcher": "Write|Edit",
        "hooks": [
          {
            "type": "command",
            "command": "${CLAUDE_PLUGIN_ROOT}/scripts/format.sh",
            "timeout": 30
          }
        ]
      }
    ]
  }
}
```

### 内联在 plugin.json 中

也可以把 hook 直接写在 `plugin.json` 里：

```json
{
  "name": "my-plugin",
  "hooks": {
    "PostToolUse": [
      {
        "matcher": "Write|Edit",
        "hooks": [
          {
            "type": "command",
            "command": "${CLAUDE_PLUGIN_ROOT}/scripts/format.sh"
          }
        ]
      }
    ]
  }
}
```

### Skill/Agent 内联 Hook

Hook 也可以直接写在 skill 或 agent 的 frontmatter 中，只在组件激活期间生效：

```yaml
---
name: deploy
description: Deploy to production.
disable-model-invocation: true
hooks:
  PostToolUse:
    - matcher: "Bash"
      hooks:
        - type: command
          command: "${CLAUDE_SKILL_DIR}/scripts/log-deploy.sh"
---

## Deploy Steps

1. Run the build command
2. Deploy to server
```

## 10. 实战模式

### 10.1 自动格式化

每次编辑文件后自动运行 Prettier：

```json
{
  "hooks": {
    "PostToolUse": [
      {
        "matcher": "Edit|Write",
        "hooks": [
          {
            "type": "command",
            "command": "jq -r '.tool_input.file_path' | xargs npx prettier --write"
          }
        ]
      }
    ]
  }
}
```

### 10.2 保护文件

阻止编辑生产配置文件：

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Edit|Write",
        "hooks": [
          {
            "type": "command",
            "command": "${CLAUDE_PROJECT_DIR}/.claude/hooks/protect-files.sh"
          }
        ]
      }
    ]
  }
}
```

protect-files.sh：

```bash
#!/bin/bash
FILE=$(jq -r '.tool_input.file_path')
case "$FILE" in
  *.production.*|*.prod.*)
    echo '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"Cannot edit production config files."}}'
    # 也可以直接把原因写到 stderr 并 exit 2；这里用 JSON 做结构化控制。
    exit 0
    ;;
esac
exit 0
```

### 10.3 会话启动时注入上下文

```json
{
  "hooks": {
    "SessionStart": [
      {
        "matcher": "startup",
        "hooks": [
          {
            "type": "command",
            "command": "cat \"${CLAUDE_PROJECT_DIR}/.claude/context/project-rules.md\""
          }
        ]
      }
    ]
  }
}
```

### 10.4 通知提醒

```json
{
  "hooks": {
    "Notification": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "command",
            "command": "osascript -e 'display notification \"Claude Code needs your attention\" with title \"Claude Code\"'"
          }
        ]
      }
    ]
  }
}
```

### 10.5 Lint 检查

```json
{
  "hooks": {
    "PostToolUse": [
      {
        "matcher": "Edit|Write",
        "hooks": [
          {
            "type": "prompt",
            "prompt": "Check if the edited file has any obvious syntax errors or missing imports. If it does, report them."
          }
        ]
      }
    ]
  }
}
```

### 10.6 完成检查

```json
{
  "hooks": {
    "Stop": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "prompt",
            "prompt": "Verify that the task is fully complete. Check: 1) All requested changes are made. 2) No TODOs left. 3) Tests would pass. If incomplete, describe what's missing."
          }
        ]
      }
    ]
  }
}
```

## 11. 调试技巧

### 11.1 查看已注册的 Hook

```text
/hooks
```

### 11.2 Debug 模式

```bash
claude --debug
```

### 11.3 直接测试脚本

```bash
# 模拟 PreToolUse 事件
echo '{"tool_name":"Edit","tool_input":{"file_path":"test.ts"}}' | bash hooks/protect-files.sh
```

### 11.4 常见问题排查

- Hook 没触发？检查事件名大小写（`PostToolUse` 不是 `postToolUse`）
- Matcher 不匹配？确认 pattern 是否和工具名精确一致
- 编辑 hooks.json 后没生效？重启 Claude Code
- `if` 条件不生效？确认是否用在支持 `if` 的工具事件上

## 12. 本项目实例

GLM StatusLine 插件目前**没有使用 hooks**。插件的核心功能通过 skill + bin 脚本实现，不需要自动触发逻辑。

如果将来需要扩展，可以添加：

```json
{
  "description": "GLM StatusLine lifecycle hooks",
  "hooks": {
    "SessionStart": [
      {
        "matcher": "startup",
        "hooks": [
          {
            "type": "command",
            "command": "${CLAUDE_PLUGIN_ROOT}/bin/glm-statusline-install.js check",
            "timeout": 5
          }
        ]
      }
    ]
  }
}
```

这个 hook 会在每次会话启动时检查状态栏配置是否仍然有效。

## 参考资料

- [Claude Code 官方文档 - Hooks reference](https://code.claude.com/docs/en/hooks.md)
- [Claude Code 官方文档 - Automate actions with hooks](https://code.claude.com/docs/en/hooks-guide.md)
- [Claude Code 官方文档 - Plugins reference](https://code.claude.com/docs/en/plugins-reference.md)
- [Claude Code GitHub - Hook Development Skill](https://github.com/anthropics/claude-code/blob/main/plugins/plugin-dev/skills/hook-development/SKILL.md)

## 系列导航

| ← 上一篇 | 下一篇 → |
| --- | --- |
| [第三篇：Agents](03-Agents.md) | [第五篇：MCP](05-MCP.md) |
