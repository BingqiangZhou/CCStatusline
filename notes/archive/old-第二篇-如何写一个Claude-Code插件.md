# GLM StatusLine 学习笔记（第二篇）：如何写一个 Claude Code 插件

> 本篇以 GLM StatusLine 插件为实例，讲解 Claude Code 插件系统的核心概念、目录结构、开发流程和分发方式。如果你也想把一个已有的脚本包装成 Claude Code 插件，这篇可以当操作手册。
>
> 系列目录：
> - [第一篇：Claude Code 底部显示 GLM Coding Plan 用量](Claude-Code-GLM-StatusLine-笔记.md)——单文件状态栏的实现原理
> - 第二篇：如何写一个 Claude Code 插件（本篇）
> - [第三篇：Claude Code Skill 写法与扩展能力地图](docs/claude-code-skills-and-extensions-guide.md)

## 1. Claude Code 插件是什么

Claude Code 插件是一个**自包含目录**，里面放着一组能力：skill、agent、hook、MCP server、LSP、output style、theme、monitor、bin 脚本等。用户安装插件后，Claude Code 会自动发现这些能力，把它们融入当前会话。

插件不是 npm 包，也不需要编译。它就是一个目录，满足 Claude Code 约定的文件结构就行。

关键文件只有一个：

```text
.claude-plugin/plugin.json
```

这个文件声明了插件的身份（名字、版本、作者、描述等）。Claude Code 看到这个文件，就知道"这是一个插件"。

## 2. 最小插件结构

一个最小的 Claude Code 插件只需要两个东西：

```text
my-plugin/
├── .claude-plugin/
│   └── plugin.json
└── skills/
    └── hello/
        └── SKILL.md
```

`plugin.json` 内容：

```json
{
  "name": "my-plugin",
  "displayName": "My Plugin",
  "description": "A minimal Claude Code plugin example.",
  "version": "1.0.0"
}
```

`skills/hello/SKILL.md` 内容：

```markdown
---
description: Say hello to the user.
---

# Hello

Tell the user: "Hello from my-plugin! 👋"
```

开发时可以直接加载：

```bash
claude --plugin-dir /path/to/my-plugin
```

加载后，用户就可以在 Claude Code 中输入 `/hello` 来调用这个 skill。

这就是一个完整的插件了。

## 3. 插件能力的目录映射

Claude Code 插件的能力不是写在 `.claude-plugin/` 里面的，而是放在插件根目录的固定子目录中：

```text
my-plugin/
├── .claude-plugin/
│   └── plugin.json           # 插件身份（必需）
├── skills/                    # Skill 命令
│   └── hello/SKILL.md
├── agents/                    # 自定义 subagent
│   └── reviewer.md
├── hooks/
│   └── hooks.json             # 生命周期 hook
├── .mcp.json                  # MCP 服务器配置
├── .lsp.json                  # LSP 配置
├── output-styles/             # 回答风格
├── themes/                    # 终端主题
├── monitors/
│   └── monitors.json          # 后台 monitor
└── bin/                       # 加入 PATH 的可执行脚本
    └── my-tool.js
```

每个子目录都是可选的。你只需要放实际用到的能力。

以下是各能力的简要说明：

| 目录/文件 | 作用 | 何时使用 |
| --- | --- | --- |
| `skills/` | 可复用的指令包，用户可以 `/name` 调用 | 有重复流程要暴露给用户 |
| `agents/` | 自定义 subagent 定义 | 需要隔离上下文的专门任务 |
| `hooks/hooks.json` | 生命周期事件自动触发 | 必须强制执行的规则或自动化 |
| `.mcp.json` | 外部工具连接器 | 需要访问外部系统或 API |
| `.lsp.json` | 语言服务器连接 | 需要代码智能（诊断、跳转等） |
| `output-styles/` | 改变回答格式/语气 | 定制回答风格 |
| `themes/` | 终端视觉主题 | 定制界面外观 |
| `monitors/monitors.json` | 后台长驻命令 | 被动监听外部状态变化 |
| `bin/` | 加入 `PATH` 的脚本 | skill 需要运行外部命令 |

## 4. plugin.json 详解

