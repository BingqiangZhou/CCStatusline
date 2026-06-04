# Claude Code LSP 详解

> 学习笔记系列 · 第六篇
>
> 本篇深入讲解 Claude Code 中的 LSP（Language Server Protocol）集成：配置方式、支持的语言、Claude 获得的能力和创建自定义 LSP 插件。

## 目录

- [1. LSP 是什么](#1-lsp-是什么)
- [2. Claude 通过 LSP 获得什么](#2-claude-通过-lsp-获得什么)
- [3. .lsp.json 文件格式](#3-lspjson-文件格式)
- [4. 配置方式](#4-配置方式)
- [5. 已有 LSP 插件](#5-已有-lsp-插件)
- [6. 创建自定义 LSP 插件](#6-创建自定义-lsp-插件)
- [7. 插件中的 LSP](#7-插件中的-lsp)
- [8. LSP 工具操作](#8-lsp-工具操作)
- [9. 调试与常见问题](#9-调试与常见问题)
- [10. 最佳实践](#10-最佳实践)
- [11. 本项目实例](#11-本项目实例)

---

## 1. LSP 是什么

LSP（Language Server Protocol）是 IDE 和语言服务器之间的标准通信协议。VS Code 的代码智能（跳转定义、查找引用、错误提示）就是通过 LSP 实现的。

Claude Code 从 2.0.74 版本开始正式支持 LSP，让 Claude 也能获得类似 IDE 的代码智能能力。

```text
传统方式：
  Claude 用 Grep 搜索 → 可能遗漏、精确度低

LSP 方式：
  Claude 调用 LSP 工具 → 精确跳转到定义、查找所有引用
```

## 2. Claude 通过 LSP 获得什么

安装 LSP 插件后，Claude 获得两个核心能力：

### 2.1 自动诊断

每次 Claude 编辑文件后，语言服务器会自动分析变更并报告错误和警告：

- 类型错误
- 缺失的导入
- 语法问题
- 未使用的变量

Claude 看到诊断结果后可以在同一轮对话中修复问题，无需运行编译器或 linter。

查看方式：按 `Ctrl+O` 当出现 "diagnostics found" 指示器时。

### 2.2 代码导航

Claude 可以使用 LSP 进行精确的代码导航：

- **跳转到定义**（goToDefinition）
- **跳转到实现**（goToImplementation）
- **悬停查看类型**（hover）
- **列出文件符号**（documentSymbol）
- **查找所有引用**（findReferences）
- **搜索工作区符号**（workspaceSymbol）
- **调用层次**（prepareCallHierarchy、incomingCalls、outgoingCalls）

这些操作比 Grep 搜索更精确，因为它们基于语言的语义理解。

## 3. .lsp.json 文件格式

### 基本结构

```json
{
  "language-id": {
    "command": "lsp-server-command",
    "extensionToLanguage": {
      ".ext": "language-id"
    }
  }
}
```

### 字段说明

#### 必需字段

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `command` | string | LSP 二进制文件路径（必须在 PATH 中） |
| `extensionToLanguage` | object | 文件扩展名到语言标识符的映射 |

#### 可选字段

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `args` | string[] | 传给 LSP server 的命令行参数 |
| `transport` | string | 通信方式：`stdio`（默认）或 `socket` |
| `env` | object | 启动 server 时设置的环境变量 |
| `initializationOptions` | object | 初始化时传给 server 的选项 |
| `settings` | object | 通过 `workspace/didChangeConfiguration` 传给 server 的设置 |
| `workspaceFolder` | string | 工作区文件夹路径 |
| `startupTimeout` | number | 启动超时（毫秒） |
| `maxRestarts` | number | 最大重启次数（默认 3） |

### 示例

#### Go 语言

```json
{
  "go": {
    "command": "gopls",
    "args": ["serve"],
    "extensionToLanguage": {
      ".go": "go"
    }
  }
}
```

#### Python（Pyright）

```json
{
  "python": {
    "command": "pyright-langserver",
    "args": ["--stdio"],
    "extensionToLanguage": {
      ".py": "python",
      ".pyi": "python"
    },
    "settings": {
      "python": {
        "analysis": {
          "typeCheckingMode": "basic"
        }
      }
    }
  }
}
```

#### TypeScript

```json
{
  "typescript": {
    "command": "typescript-language-server",
    "args": ["--stdio"],
    "extensionToLanguage": {
      ".ts": "typescript",
      ".tsx": "typescriptreact",
      ".js": "javascript",
      ".jsx": "javascriptreact"
    }
  }
}
```

## 4. 配置方式

### 4.1 从 Marketplace 安装（推荐）

最简单的方式是从官方 Marketplace 安装已有的 LSP 插件：

```text
/plugin
```

在 Discover 标签中搜索 "lsp"，找到对应语言的插件安装。

### 4.2 临时或自定义配置

官方推荐通过插件提供 `.lsp.json` 或在 `plugin.json` 中内联 `lspServers`。如果只是临时验证某个语言服务器，建议创建一个最小 LSP 插件，而不是把 LSP 配置直接塞进普通 settings；普通 plugin `settings.json` 当前也只支持少量默认设置，不适合承载 LSP server 定义。

### 4.3 创建自定义 LSP 插件

为没有官方插件的语言创建 LSP 插件（见下一节）。

## 5. 已有 LSP 插件

社区和官方提供了多种 LSP 插件：

| 语言 | 插件 | 需要安装的二进制 |
| --- | --- | --- |
| Python | `pyright-lsp` | `pyright-langserver` |
| Rust | `rust-analyzer-lsp` | `rust-analyzer` |
| TypeScript/JS | `typescript-lsp` | `typescript-language-server` |

官方 marketplace 和社区插件会持续变化。安装前以 `/plugin` 的 Discover 搜索结果为准；上表只列官方参考文档中明确提到的代表性插件。

**安装步骤**：

1. 先安装语言服务器的二进制文件
2. 从 Marketplace 安装对应的 LSP 插件
3. 重启 Claude Code

## 6. 创建自定义 LSP 插件

### 插件结构

```text
my-lsp-plugin/
├── .claude-plugin/
│   └── plugin.json
├── .lsp.json
└── hooks/
    ├── hooks.json
    └── check-my-lsp.sh
```

### plugin.json

```json
{
  "name": "my-language-lsp",
  "displayName": "My Language LSP",
  "description": "LSP support for My Language",
  "version": "1.0.0",
  "author": {
    "name": "Your Name"
  },
  "license": "MIT"
}
```

### .lsp.json

```json
{
  "my-language": {
    "command": "my-language-server",
    "args": ["--stdio"],
    "extensionToLanguage": {
      ".myext": "my-language"
    },
    "startupTimeout": 10000,
    "maxRestarts": 3
  }
}
```

## 7. 插件中的 LSP

### 独立 .lsp.json（推荐）

在插件根目录创建 `.lsp.json`：

```json
{
  "go": {
    "command": "gopls",
    "extensionToLanguage": {
      ".go": "go"
    }
  }
}
```

### 内联在 plugin.json 中

```json
{
  "name": "gopls-lsp",
  "lspServers": {
    "go": {
      "command": "gopls",
      "args": ["serve"],
      "extensionToLanguage": {
        ".go": "go"
      }
    }
  }
}
```

### plugin.json 中的 lspServers 路径

```json
{
  "name": "my-plugin",
  "lspServers": "./.lsp.json"
}
```

## 8. LSP 工具操作

Claude Code 内置了 LSP 工具，有 9 种操作：

| 操作 | 说明 |
| --- | --- |
| `goToDefinition` | 跳转到符号的定义位置 |
| `goToImplementation` | 跳转到接口/抽象类的实现 |
| `hover` | 获取符号的类型信息和文档 |
| `documentSymbol` | 列出文件中的所有符号 |
| `findReferences` | 查找符号的所有引用 |
| `workspaceSymbol` | 在整个工作区搜索符号 |
| `prepareCallHierarchy` | 准备调用层次 |
| `incomingCalls` | 查找调用指定函数的所有位置 |
| `outgoingCalls` | 查找指定函数调用的所有函数 |

可用性取决于具体语言的 LSP server 实现。

## 9. 调试与常见问题

### 9.1 查看 LSP 状态

```text
/plugin
```

在 Errors 标签中查看 LSP 相关错误。

### 9.2 常见问题

| 问题 | 解决方案 |
| --- | --- |
| `Executable not found in $PATH` | 安装对应的语言服务器二进制文件 |
| Server 不启动 | 确认二进制文件在 PATH 中，检查 `/plugin` Errors 标签 |
| 内存占用过高 | 禁用插件，使用 Claude 内置搜索工具 |
| Monorepo 误报 | 配置 `workspaceFolder` 和 `initializationOptions` |
| 编辑配置后没生效 | 重启 Claude Code |

### 9.3 安装二进制文件示例

```bash
# Python
pip install pyright
# 或
npm install -g pyright

# TypeScript
npm install -g typescript-language-server typescript

# Go
go install golang.org/x/tools/gopls@latest

# Rust
rustup component add rust-analyzer
```

## 10. 最佳实践

### 10.1 先安装二进制，再安装插件

LSP 插件只配置如何连接，不包含语言服务器本身。

### 10.2 大项目注意内存

`rust-analyzer` 和 `pyright` 在大型项目上可能消耗大量内存。如果遇到内存问题，禁用插件。

### 10.3 利用自动诊断

LSP 最大的价值是自动诊断——Claude 编辑文件后立即看到错误。这比手动运行编译器快得多。

### 10.4 不要过度依赖

LSP 是补充工具，不是替代。对于简单的文本搜索，Grep 已经足够。LSP 的优势在语义级别操作。

## 11. 本项目实例

GLM StatusLine 插件**没有使用 LSP**。插件是用 JavaScript/Node.js 编写的单文件脚本，Claude Code 内置的 Read、Grep、Glob 工具已经足够分析和编辑这个项目。

如果项目变大（比如拆分成多个模块），可以考虑安装 TypeScript LSP 插件来获得更好的代码智能。

## 参考资料

- [Claude Code 官方文档 - Plugins reference](https://code.claude.com/docs/en/plugins-reference.md)
- [Claude Code 官方文档 - Discover and install prebuilt plugins](https://code.claude.com/docs/en/discover-plugins.md)
- [Claude Code LSP 插件集合（boostvolt）](https://github.com/boostvolt/claude-code-lsps)
- [Claude Code LSP 插件集合（Piebald-AI）](https://github.com/Piebald-AI/claude-code-lsps)
- [Language Server Protocol 规范](https://microsoft.github.io/language-server-protocol/)

## 系列导航

| ← 上一篇 | 下一篇 → |
| --- | --- |
| [第五篇：MCP](05-MCP.md) | [第七篇：Output Styles](07-Output-Styles.md) |
