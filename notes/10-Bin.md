# Claude Code Bin 详解

> 学习笔记系列 · 第十篇
>
> 本篇深入讲解 Claude Code 插件的 bin 目录：可执行脚本的放置、PATH 机制、设计模式和最佳实践。

## 目录

- [1. Bin 是什么](#1-bin-是什么)
- [2. 工作机制](#2-工作机制)
- [3. 脚本要求](#3-脚本要求)
- [4. 常见模式](#4-常见模式)
- [5. 与 Skill 配合](#5-与-skill-配合)
- [6. 调试技巧](#6-调试技巧)
- [7. 最佳实践](#7-最佳实践)
- [8. 本项目实例](#8-本项目实例)

---

## 1. Bin 是什么

`bin/` 目录是插件中存放**可执行脚本**的地方。当插件被启用时，Claude Code 会把 `bin/` 目录添加到 Bash 工具的 `PATH` 中。

```text
插件启用前：
  Claude 执行 Bash → 只能找到系统 PATH 中的命令

插件启用后：
  Claude 执行 Bash → 系统PATH + 插件 bin/ 目录
                        ↑
                        glm-statusline-install.js 现在可以直接调用
```

这意味着 Claude 在执行 Bash 工具时，可以像调用普通命令一样调用 `bin/` 下的脚本——不需要写完整路径。

## 2. 工作机制

### 2.1 PATH 注入

```text
插件启用时：
  PATH = /usr/bin:/bin:/usr/local/bin:...:/path/to/plugin/bin/

Claude 执行 Bash("glm-statusline-install.js install")
  ↓
在 PATH 中找到 /path/to/plugin/bin/glm-statusline-install.js
  ↓
执行该脚本
```

### 2.2 多个插件

如果多个插件都有 `bin/` 目录，它们都会被加入 PATH：

```text
PATH = ...:plugin-a/bin/:plugin-b/bin/:plugin-c/bin/
```

如果多个插件有同名脚本，PATH 顺序靠前的优先。

### 2.3 生命周期

- **插件启用**：`bin/` 加入 PATH
- **插件禁用/卸载**：`bin/` 从 PATH 移除
- **会话内刷新**：`/reload-plugins` 会更新 PATH

## 3. 脚本要求

### 3.1 可执行权限

```bash
chmod +x bin/my-script.js
```

在 macOS/Linux 上，脚本必须有可执行权限。

### 3.2 Shebang 行

脚本的第一行必须是 shebang，告诉系统用什么解释器执行：

```javascript
#!/usr/bin/env node
// Node.js 脚本

const args = process.argv.slice(2);
console.log(`Hello, ${args[0]}!`);
```

```bash
#!/usr/bin/env bash
# Bash 脚本

echo "Hello, $1!"
```

```python
#!/usr/bin/env python3
# Python 脚本

import sys
print(f"Hello, {sys.argv[1]}!")
```

### 3.3 编码和换行

- 使用 UTF-8 编码
- 使用 LF 换行（不要 CRLF，否则 shebang 可能失效）

## 4. 常见模式

### 4.1 薄入口 + 核心逻辑

```text
bin/
├── my-tool.js       ← 薄入口（几行代码）
└── my-tool-core.js  ← 核心逻辑（大量代码）

bin/my-tool.js 内容：
  #!/usr/bin/env node
  require('../my-tool-core.js');
```

这种模式把入口和逻辑分开。入口极短（方便 PATH 查找），逻辑放在根目录（方便维护）。

### 4.2 安装/卸载脚本

```text
bin/
├── my-plugin-install.js     ← 安装逻辑
└── my-plugin-uninstall.js   ← 卸载逻辑
```

安装脚本通常修改 `~/.claude/settings.json`，卸载脚本反向操作。

### 4.3 状态行脚本

```text
bin/
└── my-statusline.js         ← 状态行命令
```

读取 stdin JSON，向 stdout 输出状态行文本。

### 4.4 工具脚本

```text
bin/
├── format.sh                ← 代码格式化
├── lint.sh                  ← 代码检查
└── test-runner.sh           ← 测试运行
```

这些脚本可以被 skill 调用，也可以被 hook 调用。

## 5. 与 Skill 配合

最常见的模式是 Skill 作为指令层，Bin 脚本作为执行层：

```text
skills/install/SKILL.md
  ↓ 告诉 Claude 执行
bin/my-plugin-install.js

skills/format/SKILL.md
  ↓ 告诉 Claude 执行
bin/format.sh
```

Skill 中的指令：

```markdown
---
description: Install the plugin.
---

## Installation

Run the installer:

\`\`\`bash
my-plugin-install.js install $ARGUMENTS
\`\`\`

Then report the result.
```

因为 `bin/` 在 PATH 中，所以 skill 里可以直接写 `my-plugin-install.js`，不需要完整路径。

### 从 Skill 引用插件内脚本

如果脚本不在 `bin/` 中而在 `scripts/` 目录下，可以用 `${CLAUDE_SKILL_DIR}` 或 `${CLAUDE_PLUGIN_ROOT}`：

```markdown
\`\`\`bash
bash ${CLAUDE_SKILL_DIR}/../scripts/helper.sh
\`\`\`
```

## 6. 调试技巧

### 6.1 直接运行脚本

```bash
# 在项目根目录直接运行
node bin/my-script.js arg1 arg2

# 或先加上执行权限
chmod +x bin/my-script.js
./bin/my-script.js arg1 arg2
```

### 6.2 测试 stdin 交互

```bash
# 模拟 status line stdin
echo '{"model":{"display_name":"Sonnet"}}' | node bin/my-statusline.js
```

### 6.3 检查 PATH

在 Claude Code 会话中：

```text
# 让 Claude 检查 bin/ 是否在 PATH 中
echo $PATH | tr ':' '\n' | grep plugin
```

### 6.4 查看可用的 bin 脚本

```text
# 让 Claude 列出插件 bin/ 内容
ls -la /path/to/plugin/bin/
```

## 7. 最佳实践

### 7.1 薄入口模式

```javascript
#!/usr/bin/env node
// bin/my-tool.js — 入口文件（保持极短）
require('../my-tool-core.js');
```

好处：
- `bin/` 文件极短，一目了然
- 核心逻辑在根目录，方便编辑和测试
- 不需要 `node_modules`，用标准库即可

### 7.2 零依赖

```javascript
// 好：只使用 Node.js 标准库
const fs = require('fs');
const path = require('path');
const http = require('http');

// 不好：依赖第三方包
const axios = require('axios');
const lodash = require('lodash');
```

插件脚本应该尽量零依赖，因为：
- 用户不需要 `npm install`
- 脚本在任何 Node.js 环境下都能运行
- 减少版本冲突

### 7.3 优雅的错误处理

```javascript
#!/usr/bin/env node

try {
  // 主逻辑
  const result = doWork();
  console.log(result);
} catch (err) {
  // status line 脚本必须输出安全兜底
  console.log('Status: unavailable');
  if (process.env.MY_PLUGIN_DEBUG === '1') {
    console.error(err.message);
  }
}
```

对于 status line 脚本，**即使崩溃也要输出一行有效文本**，否则 Claude Code 界面会显示错误。

### 7.4 支持参数和帮助

```javascript
#!/usr/bin/env node

const args = process.argv.slice(2);

if (args.includes('--help') || args.includes('-h')) {
  console.log('Usage: my-tool.js [command] [options]');
  console.log('');
  console.log('Commands:');
  console.log('  install   Install the plugin');
  console.log('  uninstall Uninstall the plugin');
  process.exit(0);
}

const command = args[0] || 'help';
// ...
```

### 7.5 文件命名

```text
# 好：小写、连字符分隔
bin/
├── my-tool.js
├── my-tool-install.js
└── my-tool-configure.js

# 不好：大写、下划线、空格
bin/
├── MyTool.js
├── my_tool_install.js
└── my tool configure.js
```

## 8. 本项目实例

GLM StatusLine 插件的 `bin/` 目录是整个插件的核心执行层：

```text
bin/
├── glm-statusline.js          ← 状态行入口（4 行）
└── glm-statusline-install.js  ← 安装/配置/卸载 CLI（约 440 行）
```

### 8.1 glm-statusline.js — 薄入口

```javascript
#!/usr/bin/env node
'use strict';
// Thin wrapper: delegates to the root-level single-file script.
require('../glm-statusline.js');
```

只有 4 行代码。真正的逻辑在根目录的 `glm-statusline.js`（约 1100 行）中。

这个脚本被 `~/.claude/settings.json` 的 `statusLine.command` 引用：

```json
{
  "statusLine": {
    "type": "command",
    "command": "'/usr/local/bin/node' '/Users/you/.claude/glm-statusline-launcher.js'",
    "refreshInterval": 5,
    "padding": 0
  }
}
```

安装脚本实际写入的是稳定 launcher，而不是插件缓存目录里的 `bin/glm-statusline.js`。这样插件更新后，launcher 可以自动寻找最新版本的 `bin/glm-statusline.js`。

### 8.2 glm-statusline-install.js — 安装 CLI

这个脚本处理三个子命令：

```bash
# 安装：写入 settings.json 的 statusLine
glm-statusline-install.js install

# 配置：交互式选择字段
glm-statusline-install.js configure

# 卸载：移除 statusLine 配置
glm-statusline-install.js uninstall
```

关键设计决策：

1. **显式安装**：不自动修改 `settings.json`，需要用户运行 `/glm-statusline:install`
2. **备份**：安装前自动备份现有 settings
3. **安全卸载**：只移除本插件管理的配置，不删别人的 statusLine
4. **稳定 launcher**：安装时写入 `~/.claude/glm-statusline-launcher.js`，插件更新后自动找到最新版本

### 8.3 PATH 效果

因为 `bin/` 在 PATH 中，skill 里可以直接写：

```markdown
\`\`\`bash
glm-statusline-install.js install $ARGUMENTS
\`\`\`
```

不需要写完整路径如 `/path/to/plugin/bin/glm-statusline-install.js`。

## 参考资料

- [Claude Code 官方文档 - Plugins reference](https://code.claude.com/docs/en/plugins-reference.md)
- [Claude Code 官方文档 - Customize your status line](https://code.claude.com/docs/en/statusline.md)

## 系列导航

| ← 上一篇 | 下一篇 → |
| --- | --- |
| [第九篇：Monitors](09-Monitors.md) | [第十一篇：实践案例 - GLM StatusLine](11-实践案例-GLM-StatusLine.md) |