`plugin.json` 是插件的身份证。它放在 `.claude-plugin/` 目录下。

```json
{
  "name": "glm-statusline",
  "displayName": "GLM StatusLine",
  "description": "Configurable GLM / Z.ai usage status line for Claude Code.",
  "version": "1.2.3",
  "author": {
    "name": "CCStatusline",
    "email": "optional@example.com",
    "url": "https://example.com"
  },
  "homepage": "https://code.claude.com/docs/en/statusline",
  "license": "MIT",
  "keywords": [
    "claude-code",
    "statusline",
    "glm",
    "z-ai",
    "quota"
  ]
}
```

关键字段：

- `name`：插件标识符，用于安装和更新命令。只能包含小写字母、数字和连字符。
- `displayName`：给用户看的名字。
- `description`：简要描述插件功能。Claude 会根据这个描述判断插件是否与用户请求相关。
- `version`：语义化版本号。
- `keywords`：帮助 marketplace 搜索和分类。

一个实用建议：让 `description` 尽量具体，写清楚"做了什么"和"什么时候用"。这会影响 Claude Code 在插件市场的展示效果。

## 5. marketplace.json：本地分发的关键

如果你想把自己的插件目录变成一个可以被 Claude Code 发现和安装的"marketplace"，就需要 `.claude-plugin/marketplace.json`。

```json
{
  "name": "bingqiangzhou-tools",
  "owner": {
    "name": "CCStatusline"
  },
  "description": "Local marketplace for the GLM StatusLine Claude Code plugin.",
  "version": "1.2.3",
  "plugins": [
    {
      "name": "glm-statusline",
      "displayName": "GLM StatusLine",
      "source": "./",
      "description": "Configurable GLM / Z.ai usage status line for Claude Code.",
      "version": "1.2.3",
      "author": {
        "name": "CCStatusline"
      },
      "category": "interface",
      "tags": [
        "statusline",
        "glm",
        "z-ai",
        "quota"
      ]
    }
  ]
}
```

关键字段：

- `name`：marketplace 名称，用户安装时会用到。
- `plugins`：这个 marketplace 里包含的插件列表。
- `source`：`"./"` 表示插件就在当前目录下。也可以指向其他路径。

用户安装流程：

```text
/plugin marketplace add /path/to/my-plugin-dir
/plugin install glm-statusline@bingqiangzhou-tools
```

如果 `marketplace.json` 和 `plugin.json` 在同一目录，`source` 就是 `"./"`。一个 marketplace 可以包含多个插件，每个插件指向不同的子目录。

## 6. Skill：插件的交互入口

Skill 是 Claude Code 插件最常见的交互方式。用户通过 `/plugin-name:skill-name` 调用。

### 6.1 目录命名决定命令名

```text
skills/
├── install/
│   └── SKILL.md        →  /glm-statusline:install
├── configure/
│   └── SKILL.md        →  /glm-statusline:configure
├── plan-details/
│   └── SKILL.md        →  /glm-statusline:plan-details
└── uninstall/
    └── SKILL.md        →  /glm-statusline:uninstall
```

插件里的 skill 会自动加上命名空间前缀（`插件名:skill名`），所以不会和项目级或个人级 skill 冲突。

### 6.2 SKILL.md 结构

```markdown
---
description: Enable the GLM status line in Claude Code user settings.
argument-hint: "[--show=plan,5h,mcp,context,model,session,day,30d]"
---

# Install GLM StatusLine

Run the plugin installer from the plugin `bin` directory:

\`\`\`bash
glm-statusline-install.js install $ARGUMENTS
\`\`\`

Then tell the user the status line is enabled.
```

`SKILL.md` 分为两部分：

1. **YAML frontmatter**：声明元信息。
2. **Markdown 正文**：告诉 Claude 要做什么。

常用的 frontmatter 字段：

| 字段 | 作用 |
| --- | --- |
| `description` | 推荐必写。Claude 用它判断何时自动加载或展示给用户。 |
| `argument-hint` | 在 `/` 补全时提示参数格式。 |
| `disable-model-invocation: true` | 禁止 Claude 自动触发，只能用户手动调用。适合有副作用的操作。 |
| `allowed-tools` | skill 激活时预批准指定工具。 |

