# Claude Code Monitors 详解

> 学习笔记系列 · 第九篇
>
> 本篇深入讲解 Claude Code Monitors：后台监听进程的配置方式、输出传递、触发条件和最佳实践。

## 目录

- [1. Monitor 是什么](#1-monitor-是什么)
- [2. 配置格式](#2-配置格式)
- [3. 输出传递机制](#3-输出传递机制)
- [4. 触发条件](#4-触发条件)
- [5. 插件中的 Monitors](#5-插件中的-monitors)
- [6. Monitor 工具（非插件）](#6-monitor-工具非插件)
- [7. 实战示例](#7-实战示例)
- [8. 安全考虑](#8-安全考虑)
- [9. 最佳实践](#9-最佳实践)
- [10. 本项目实例](#10-本项目实例)

---

## 1. Monitor 是什么

Monitor 是一个**后台长驻进程**，持续运行并将输出发送给 Claude。它可以让 Claude 实时感知外部世界的变化。

```text
Monitor 进程（后台运行）
  │
  ├── 持续监听文件变化 → 输出变更通知
  ├── 持续轮询 API → 输出最新状态
  ├── 持续观察日志 → 输出异常告警
  │
  └── stdout 输出 → Claude Code 接收 → 作为通知展示
```

Monitor 的特点：

- **后台运行**：不阻塞主会话
- **持续输出**：stdout 的每一行都是一条消息
- **实时感知**：Claude 不需要主动查询就能知道变化

典型应用场景：

- 监听文件变更并通知 Claude
- 轮询 API 获取最新状态
- 监控构建进度
- 追踪测试结果

## 2. 配置格式

Monitor 配置放在 `monitors/monitors.json` 中。

### 基本结构

```json
{
  "monitors": [
    {
      "name": "my-monitor",
      "command": "my-monitor-script.sh",
      "args": [],
      "when": "always"
    }
  ]
}
```

### 字段说明

#### 必需字段

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `name` | string | Monitor 标识名 |
| `command` | string | 要执行的后台命令 |

#### 可选字段

| 字段 | 类型 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `args` | array | `[]` | 命令参数 |
| `when` | string | `"always"` | 触发条件 |
| `env` | object | `{}` | 传给进程的环境变量 |
| `description` | string | `""` | 描述文字 |

### when 字段详解

| 值 | 含义 |
| --- | --- |
| `"always"` | 插件启用后始终运行 |
| `"on-skill-invoke"` | 只在关联的 skill 被调用时运行 |

### 完整示例

```json
{
  "monitors": [
    {
      "name": "build-watcher",
      "command": "fswatch",
      "args": ["-r", "src/"],
      "when": "always",
      "description": "Watches source files for changes"
    },
    {
      "name": "api-health",
      "command": "${CLAUDE_PLUGIN_ROOT}/scripts/health-check.sh",
      "when": "on-skill-invoke",
      "env": {
        "API_URL": "https://api.example.com/health"
      }
    }
  ]
}
```

## 3. 输出传递机制

### stdout 行 → 通知

Monitor 进程的 **stdout 每一行**都被当作一条消息，传递给 Claude Code：

```text
Monitor 进程 stdout：
  File changed: src/index.ts       ← 第 1 行 = 第 1 条通知
  File changed: src/utils.ts       ← 第 2 行 = 第 2 条通知
  Build complete: 2s               ← 第 3 行 = 第 3 条通知
```

### 批量合并（200ms）

Claude Code 会以约 **200ms** 的间隔批量合并 stdout 行，避免短时间大量通知：

```text
Monitor 在 100ms 内输出 5 行
  ↓
200ms 批量窗口
  ↓
合并为 1 条通知发送给 Claude
```

### 空行处理

空行被忽略，不会产生通知。

### stderr 处理

stderr 输出不会传递给 Claude，但会出现在 debug 日志中。

## 4. 触发条件

### always

```json
{
  "name": "file-watcher",
  "command": "fswatch src/",
  "when": "always"
}
```

- 插件启用后立即启动
- 会话期间持续运行
- 会话结束时停止

### on-skill-invoke

```json
{
  "name": "deploy-monitor",
  "command": "${CLAUDE_PLUGIN_ROOT}/scripts/deploy-watch.sh",
  "when": "on-skill-invoke"
}
```

- 只在关联的 skill 被调用时启动
- skill 结束后停止
- 适合短期监控任务

## 5. 插件中的 Monitors

### 目录结构

```text
my-plugin/
├── monitors/
│   └── monitors.json
├── scripts/
│   └── my-monitor.sh
└── .claude-plugin/
    └── plugin.json
```

### 在 plugin.json 中配置

Monitors 目前是 experimental 功能：

```json
{
  "name": "my-plugin",
  "experimental": {
    "monitors": "./monitors/monitors.json"
  }
}
```

或直接内联：

```json
{
  "name": "my-plugin",
  "experimental": {
    "monitors": {
      "monitors": [
        {
          "name": "my-monitor",
          "command": "${CLAUDE_PLUGIN_ROOT}/scripts/watch.sh",
          "when": "always"
        }
      ]
    }
  }
}
```

### 环境变量

Monitor 命令支持这些环境变量：

| 变量 | 说明 |
| --- | --- |
| `${CLAUDE_PLUGIN_ROOT}` | 插件根目录 |
| `${CLAUDE_PLUGIN_DATA}` | 插件持久数据目录 |
| `${CLAUDE_PROJECT_DIR}` | 当前项目根目录 |

## 6. Monitor 工具（非插件）

即使不通过插件，也可以在 `~/.claude/settings.json` 中配置 monitor：

```json
{
  "monitors": [
    {
      "name": "git-status",
      "command": "while true; do git status --porcelain | head -5; sleep 60; done",
      "when": "always"
    }
  ]
}
```

这种方式不需要创建插件，适合个人使用。

## 7. 实战示例

### 7.1 文件变更监听

```json
{
  "monitors": [
    {
      "name": "file-changes",
      "command": "fswatch",
      "args": ["-r", "--event", "Updated", "src/"],
      "when": "always",
      "description": "Notifies when source files change"
    }
  ]
}
```

### 7.2 API 健康检查

```json
{
  "monitors": [
    {
      "name": "api-health",
      "command": "while true; do curl -s https://api.example.com/health | jq -r '.status'; sleep 30; done",
      "when": "always",
      "env": {
        "HEALTH_THRESHOLD": "200"
      }
    }
  ]
}
```

### 7.3 构建进度

```json
{
  "monitors": [
    {
      "name": "build-progress",
      "command": "${CLAUDE_PLUGIN_ROOT}/scripts/build-watch.sh",
      "when": "on-skill-invoke"
    }
  ]
}
```

### 7.4 日志异常检测

```json
{
  "monitors": [
    {
      "name": "error-detector",
      "command": "tail -f logs/app.log | grep --line-buffered 'ERROR'",
      "when": "always",
      "description": "Reports errors from application logs"
    }
  ]
}
```

## 8. 安全考虑

### 8.1 插件 Monitor 的限制

- Monitor 命令在沙箱中运行，权限受限
- 不能访问 Claude Code 的内部状态
- 输出经过清理后才传递

### 8.2 资源消耗

Monitor 是持续运行的进程，注意：

- 避免高频轮询（至少间隔 10 秒以上）
- 控制输出频率（不要每秒输出几十行）
- 在 `on-skill-invoke` 模式下确保进程会正常退出

### 8.3 输出内容

Monitor 输出会被 Claude 看到，注意：

- 不要输出敏感信息（API key、密码）
- 输出应该简洁、有意义
- 每行控制在 200 字符以内

## 9. 最佳实践

### 9.1 使用 on-skill-invoke 控制生命周期

```json
// 好：只在需要时运行
{
  "name": "deploy-watch",
  "when": "on-skill-invoke"
}

// 小心：always 会一直运行
{
  "name": "deploy-watch",
  "when": "always"
}
```

### 9.2 控制输出频率

```bash
# 好：间隔输出
while true; do
  STATUS=$(curl -s https://api.example.com/health)
  echo "$STATUS"
  sleep 30
done

# 不好：高频输出
tail -f /var/log/everything.log
```

### 9.3 使用 ${CLAUDE_PLUGIN_ROOT} 引用脚本

```json
{
  "command": "${CLAUDE_PLUGIN_ROOT}/scripts/watch.sh"
}
```

不要硬编码绝对路径。

### 9.4 Monitor 脚本要优雅退出

```bash
#!/bin/bash
# 捕获退出信号
trap 'exit 0' SIGTERM SIGINT

while true; do
  echo "$(date): Status OK"
  sleep 60
done
```

## 10. 本项目实例

GLM StatusLine 插件**没有使用 Monitor**。状态栏通过 `statusLine.command` 机制工作——Claude Code 定期调用 `glm-statusline.js`，通过 stdin/stdout 交互。这是一种"拉"模式，而 Monitor 是"推"模式。

如果想让 Claude 主动感知 GLM/Z.ai 配额变化（比如额度快耗尽时主动提醒），可以添加一个 monitor：

```json
{
  "monitors": [
    {
      "name": "quota-monitor",
      "command": "${CLAUDE_PLUGIN_ROOT}/scripts/quota-watch.sh",
      "when": "always",
      "env": {
        "ANTHROPIC_AUTH_TOKEN": "${ANTHROPIC_AUTH_TOKEN}",
        "ANTHROPIC_BASE_URL": "${ANTHROPIC_BASE_URL}"
      }
    }
  ]
}
```

quota-watch.sh：

```bash
#!/bin/bash
trap 'exit 0' SIGTERM SIGINT

while true; do
  QUOTA=$(glm-statusline.js --raw-quota 2>/dev/null)
  PERCENT=$(echo "$QUOTA" | jq -r '.fiveHourPercent // 0')
  if [ "$PERCENT" -gt 90 ]; then
    echo "⚠️ GLM 5H quota at ${PERCENT}% - running low!"
  fi
  sleep 300
done
```

## 参考资料

- [Claude Code 官方文档 - Plugins reference](https://code.claude.com/docs/en/plugins-reference.md)
- [Claude Code 官方文档 - Monitors](https://code.claude.com/docs/en/monitors.md)

## 系列导航

| ← 上一篇 | 下一篇 → |
| --- | --- |
| [第八篇：Themes](08-Themes.md) | [第十篇：Bin](10-Bin.md) |
