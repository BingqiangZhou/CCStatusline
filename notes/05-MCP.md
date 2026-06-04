# Claude Code MCP 详解

> 学习笔记系列 · 第五篇
>
> 本篇深入讲解 Claude Code 中的 MCP（Model Context Protocol）集成：传输类型、配置方式、插件中的 MCP、环境变量和最佳实践。

## 目录

- [1. MCP 是什么](#1-mcp-是什么)
- [2. 传输类型](#2-传输类型)
- [3. 配置方式](#3-配置方式)
- [4. .mcp.json 文件格式](#4-mcpjson-文件格式)
- [5. 插件中的 MCP](#5-插件中的-mcp)
- [6. 环境变量展开](#6-环境变量展开)
- [7. 作用域与优先级](#7-作用域与优先级)
- [8. 生命周期管理](#8-生命周期管理)
- [9. 最佳实践](#9-最佳实践)
- [10. 调试技巧](#10-调试技巧)
- [11. 本项目实例](#11-本项目实例)

---

## 1. MCP 是什么

MCP（Model Context Protocol）是一个开放协议，让 Claude Code 能够连接外部工具和服务。通过 MCP，Claude 可以：

- 查询数据库
- 操控浏览器
- 调用内部 API
- 读写文件系统
- 与任何实现了 MCP 协议的服务交互

```text
Claude Code
  ├── 内置工具：Read、Edit、Bash、Grep ...
  └── MCP 工具：通过 MCP server 暴露
        ├── database-tools server → query、insert、migrate
        ├── browser server → navigate、click、screenshot
        └── git-server server → commit、push、create-pr
```

MCP server 暴露的工具在 Claude Code 中以 `mcp__服务器名__工具名` 的格式出现，可以像内置工具一样使用。

## 2. 传输类型

Claude Code 支持四种 MCP 传输类型：

### 2.1 stdio（本地进程）

Claude Code 启动一个子进程，通过 stdin/stdout 通信。

```json
{
  "my-local-server": {
    "command": "npx",
    "args": ["-y", "my-mcp-server"],
    "env": {
      "API_KEY": "${MY_API_KEY}"
    }
  }
}
```

特点：
- **最低延迟**：本地进程间通信
- **最适合**：本地工具、自定义 server、NPM 包
- **认证方式**：环境变量

### 2.2 http / streamable-http（远程 REST）

通过 HTTP POST 请求通信。`streamable-http` 是 MCP 规范的正式名称，`http` 是 Claude Code 中的别名，两者等效。

```json
{
  "remote-api": {
    "type": "http",
    "url": "https://mcp.example.com/api",
    "headers": {
      "Authorization": "Bearer ${API_TOKEN}"
    }
  }
}
```

特点：
- **适合**：API 后端、Token 认证
- **认证方式**：Headers（支持 Bearer Token）

### 2.3 sse（Server-Sent Events）

通过 HTTP + SSE 连接远程 server。**已被 HTTP 取代**，新项目建议使用 `http` 类型。

```json
{
  "asana": {
    "type": "sse",
    "url": "https://mcp.asana.com/sse"
  }
}
```

特点：
- **适合**：托管云服务、OAuth 认证
- **认证方式**：OAuth（自动）或自定义 Headers

### 2.4 ws（WebSocket）

持久的双向 WebSocket 连接。

```json
{
  "realtime": {
    "type": "ws",
    "url": "wss://mcp.example.com/ws",
    "headers": {
      "Authorization": "Bearer ${TOKEN}"
    }
  }
}
```

特点：
- **适合**：实时双向通信、流式数据
- **认证方式**：Headers 中的 Token

### 类型对比

| 特性 | stdio | http | sse | ws |
| --- | --- | --- | --- | --- |
| 传输方式 | 进程通信 | HTTP 请求 | HTTP + SSE | WebSocket |
| 方向 | 双向 | 请求/响应 | 服务端推送 | 双向 |
| 状态 | 有状态 | 无状态 | 有状态 | 有状态 |
| 认证 | 环境变量 | Token | OAuth/Headers | Headers |
| 延迟 | 最低 | 中 | 中 | 低 |
| 适用场景 | 本地工具 | REST API | 云服务 | 实时通信 |

## 3. 配置方式

### 3.1 CLI 命令

```bash
# 添加远程 HTTP server
claude mcp add my-server --transport http https://mcp.example.com/api

# 添加本地 stdio server
claude mcp add playwright -- npx -y @playwright/mcp@latest

# 用 JSON 直接添加
claude mcp add-json my-server '{"type":"stdio","command":"npx","args":["-y","my-server"]}'

# 查看已配置的 server
claude mcp get my-server

# 列出所有 server
claude mcp list

# 移除 server
claude mcp remove my-server
```

### 3.2 直接编辑 .mcp.json

在项目根目录创建 `.mcp.json`：

```json
{
  "mcpServers": {
    "docs-server": {
      "type": "http",
      "url": "https://code.claude.com/docs/mcp"
    },
    "playwright": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@playwright/mcp@latest"]
    }
  }
}
```

### 3.3 会话中管理

```text
/mcp
```

列出所有已连接的 MCP server 和它们的工具。可以在这里查看工具列表、连接状态。

## 4. .mcp.json 文件格式

### 通用字段

| 字段 | 适用类型 | 说明 |
| --- | --- | --- |
| `type` | 全部 | 传输类型：`stdio`（默认）、`http`、`sse`、`ws` |
| `command` | stdio | 可执行文件路径 |
| `args` | stdio | 命令参数数组 |
| `env` | stdio | 传给 server 的环境变量 |
| `url` | http/sse/ws | server 的 URL |
| `headers` | http/sse/ws | 请求头（用于认证） |
| `headersHelper` | http/sse/ws | 动态生成 headers 的命令 |
| `timeout` | http/sse/ws | 请求超时（毫秒） |
| `alwaysLoad` | 全部 | 是否在会话启动时自动加载 |

### stdio server 示例

```json
{
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/allowed/path"],
      "env": {
        "LOG_LEVEL": "debug"
      }
    }
  }
}
```

### http server 示例

```json
{
  "mcpServers": {
    "internal-api": {
      "type": "http",
      "url": "https://api.example.com/mcp",
      "headers": {
        "Authorization": "Bearer ${API_TOKEN}",
        "X-Client-ID": "claude-code"
      },
      "timeout": 30000
    }
  }
}
```

### 多个 server 组合

```json
{
  "mcpServers": {
    "database": {
      "command": "${CLAUDE_PLUGIN_ROOT}/servers/db-server",
      "args": ["--config", "${CLAUDE_PLUGIN_ROOT}/config.json"]
    },
    "remote-search": {
      "type": "http",
      "url": "https://search.example.com/mcp",
      "headers": {
        "Authorization": "Bearer ${SEARCH_TOKEN}"
      }
    },
    "realtime-events": {
      "type": "ws",
      "url": "wss://events.example.com/mcp"
    }
  }
}
```

## 5. 插件中的 MCP

插件可以通过两种方式提供 MCP server。

### 5.1 独立 .mcp.json（推荐）

在插件根目录创建 `.mcp.json`：

```json
{
  "mcpServers": {
    "database-tools": {
      "command": "${CLAUDE_PLUGIN_ROOT}/servers/db-server",
      "args": ["--config", "${CLAUDE_PLUGIN_ROOT}/config.json"],
      "env": {
        "DB_URL": "${DB_URL}"
      }
    }
  }
}
```

### 5.2 内联在 plugin.json 中

```json
{
  "name": "my-plugin",
  "version": "1.0.0",
  "mcpServers": {
    "plugin-api": {
      "command": "${CLAUDE_PLUGIN_ROOT}/servers/api-server",
      "args": ["--port", "8080"]
    }
  }
}
```

### 插件 MCP 特点

- **自动生命周期**：插件启用时 server 自动启动
- **环境变量**：使用 `${CLAUDE_PLUGIN_ROOT}` 引用插件文件、`${CLAUDE_PLUGIN_DATA}` 引用持久状态、`${CLAUDE_PROJECT_DIR}` 引用项目根目录
- **热加载**：启用/禁用插件后运行 `/reload-plugins` 刷新 MCP server

## 6. 环境变量展开

`.mcp.json` 中的以下字段支持环境变量展开：

| 字段 | 展开支持 |
| --- | --- |
| `command` | ✅ |
| `args` | ✅ |
| `env` | ✅ |
| `url` | ✅ |
| `headers` | ✅ |

展开语法：`${VAR_NAME}` 或 `${VAR_NAME:-default}`。

```json
{
  "mcpServers": {
    "my-server": {
      "command": "${CUSTOM_PATH:-/usr/local/bin}/my-server",
      "env": {
        "API_KEY": "${MY_API_KEY}",
        "DB_URL": "${DATABASE_URL}"
      }
    }
  }
}
```

**注意**：`env` 中的变量是传给 MCP server 的，不是 Claude Code 自身的变量。引用 `${CLAUDE_PROJECT_DIR}` 在项目/用户范围的 `.mcp.json` 中需要默认值（`${CLAUDE_PROJECT_DIR:-.}`），但在插件的 `.mcp.json` 中不需要。

## 7. 作用域与优先级

| 作用域 | 存储位置 | 可用范围 |
| --- | --- | --- |
| `local` | `~/.claude.json`（项目条目下） | 仅当前用户，仅当前项目 |
| `project` | 项目根目录 `.mcp.json` | 所有克隆项目的人 |
| `user` | `~/.claude.json`（顶层） | 仅当前用户，所有项目 |
| 插件 | 插件 `.mcp.json` 或 `plugin.json` | 插件启用时 |

### 使用 CLI 指定作用域

```bash
claude mcp add my-server --scope project -- npx my-server
claude mcp add my-server --scope user -- npx my-server
# 默认 --scope local
```

## 8. 生命周期管理

### 8.1 启动

- Claude Code 在会话启动时自动连接已配置的 MCP server
- stdio server 作为子进程启动
- 远程 server 通过 HTTP/WebSocket 连接

### 8.2 工具发现

连接后 Claude Code 会获取 server 提供的工具列表，工具以 `mcp__server-name__tool-name` 格式可用。

### 8.3 关闭

会话结束时自动断开连接、停止子进程。

### 8.4 超时

- 默认启动超时 30 秒
- 可通过 `MCP_TIMEOUT` 环境变量调整（毫秒）：

```bash
MCP_TIMEOUT=60000 claude
```

## 9. 最佳实践

### 9.1 本地工具用 stdio

```json
{
  "mcpServers": {
    "local-db": {
      "command": "npx",
      "args": ["-y", "mcp-server-sqlite", "./data.db"]
    }
  }
}
```

### 9.2 云服务用 http/sse

```json
{
  "mcpServers": {
    "asana": {
      "type": "sse",
      "url": "https://mcp.asana.com/sse"
    }
  }
}
```

### 9.3 敏感信息用环境变量

```json
{
  "mcpServers": {
    "api": {
      "type": "http",
      "url": "https://api.example.com/mcp",
      "headers": {
        "Authorization": "Bearer ${API_TOKEN}"
      }
    }
  }
}
```

不要在 `.mcp.json` 中硬编码 token。提交到 git 的 `.mcp.json` 应该使用 `${VAR}` 引用。

### 9.4 插件路径用 CLAUDE_PLUGIN_ROOT

```json
{
  "mcpServers": {
    "my-server": {
      "command": "${CLAUDE_PLUGIN_ROOT}/servers/my-server",
      "env": {
        "CONFIG": "${CLAUDE_PLUGIN_ROOT}/config.json"
      }
    }
  }
}
```

### 9.5 首次使用需要审批

项目范围的 `.mcp.json` 首次被发现时，Claude Code 会要求用户确认。这是安全措施，防止恶意仓库自动启动 MCP server。

## 10. 调试技巧

### 10.1 查看 MCP 状态

```text
/mcp
```

### 10.2 测试 stdio server

直接在终端运行 server 命令，确认它能正常启动：

```bash
npx -y @playwright/mcp@latest
# server 启动后等待输入 → 说明正常
```

### 10.3 检查配置位置

```bash
claude mcp get my-server
# 显示 server 定义在哪个 scope
```

### 10.4 常见问题

- **Server 不出现**：确认配置文件路径正确（`~/.claude.json` 或 `.mcp.json`）
- **工具不加载**：可能是缺少环境变量（API key），运行 `/mcp` 查看状态
- **启动超时**：增大 `MCP_TIMEOUT`，首次运行 `npx` 下载包可能较慢
- **编辑 .mcp.json 后没生效**：重启 Claude Code（配置在会话启动时读取）

## 11. 本项目实例

GLM StatusLine 插件**没有使用 MCP**。插件直接通过 Node.js `http`/`https` 模块调用 GLM/Z.ai API，不需要通过 MCP server 中间层。

如果将来需要扩展，例如提供 MCP 工具让 Claude 直接查询用量，可以添加：

```json
{
  "mcpServers": {
    "glm-usage": {
      "command": "${CLAUDE_PLUGIN_ROOT}/servers/usage-server.js",
      "env": {
        "ANTHROPIC_AUTH_TOKEN": "${ANTHROPIC_AUTH_TOKEN}",
        "ANTHROPIC_BASE_URL": "${ANTHROPIC_BASE_URL}"
      }
    }
  }
}
```

这样 Claude 就可以直接使用 `mcp__glm-usage__query-quota` 等工具查询 GLM 用量。

## 参考资料

- [Claude Code 官方文档 - Connect Claude Code to tools via MCP](https://code.claude.com/docs/en/mcp.md)
- [Claude Code 官方文档 - Connect to MCP servers](https://code.claude.com/docs/en/mcp-quickstart.md)
- [Claude Code 官方文档 - Plugins reference](https://code.claude.com/docs/en/plugins-reference.md)
- [Claude Code GitHub - MCP Integration Skill](https://github.com/anthropics/claude-code/blob/main/plugins/plugin-dev/skills/mcp-integration/SKILL.md)
- [MCP 规范](https://spec.modelcontextprotocol.io/)

## 系列导航

| ← 上一篇 | 下一篇 → |
| --- | --- |
| [第四篇：Hooks](04-Hooks.md) | [第六篇：LSP](06-LSP.md) |