正文中可以用 `$ARGUMENTS` 引用用户传入的参数。

### 6.3 Skill 调用 bin 脚本

Skill 本身只是 Markdown 指令，实际工作通常由 `bin/` 目录下的脚本来完成：

```text
skills/install/SKILL.md    →  指示 Claude 运行 →  bin/glm-statusline-install.js install
skills/configure/SKILL.md  →  指示 Claude 运行 →  bin/glm-statusline-install.js configure
```

`bin/` 目录下的文件会被加入 Claude Code Bash 工具的 `PATH`，所以 skill 正文里可以直接写脚本名，不需要写完整路径。

## 7. bin/ 目录：脚本的存放位置

`bin/` 是一个特殊的约定目录。Claude Code 安装插件后，会把这个目录加入内部 `PATH`，让 skill 可以直接调用里面的脚本。

```text
bin/
├── glm-statusline.js          # 状态栏入口
└── glm-statusline-install.js  # 安装/配置/卸载 CLI
```

关键点：

- 脚本需要有 shebang（`#!/usr/bin/env node`）和执行权限。
- `bin/` 里的脚本可以通过 `process.argv` 接收参数。
- 这些脚本在 Claude Code 的 Bash 工具环境中运行，不是直接在用户终端里运行。

### 7.1 入口脚本模式

本项目采用了"薄入口 + 核心逻辑分离"的模式：

```javascript
// bin/glm-statusline.js（入口，4 行）
#!/usr/bin/env node
'use strict';
require(path.join(__dirname, '..', 'glm-statusline.js'));
```

```javascript
// glm-statusline.js（核心，约 1100 行）
// 实际的状态栏逻辑
```

这样拆分的好处是：
- `bin/` 里只放入口，保持简洁。
- 核心逻辑放在根目录，方便直接运行和调试（`npm run statusline`）。
- 安装脚本和状态栏脚本共享同一个根目录。

### 7.2 安装脚本设计

安装脚本 `bin/glm-statusline-install.js` 提供了多个子命令：

```bash
glm-statusline-install.js install      # 写入 settings.json
glm-statusline-install.js configure    # 交互式或参数式配置
glm-statusline-install.js uninstall    # 移除 settings.json 中的 statusLine
glm-statusline-install.js print-command # 调试用，输出命令字符串
```

这种设计让一个脚本承担多种职责，减少文件数量。每个 skill 对应一个子命令。

## 8. 插件与用户 Settings 的关系

这是本项目中最重要的设计决策，也是写 Claude Code 插件时最容易踩的坑。

### 8.1 插件安装 ≠ 修改用户界面

Claude Code 插件安装后，插件内的 skill、agent、hook 等能力会立即可用。但**用户界面配置**（如 `statusLine`）仍然由 `~/.claude/settings.json` 控制，插件安装不会自动修改它。

这和 VS Code 扩展不同。VS Code 扩展可以在激活时自动注册配置，但 Claude Code 插件的 `settings.json` 主要用于声明默认配置，不适合可靠地接管主界面。

### 8.2 显式启用模式

本项目的做法是：

```text
用户安装插件  →  插件的 skill 可用
                 但 statusLine 还没生效
用户运行 /glm-statusline:install  →  安装脚本写入 settings.json
                                      statusLine 生效
```

安装脚本做的事情：

```javascript
// 1. 读取现有 settings.json
const settings = readJsonFile(settingsPath) || {};

// 2. 备份
fs.writeFileSync(backupPath, JSON.stringify(settings, null, 2));

// 3. 写入 statusLine
settings.statusLine = {
  type: "command",
  command: `${nodePath} ${launcherPath}`,
  refreshInterval: 5,
  padding: 0,
};

// 4. 保存
fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
```

### 8.3 为什么要备份

因为 `~/.claude/settings.json` 是用户级配置，里面可能有其他工具写入的 `env`、`permissions` 等内容。直接覆盖会导致用户配置丢失。

备份策略：

```text
~/.claude/settings.json
  ↓ 安装前复制
~/.claude/settings.json.glm-statusline-plugin.bak.1717500000000
```

