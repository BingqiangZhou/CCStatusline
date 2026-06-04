# Claude Code Skill 详解

> 学习笔记系列 · 第二篇
>
> 本篇深入讲解 Claude Code Skill：SKILL.md 的写法、frontmatter 配置、参数系统、类型选择和最佳实践。

## 目录

- [1. Skill 是什么](#1-skill-是什么)
- [2. SKILL.md 基本结构](#2-skillmd-基本结构)
- [3. Frontmatter 详解](#3-frontmatter-详解)
- [4. 参数系统](#4-参数系统)
- [5. 动态命令注入](#5-动态命令注入)
- [6. Skill 类型与选型](#6-skill-类型与选型)
- [7. 存放位置与优先级](#7-存放位置与优先级)
- [8. 插件中的 Skill](#8-插件中的-skill)
- [9. 最佳实践](#9-最佳实践)
- [10. 本项目实例](#10-本项目实例)

---

## 1. Skill 是什么

Claude Code Skill 是一个**可复用的 Markdown 指令包**。它可以：

- 作为 `/skill-name` 命令由用户手动调用
- 由 Claude 根据 `description` 自动加载（当 `disable-model-invocation` 未设置时）

Skill 的核心价值：把重复的提示词、流程和上下文打包成一个命名单元，让 Claude 按照预设的方式工作。

```text
用户输入 /deploy
  ↓
Claude Code 查找 skills/deploy/SKILL.md
  ↓
加载 SKILL.md 内容作为当前 turn 的指令
  ↓
Claude 按照 SKILL.md 中的步骤执行
```

## 2. SKILL.md 基本结构

SKILL.md 分为两部分：**YAML frontmatter**（元信息）和 **Markdown 正文**（指令）。

### 最小示例

```markdown
---
description: Summarize uncommitted changes and flag risky edits.
---

## Current changes

!`git diff HEAD`

## Instructions

Summarize the changes in two or three bullets, then list risks and missing tests.
```

### 带目录的示例

```text
my-skill/
├── SKILL.md          ← 主文件（必需）
├── reference.md      ← 参考资料
├── examples.md       ← 示例
└── scripts/
    └── helper.sh     ← 辅助脚本
```

支持文件不会自动加载。你需要在 SKILL.md 正文中告诉 Claude 何时读取它们。

## 3. Frontmatter 详解

```yaml
---
name: deploy
description: Deploy the application to production.
argument-hint: "[environment]"
arguments:
  - environment
disable-model-invocation: true
allowed-tools:
  - Bash(npm test)
  - Bash(npm run build)
context: fork
agent: general-purpose
user-invocable: false
model: sonnet
effort: high
hooks:
  PostToolUse: ...
paths:
  - "src/api/**/*.ts"
shell: bash
---
```

### 字段说明

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `name` | string | 显示名称。目录名决定命令名，`name` 不改变命令名。 |
| `description` | string | **推荐必写**。Claude 用它判断何时自动使用。写清"做什么"和"什么时候用"。 |
| `when_to_use` | string | 补充触发场景描述，和 description 一起用于自动匹配。 |
| `argument-hint` | string | 在 `/` 自动补全中提示参数格式。 |
| `arguments` | array | 给位置参数命名，正文中用 `$name` 引用。 |
| `disable-model-invocation` | boolean | `true` = Claude 不能自动触发，只能用户手动 `/name` 调用。适合有副作用的操作。 |
| `user-invocable` | boolean | `false` = 用户菜单隐藏，只让 Claude 自动加载。适合背景知识类。 |
| `allowed-tools` | array | skill 激活时预批准指定工具。**不是白名单**，未列出的工具仍按全局权限处理。 |
| `disallowed-tools` | array | skill 激活时移除某些工具。 |
| `context` | string | `fork` = 在隔离 subagent 上运行，适合大量检索或审查任务。 |
| `agent` | string | 配合 `context: fork` 指定 subagent 类型（`Explore`、`Plan`、`general-purpose` 或自定义）。 |
| `model` | string | 为当前 turn 指定模型。 |
| `effort` | string | 推理强度：`low`、`medium`、`high`、`xhigh`、`max`（可用值取决于模型）。 |
| `hooks` | object | 只在这个 skill 生命周期内生效的 hook。 |
| `paths` | array | 限制自动激活范围，例如只在 `src/api/**/*.ts` 相关文件上触发。 |
| `shell` | string | 动态命令注入的 shell：`bash` 或 `powershell`。 |

`allowed-tools` 和 `disallowed-tools` 可以写成 YAML list，也可以写成空格或逗号分隔的字符串。它们改变的是当前 skill 激活期间的权限行为，不会永久修改 settings。

## 4. 参数系统

Skill 支持多种参数引用方式：

### 4.1 位置参数

```markdown
---
arguments:
  - environment
  - service
---

Deploy $environment service $service to production.
```

用户调用：`/deploy production api`

### 4.2 完整参数字符串

```markdown
---
argument-hint: "[--show=plan,5h,mcp,context]"
---

Run the installer with: my-installer.js install $ARGUMENTS
```

用户调用：`/install --show=plan,5h,mcp,context`

`$ARGUMENTS` 会被替换为 skill 名称后的完整字符串。

### 4.3 内置变量

| 变量 | 说明 |
| --- | --- |
| `$ARGUMENTS` | 用户在 skill 名称后的完整参数 |
| `$ARGUMENTS[0]` 或 `$0` | 第一个参数 |
| `$name` | 用 `arguments` 声明的位置参数名 |
| `${CLAUDE_SESSION_ID}` | 当前会话 ID |
| `${CLAUDE_EFFORT}` | 当前 effort |
| `${CLAUDE_SKILL_DIR}` | 当前 skill 目录路径 |

### 4.4 引用 skill 附带脚本

```markdown
---
description: Run project linter.
---

Run the helper script:

\`\`\`bash
bash ${CLAUDE_SKILL_DIR}/scripts/lint.sh $ARGUMENTS
\`\`\`
```

## 5. 动态命令注入

用 `` !`command` `` 语法在 skill 加载时执行命令，把输出替换进内容：

```markdown
## Git status

!`git status --short`

## Diff

!`git diff HEAD`

## Current branch

!`git branch --show-current`
```

Claude Code 会先执行这些命令，再把输出替换到 skill 内容中。

**适用场景**：把"当前状态"注入 prompt，比如 git diff、PR 信息、测试摘要。

**注意**：不要用它执行危险操作。有副作用的操作应该写在正文步骤里，让 Claude 明确执行。

## 6. Skill 类型与选型

| 类型 | 特点 | 推荐配置 | 例子 |
| --- | --- | --- | --- |
| 背景知识 | Claude 需要偶尔参考，不一定手动调用 | 默认允许自动触发，或 `user-invocable: false` | API 规范、数据库 schema、代码风格 |
| 手动工作流 | 用户明确发起，可能有副作用 | `disable-model-invocation: true` | `/deploy`、`/commit`、`/release` |
| 隔离任务 | 会读很多文件或产生大量中间输出 | `context: fork` | 深度审查、研究、迁移计划 |

## 7. 存放位置与优先级

| 位置 | 路径 | 范围 |
| --- | --- | --- |
| 个人 | `~/.claude/skills/<name>/SKILL.md` | 所有项目 |
| 项目 | `.claude/skills/<name>/SKILL.md` | 当前项目 |
| 插件 | `<plugin>/skills/<name>/SKILL.md` | 插件启用处 |
| 旧 commands | `.claude/commands/<name>.md` | 与 skill 类似，但功能不如 skill 丰富 |

同名 skill 的优先级：enterprise > personal > project。插件 skill 有命名空间（`插件名:skill名`），所以不会和普通 skill 冲突。

## 8. 插件中的 Skill

插件中的 skill 会自动加上命名空间前缀：

```text
plugins/glm-statusline/skills/install/SKILL.md
  → /glm-statusline:install

plugins/glm-statusline/skills/configure/SKILL.md
  → /glm-statusline:configure
```

命名规则：

- **目录名** = 命令名（`skills/install/` → `:install`）
- **插件名** = 命名空间（`glm-statusline` → `glm-statusline:`）

### 插件 skill 调用 bin 脚本

这是最常见的模式。skill 作为"指令层"，告诉 Claude 运行 bin 目录下的脚本：

```text
skills/install/SKILL.md    →  指示 Claude 运行  →  bin/install.js
skills/configure/SKILL.md  →  指示 Claude 运行  →  bin/configure.js
```

`bin/` 目录下的文件会被加入 Claude Code 的 `PATH`，所以正文中可以直接写脚本名。

> **安全提示**：会修改文件、settings、部署环境或发送外部消息的 skill，建议加 `disable-model-invocation: true`，避免 Claude 在用户没有明确输入 `/name` 时自动触发。

## 9. 最佳实践

### 9.1 description 要像触发规则

```yaml
# 好
description: Enable the GLM status line in Claude Code user settings after the plugin is installed, optionally choosing which fields to display.

# 不好
description: Install.
```

### 9.2 正文写"要做什么"，少写背景

```markdown
# 好
## Steps
1. Run `installer.js install $ARGUMENTS`
2. Report the output to the user.
3. Suggest running /configure to customize display.

# 不好
## Background
This skill was created because...
```

### 9.3 长参考资料放在旁边

```text
deploy/
├── SKILL.md          ← 步骤指令（短）
├── reference.md      ← 完整部署文档（长）
└── scripts/
    └── deploy.sh     ← 实际部署脚本
```

SKILL.md 里说明何时读取 reference：

```markdown
If the user asks about deployment options or environments, read reference.md for details.
```

### 9.4 有副作用的 skill 加 disable-model-invocation

```yaml
---
description: Deploy to production.
disable-model-invocation: true
---
```

防止 Claude 在不经意间触发部署。

### 9.5 确定性动作用 scripts

重复、易错、确定性的动作（安装、构建、检查）应该放在 `scripts/` 或 `bin/` 里，让 Claude 执行脚本而不是每次重写命令。

## 10. 本项目实例

GLM StatusLine 插件包含四个 skill：

### install skill

```markdown
---
description: Enable the GLM status line in Claude Code user settings.
disable-model-invocation: true
---

# Install GLM StatusLine

Run the plugin installer from the plugin `bin` directory:

\`\`\`bash
glm-statusline-install.js install
\`\`\`

Then tell the user that the status line is enabled.
```

关键设计：`install` 会写入 `~/.claude/settings.json`，所以设置 `disable-model-invocation: true`，让用户必须显式运行 `/glm-statusline:install`。显示字段通过 `/glm-statusline:configure` 的交互式选择界面配置。

### configure skill

```markdown
---
description: Open an interactive selector for choosing GLM StatusLine fields.
disable-model-invocation: true
---
```

设置了 `disable-model-invocation: true`，因为配置修改是用户主动操作。

### plan-details skill

```markdown
---
description: Show detailed GLM Coding Plan quota and usage information.
disable-model-invocation: true
---
```

### uninstall skill

```markdown
---
description: Remove the GLM status line from Claude Code user settings.
disable-model-invocation: true
---
```

卸载同样会修改 settings，建议保持手动触发。

## 参考资料

- [Claude Code 官方文档 - Extend Claude with skills](https://code.claude.com/docs/en/skills.md)
- [Claude Code 官方文档 - Commands](https://code.claude.com/docs/en/commands.md)
- [Claude Code 官方文档 - Plugins reference](https://code.claude.com/docs/en/plugins-reference.md)

## 系列导航

| ← 上一篇 | 下一篇 → |
| --- | --- |
| [第一篇：插件系统概览](01-插件系统概览.md) | [第三篇：Agents](03-Agents.md) |
