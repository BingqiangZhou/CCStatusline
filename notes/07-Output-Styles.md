# Claude Code Output Styles 详解

> 学习笔记系列 · 第七篇
>
> 本篇深入讲解 Claude Code Output Styles：回答风格的定义方式、frontmatter 字段、内置风格、优先级和最佳实践。

## 目录

- [1. Output Style 是什么](#1-output-style-是什么)
- [2. 文件格式](#2-文件格式)
- [3. Frontmatter 详解](#3-frontmatter-详解)
- [4. 内置 Output Styles](#4-内置-output-styles)
- [5. 优先级与选择](#5-优先级与选择)
- [6. 插件中的 Output Styles](#6-插件中的-output-styles)
- [7. 实战示例](#7-实战示例)
- [8. 最佳实践](#8-最佳实践)
- [9. 本项目实例](#9-本项目实例)

---

## 1. Output Style 是什么

Output Style 是一种改变 Claude **回答风格和格式**的机制。它通过修改 system prompt 来控制 Claude 如何组织回答。

```text
默认风格：
  Claude 正常回答，完整解释

Explanatory 风格：
  Claude 详细解释每一步的原因和背景

Proactive 风格：
  Claude 主动发现问题并提出建议，不等待用户询问

Learning 风格：
  Claude 用教学方式回答，附带练习和建议
```

Output Style 不是工具或命令，而是一种**系统级行为修改**。一旦激活，所有 Claude 的回答都会遵循选定的风格。

## 2. 文件格式

Output Style 是 Markdown 文件，使用 YAML frontmatter + 正文指令。

### 最小示例

```markdown
---
description: Always respond in a concise bullet-point format.
---

## Response Format

- Use bullet points for all answers
- Keep each point to one sentence
- No more than 5 points per answer
```

### 完整示例

```markdown
---
name: teacher
description: Respond in a teaching style, explaining concepts step by step.
keep-coding-instructions: true
force-for-plugin: false
---

## Teaching Mode

When answering questions:

1. First, state the concept clearly in one sentence
2. Then, provide a concrete example
3. Finally, suggest a practice exercise
4. Use analogies when introducing unfamiliar concepts

### Code Examples

- Always add inline comments explaining key lines
- Show the simplest working version first
- Then show improvements one at a time
```

## 3. Frontmatter 详解

| 字段 | 类型 | 必需 | 说明 |
| --- | --- | --- | --- |
| `name` | string | 推荐 | 风格名称，用于显示和选择 |
| `description` | string | 推荐 | 详细描述，帮助选择合适的风格 |
| `keep-coding-instructions` | boolean | 否 | `true`（默认）= 保留 coding 相关指令。设为 `false` 会移除默认的编码指令，适合纯对话场景。 |
| `force-for-plugin` | boolean | 否 | `true` = 当插件启用时强制使用此风格，不可被用户覆盖。适合必须保持的团队规范。 |

### keep-coding-instructions 详解

```yaml
# 保留编码指令（默认）
# Claude 仍然知道怎么写代码
keep-coding-instructions: true

# 移除编码指令
# Claude 的回答更侧重于非编程场景
keep-coding-instructions: false
```

### force-for-plugin 详解

```yaml
# 插件风格可以被用户覆盖
force-for-plugin: false

# 插件风格强制生效
# 适合团队规范（如"所有回答必须包含代码审查"）
force-for-plugin: true
```

## 4. 内置 Output Styles

Claude Code 提供了几个内置风格：

### 4.1 Default

默认风格。Claude 按照自己的判断组织回答，不做特殊格式化。

### 4.2 Proactive

Claude 主动发现问题并提出建议：

- 识别潜在的改进点
- 提出用户可能没想到的解决方案
- 在发现问题时不等待用户询问

### 4.3 Explanatory

Claude 详细解释每一步：

- 解释为什么选择这个方法
- 提供背景知识
- 说明替代方案

### 4.4 Learning

Claude 用教学方式回答：

- 从概念到实践，循序渐进
- 提供练习建议
- 使用类比解释复杂概念

## 5. 优先级与选择

### 选择方式

Output Style 可以在多个层面设置：

1. **全局设置**：`~/.claude/settings.json` 中的 `outputStyle` 字段
2. **项目设置**：`.claude/settings.json`
3. **插件提供**：插件 `output-styles/` 目录中的风格文件
4. **临时切换**：在会话中使用命令切换

### 优先级

```text
force-for-plugin: true 的插件风格
  > 用户/项目设置中指定的风格
  > 普通插件风格
  > 内置 Default
```

### 切换风格

```text
/output-style
```

在会话中切换当前使用的输出风格。

## 6. 插件中的 Output Styles

### 目录结构

```text
my-plugin/
├── output-styles/
│   ├── concise.md
│   └── detailed.md
└── .claude-plugin/
    └── plugin.json
```

### 自定义路径

在 `plugin.json` 中指定自定义路径：

```json
{
  "name": "my-plugin",
  "outputStyles": "./custom/styles/"
}
```

或指定单个文件：

```json
{
  "name": "my-plugin",
  "outputStyles": ["./styles/teacher.md"]
}
```

### 自动生效

插件中的 Output Style 在插件启用时自动可用。如果设置了 `force-for-plugin: true`，则会自动激活。

## 7. 实战示例

### 7.1 团队代码审查风格

```markdown
---
name: code-review
description: All code changes must include review notes.
force-for-plugin: true
---

## Code Review Style

When writing or modifying code:

1. **Always add review comments** explaining key decisions
2. **Flag potential issues** inline with `// REVIEW:` comments
3. **Suggest tests** for each new function
4. **Note performance implications** of changes
```

### 7.2 简洁风格

```markdown
---
name: minimal
description: Ultra-concise responses, code-first.
keep-coding-instructions: true
---

## Response Rules

- Lead with code, then brief explanation
- Maximum 2 sentences of context
- No pleasantries or filler text
- Use comments in code instead of separate paragraphs
```

### 7.3 文档风格

```markdown
---
name: doc-writer
description: Write responses as documentation.
keep-coding-instructions: true
---

## Documentation Style

Structure all responses as:

1. **Title**: What this section covers
2. **Overview**: One-paragraph summary
3. **Examples**: Working code samples with comments
4. **See Also**: Links to related sections
```

### 7.4 Socratic 风格

```markdown
---
name: socratic
description: Guide through questions rather than direct answers.
---

## Socratic Method

Instead of giving direct answers:

1. Ask a guiding question that leads to the answer
2. If the user struggles, provide a hint
3. Only give the full answer after the user has tried
4. Celebrate correct reasoning

For code questions:
- Show a similar example first
- Ask "what do you think this does?"
- Then confirm or correct
```

## 8. 最佳实践

### 8.1 正文写具体指令

```markdown
# 好
---
description: Respond with code-first approach.
---

- Always show code before explanation
- Maximum 3 lines of explanation per code block

# 不好
---
description: Be concise.
---

Be more concise in your responses.
```

### 8.2 慎用 force-for-plugin

`force-for-plugin: true` 会覆盖用户偏好，只在团队规范必须强制执行时使用。

### 8.3 保持 keep-coding-instructions: true

除非你的插件是纯对话/非编程场景，否则保持默认值。移除编码指令会显著影响 Claude 的代码能力。

### 8.4 风格指令要可量化

```markdown
# 好（可量化）
- Maximum 5 bullet points per answer
- Code examples must include comments
- Each function needs at least one test suggestion

# 不好（模糊）
- Be helpful
- Write good code
- Be thorough
```

## 9. 本项目实例

GLM StatusLine 插件**没有提供 Output Style**。插件的核心功能是状态栏显示，不需要改变 Claude 的回答风格。

如果将来想让插件更智能，可以添加一个 Output Style，让 Claude 在讨论用量时自动提供优化建议：

```markdown
---
name: usage-aware
description: When discussing GLM/Z.ai usage, proactively suggest optimization strategies.
---

## Usage Awareness

When the conversation involves:
- GLM Coding Plan quotas
- Token usage
- API rate limits

Proactively suggest:
- How to reduce unnecessary token consumption
- Which fields in the status line are most relevant
- Whether the current usage pattern is sustainable
```

## 参考资料

- [Claude Code 官方文档 - Plugins reference](https://code.claude.com/docs/en/plugins-reference.md)
- [Claude Code 官方文档 - Output styles](https://code.claude.com/docs/en/output-styles.md)
- [Claude Code GitHub - Output Styles examples](https://github.com/anthropics/claude-code/tree/main/plugins)

## 系列导航

| ← 上一篇 | 下一篇 → |
| --- | --- |
| [第六篇：LSP](06-LSP.md) | [第八篇：Themes](08-Themes.md) |