### 8.4 卸载时的安全检查

卸载不能无脑删除 `statusLine` 字段，因为用户可能已经换成了别的 status line：

```javascript
// 只移除本插件管理的 statusLine
const command = settings.statusLine?.command || '';
if (command.includes('glm-statusline')) {
  delete settings.statusLine;
}
// 如果 command 不包含 glm-statusline，说明用户已经改了，不动它
```

## 9. 稳定 Launcher：解决插件更新后的路径问题

这是本项目遇到的一个实际问题。

### 9.1 问题描述

Claude Code 安装插件后，会把插件文件复制到一个缓存目录：

```text
~/.claude/plugins/.cache/glm-statusline@bingqiangzhou-tools/1.2.3/bin/glm-statusline.js
```

`settings.json` 里的 `statusLine.command` 指向这个路径。

当用户更新插件时：

```bash
claude plugin update glm-statusline@bingqiangzhou-tools
```

Claude Code 会创建一个新的缓存目录：

```text
~/.claude/plugins/.cache/glm-statusline@bingqiangzhou-tools/1.2.4/bin/glm-statusline.js
```

但 `settings.json` 里的 `statusLine.command` 仍然指向 `1.2.3` 的路径。如果 Claude Code 清理了旧缓存，状态栏就坏了。

### 9.2 解决方案：稳定 Launcher

安装脚本不直接把 `statusLine.command` 指向插件缓存目录，而是写入一个"稳定入口"：

```text
~/.claude/glm-statusline-launcher.js
```

这个 launcher 做的事情很简单：

```javascript
// ~/.claude/glm-statusline-launcher.js（简化版）
const fs = require('fs');
const path = require('path');

const cacheDir = path.join(
  os.homedir(),
  '.claude/plugins/.cache/glm-statusline@bingqiangzhou-tools'
);

// 找到最新的版本目录
const versions = fs.readdirSync(cacheDir)
  .filter(v => {
    try { return fs.statSync(path.join(cacheDir, v)).isDirectory(); } catch { return false; }
  })
  .sort()
  .reverse(); // 最新的排前面

for (const version of versions) {
  const target = path.join(cacheDir, version, 'bin/glm-statusline.js');
  if (fs.existsSync(target)) {
    require(target);
    return;
  }
}

console.log('GLM StatusLine: plugin not found');
```

`settings.json` 中的 command 指向这个稳定 launcher：

```json
{
  "statusLine": {
    "command": "node ~/.claude/glm-statusline-launcher.js"
  }
}
```

这样无论插件怎么更新，launcher 总是能找到最新版本的脚本。

### 9.3 什么时候需要稳定 Launcher

如果你写的插件也需要修改 `settings.json` 里指向插件文件的路径（比如 `statusLine.command`、MCP server command 等），就需要考虑稳定 launcher。如果插件只使用 skill、agent、hook 等不需要路径引用的能力，就不需要。

## 10. 版本管理与验证

### 10.1 版本一致性

三个文件里的版本号必须保持一致：

```text
package.json          →  "version": "1.2.3"
.claude-plugin/plugin.json     →  "version": "1.2.3"
.claude-plugin/marketplace.json →  "version": "1.2.3"（每个 plugin 也有 version）
```

验证脚本会检查这一点：

```javascript
const pkg = require('../package.json');
const plugin = require('../.claude-plugin/plugin.json');
const marketplace = require('../.claude-plugin/marketplace.json');

assert.strictEqual(pkg.version, plugin.version);
assert.strictEqual(pkg.version, marketplace.version);
assert.strictEqual(pkg.version, marketplace.plugins[0].version);
```

### 10.2 验证脚本

项目提供了 `npm test` 来验证插件完整性：

```bash
npm test
```

建议的验证内容：

1. **元数据完整性**：`plugin.json`、`marketplace.json` 是否合法 JSON，版本是否一致。
2. **文件存在性**：`bin/`、`skills/`、`docs/` 目录下的关键文件是否存在。
3. **功能验证**：状态栏脚本能在模拟 stdin 下正常输出。
4. **配置验证**：配置文件可以控制显示字段。
5. **安装验证**：install/uninstall 脚本能正确写入和移除 settings。
6. **端到端验证**：启动本地 mock server，测试完整 API 集成。

### 10.3 更新版本的步骤

```text
1. 修改 package.json、plugin.json、marketplace.json 中的版本号
2. 运行 npm test 确认验证通过
3. 提交 git commit
4. 用户在 Claude Code 中运行 claude plugin update
```

## 11. 开发调试方法

### 11.1 直接加载当前目录

```bash
cd /path/to/my-plugin
claude --plugin-dir .
```

这样不需要 marketplace 和安装步骤，直接把当前目录当作插件加载。适合开发调试。

### 11.2 marketplace 方式安装

```text
/plugin marketplace add /path/to/my-plugin
/plugin install my-plugin@my-marketplace
```

适合模拟真实安装流程，测试 install skill。

### 11.3 测试单个 skill

在 Claude Code 中直接输入 skill 命令：

```text
/my-plugin:hello
```

如果 skill 有参数：

```text
/my-plugin:install --show=plan,5h,context
```

### 11.4 调试 bin 脚本

可以直接在终端运行：

```bash
node bin/my-script.js
```

对于需要 stdin 的脚本（如 status line），可以模拟输入：

```bash
echo '{"model":{"display_name":"Sonnet"}}' | node bin/glm-statusline.js
```

## 12. 项目文件结构总结

以本项目为例，完整的插件结构如下：

```text
CCStatusline/
├── .claude-plugin/
│   ├── plugin.json                  # 插件身份
│   └── marketplace.json             # 本地 marketplace
├── bin/
│   ├── glm-statusline.js            # 状态栏入口（薄包装）
│   └── glm-statusline-install.js    # 安装/配置/卸载 CLI
├── docs/
│   ├── claude-code-plugin-build-guide.md     # 构建文档
│   └── claude-code-skills-and-extensions-guide.md  # 扩展能力文档
├── scripts/
│   └── verify.js                    # 验证脚本
├── skills/
│   ├── configure/SKILL.md           # /glm-statusline:configure
│   ├── install/SKILL.md             # /glm-statusline:install
│   ├── plan-details/SKILL.md        # /glm-statusline:plan-details
│   └── uninstall/SKILL.md           # /glm-statusline:uninstall
├── glm-statusline.js                # 核心脚本（约 1100 行）
├── package.json                     # Node.js 包信息
├── CHANGELOG.md                     # 版本变更记录
├── Claude-Code-GLM-StatusLine-笔记.md          # 学习笔记第一篇
└── Claude-Code-GLM-StatusLine-笔记-2-如何写一个Claude-Code插件.md  # 本篇
```

## 13. 写插件的检查清单

从零开始写一个 Claude Code 插件，可以按这个顺序检查：

### 13.1 准备阶段

- [ ] 确认需求：你的插件要解决什么问题？
- [ ] 确认插件需要哪些能力（skill、bin、hook、MCP 等）。
- [ ] 创建项目目录和 `.claude-plugin/plugin.json`。

### 13.2 核心功能

- [ ] 实现核心脚本/逻辑。
- [ ] 确保脚本可以通过命令行独立运行和测试。
- [ ] 如果脚本需要修改用户 settings，设计安装/卸载流程。

### 13.3 插件包装

- [ ] 在 `bin/` 下创建入口脚本（shebang + 执行权限）。
- [ ] 在 `skills/` 下创建 SKILL.md（至少一个）。
- [ ] 如果需要本地分发，创建 `.claude-plugin/marketplace.json`。
- [ ] 如果插件需要修改 settings 中的路径引用，考虑稳定 launcher。

### 13.4 验证

- [ ] 用 `claude --plugin-dir .` 测试加载。
- [ ] 测试每个 skill 命令。
- [ ] 测试安装和卸载流程。
- [ ] 写验证脚本（`npm test`）。
- [ ] 检查三个文件的版本号一致。

### 13.5 文档

- [ ] 写 README（功能说明、安装方法、配置说明）。
- [ ] 写 CHANGELOG（版本变更记录）。
- [ ] 如果有设计决策或复杂逻辑，补充开发文档。

## 14. 常见陷阱与建议

### 14.1 不要自动修改用户界面配置

Claude Code 的 `statusLine`、`env`、`permissions` 等都是用户级配置。插件不应该在安装时静默修改它们。

推荐做法：

```text
插件安装  →  只注册 skill/agent/hook 等能力
用户主动运行 install skill  →  才修改用户配置
```

### 14.2 版本号要同步更新

`package.json`、`plugin.json`、`marketplace.json` 三个文件的版本号必须一致。建议在验证脚本中自动检查。

### 14.3 Skill 的 description 要写好

`description` 不只是给用户看的，Claude 也会根据它判断何时使用这个 skill。写得越具体，自动匹配越准确。

好的写法：

```yaml
description: Enable the GLM status line in Claude Code user settings after the plugin is installed.
```

不好的写法：

```yaml
description: Install.
```

### 14.4 bin 脚本要有 shebang

```javascript
#!/usr/bin/env node
'use strict';
// ...
```

没有 shebang，Claude Code 的 Bash 工具可能无法正确执行。

### 14.5 考虑跨平台路径

`~` 在 Windows 上不生效。用 `os.homedir()` 或 `path.join(os.homedir(), ...)` 代替。

### 14.6 容错：不要让插件崩溃影响 Claude Code

如果你的插件提供 status line 脚本，确保脚本崩溃时也输出安全兜底文本：

```javascript
main().catch((err) => {
  // 保证 Claude Code 界面不被破坏
  console.log('Status: unavailable');
});
```

## 15. 本项目的插件化决策回顾

这个项目从一个单文件脚本（`~/.claude/glm-statusline.js`）演进到完整的 Claude Code 插件。过程中做了几个关键决策：

### 决策 1：不拆散核心脚本

`glm-statusline.js` 保持单文件（约 1100 行），只在外面加插件包装层。原因：

- 单文件已经能独立工作，拆散会增加维护成本。
- 插件包装层和核心逻辑是两个不同关注点。
- 用户即使不用插件，也能直接用这个脚本。

### 决策 2：显式启用，不自动接管

安装插件后，用户还需要运行 `/glm-statusline:install` 才能启用状态栏。原因：

- `statusLine` 是用户界面配置，自动覆盖有风险。
- 用户可能已经有别的 status line 配置。
- 安装脚本可以做备份和安全检查。

### 决策 3：稳定 launcher 解决版本更新问题

写入 `~/.claude/glm-statusline-launcher.js` 而不是直接指向插件缓存路径。原因：

- 插件更新后缓存路径会变。
- `settings.json` 中的 command 不会自动更新。
- launcher 可以自动发现最新版本。

### 决策 4：交互式配置 + 预览

`/glm-statusline:configure` 进入交互选择界面，每次切换字段都保存并预览。原因：

- 8 个显示字段不适合用开关一个个试。
- 实时预览让用户看到效果，不用等下一次交互。
- 同时保留参数式配置，满足脚本化需求。

## 16. 总结

写一个 Claude Code 插件的核心步骤：

```text
1. 创建 .claude-plugin/plugin.json
2. 实现核心功能（脚本/工具）
3. 在 bin/ 下放入口脚本
4. 在 skills/ 下写 SKILL.md
5. 如果要本地分发，加 marketplace.json
6. 如果要修改用户 settings，设计 install/uninstall skill
7. 写验证脚本
8. 写文档
```

最关键的认知：

- **插件是能力的容器**，不是应用本身。应用逻辑应该在脚本里，插件只是包装和分发。
- **skill 是指令，不是代码**。它告诉 Claude 要做什么，具体工作由 bin 脚本完成。
- **用户配置要尊重**。不要静默修改 `settings.json`，用显式启用模式。

如果这篇对你有帮助，可以继续看：

- [第一篇：Claude Code 底部显示 GLM Coding Plan 用量](Claude-Code-GLM-StatusLine-笔记.md)
- [第三篇：Claude Code Skill 写法与扩展能力地图](docs/claude-code-skills-and-extensions-guide.md)
- [插件构建过程详细文档](docs/claude-code-plugin-build-guide.md)
- [CHANGELOG](CHANGELOG.md)
