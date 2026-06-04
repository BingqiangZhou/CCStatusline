# Claude Code 底部显示 GLM Coding Plan 用量：单文件状态栏笔记

## 1. 目标

在 Claude Code 输入区域下面显示两行状态栏：

```text
GLM Lite │ 5H ██░░░░░░ 22% │ MCP ███░░░░░ 28% │ Context █████░░░ 68% (GLM-5 / 200K)
14:47 ｜ Sess:160.0K │ Day:42.8M │ Mon:979.2M
```

第一行显示：

- 套餐名，例如 `GLM Lite`
- 5 小时用量，例如 `5H ██░░░░░░ 22%`
- MCP / Tool 用量，例如 `MCP ███░░░░░ 28%`
- 当前上下文占用，例如 `Context █████░░░ 68%`
- 当前实际映射到的 GLM 模型名和最大上下文，例如 `(GLM-5 / 200K)`

第二行显示：

- 当前时间
- 当前会话 token 消耗：`Sess`
- 当天 token 消耗：`Day`
- 最近 30 天 token 消耗：`Mon`

## 2. Claude Code 状态栏的实现原理

Claude Code 支持 `statusLine` 配置。它的机制是：

```text
Claude Code
  ↓ 把当前会话信息通过 stdin 传给脚本
本地脚本 glm-statusline.js
  ↓ 读取 stdin / settings.json / API / 本地 transcript
console.log 输出两行文本
  ↓
Claude Code 显示在输入区域下面
```

所以底部状态栏并不是 GLM 或 Claude Code 自动生成的，而是由 `settings.json` 里的 `statusLine.command` 调用一个本地命令来生成。

## 3. 为什么采用单文件实现

之前几个状态栏插件大体都是类似思路：

- 读取 Claude Code 传入的 session JSON
- 读取 `~/.claude/settings.json` 里的环境变量
- 请求远程用量接口
- 扫描本地 Claude Code transcript 统计 token
- 格式化为进度条和文字

为了降低使用成本，这里合并成一个文件：

```text
~/.claude/glm-statusline.js
```

这样不需要 npm 包、不需要插件市场、不需要额外安装依赖，只要 Node.js 可用即可。

## 4. 配置方式

把 `glm-statusline.js` 放到：

```bash
~/.claude/glm-statusline.js
```

赋予执行权限：

```bash
chmod +x ~/.claude/glm-statusline.js
```

然后修改 `~/.claude/settings.json`：

```json
{
  "env": {
    "ANTHROPIC_AUTH_TOKEN": "你的 GLM / Z.ai API Key",
    "ANTHROPIC_BASE_URL": "https://open.bigmodel.cn/api/anthropic",

    "ANTHROPIC_DEFAULT_OPUS_MODEL": "glm-5.1",
    "ANTHROPIC_DEFAULT_SONNET_MODEL": "glm-5.1",
    "ANTHROPIC_DEFAULT_HAIKU_MODEL": "glm-4.5-air"
  },
  "statusLine": {
    "type": "command",
    "command": "node ~/.claude/glm-statusline.js",
    "refreshInterval": 5,
    "padding": 0
  }
}
```

如果你使用国际站 Z.ai，可以把 base url 改成：

```json
"ANTHROPIC_BASE_URL": "https://api.z.ai/api/anthropic"
```

Windows 可以写成：

```json
"command": "node C:/Users/你的用户名/.claude/glm-statusline.js"
```

## 5. 套餐名如何获取

新版脚本会优先从 GLM quota API 的返回结果里自动查找套餐字段。

它会递归查找这些字段：

```text
planName
packageName
packageTitle
subscriptionName
productName
levelName
plan
package
level
tier
skuName
sku
edition
```

如果 API 返回：

```json
{
  "data": {
    "planName": "GLM Lite"
  }
}
```

状态栏就会显示：

```text
GLM Lite
```

如果返回的是：

```json
{
  "data": {
    "level": "lite"
  }
}
```

脚本会格式化成：

```text
GLM Lite
```

但是要注意：套餐名字段不一定在每个账号、每个接口返回中都稳定存在。因此脚本的优先级是：

```text
GLM quota API 中的套餐字段
  ↓ 没有
GLM_STATUSLINE_PLAN 环境变量
  ↓ 没有
GLM
```

如果你发现 API 不返回套餐名，可以手动加一个兜底：

```json
{
  "env": {
    "GLM_STATUSLINE_PLAN": "GLM Lite"
  }
}
```

## 6. 模型名如何获取

模型名不建议手动写死，而是应该跟 Claude Code 当前选择的模型联动。

Claude Code 当前可能显示的是：

```text
Opus
Sonnet
Haiku
```

但是你使用的是 GLM 的 Anthropic-compatible 接口，所以真正调用的模型由这些环境变量决定：

```json
{
  "env": {
    "ANTHROPIC_DEFAULT_OPUS_MODEL": "glm-5.1",
    "ANTHROPIC_DEFAULT_SONNET_MODEL": "glm-5.1",
    "ANTHROPIC_DEFAULT_HAIKU_MODEL": "glm-4.5-air"
  }
}
```

脚本的模型名映射逻辑是：

```text
Claude Code 当前模型名包含 Opus
  → 读取 ANTHROPIC_DEFAULT_OPUS_MODEL

Claude Code 当前模型名包含 Sonnet
  → 读取 ANTHROPIC_DEFAULT_SONNET_MODEL

Claude Code 当前模型名包含 Haiku
  → 读取 ANTHROPIC_DEFAULT_HAIKU_MODEL
```

然后格式化显示，例如：

```text
glm-5.1      → GLM-5.1
glm-4.5-air  → GLM-4.5-Air
```

最终显示类似：

```text
(GLM-5.1 / 200K)
```

## 7. 5H 和 MCP 用量如何获取

脚本会请求：

```text
/api/monitor/usage/quota/limit
```

完整地址由 `ANTHROPIC_BASE_URL` 推导：

```text
https://open.bigmodel.cn/api/anthropic
  ↓
https://open.bigmodel.cn/api/monitor/usage/quota/limit
```

它会在返回结果中查找：

- 包含 `TOKEN / TOKENS / 5H / TOKENS_LIMIT / MODEL` 等关键词的限制项，作为 `5H` 用量
- 包含 `MCP / TOOL / TIME_LIMIT` 等关键词的限制项，作为 `MCP` 用量

如果 API 请求失败，会使用缓存；如果没有缓存，就显示 0%。

## 8. Context 上下文如何获取

Context 优先读取 Claude Code 通过 stdin 传进来的字段，例如：

```text
context_window.used_percentage
context_window.context_window_size
```

如果 Claude Code 没有传入上下文字段，则使用当前 session transcript 的 token 数做一个兜底估算。

最大上下文默认是：

```text
200000 tokens
```

显示时格式化成：

```text
200K
```

也可以手动指定：

```json
{
  "env": {
    "GLM_STATUSLINE_CONTEXT_WINDOW": "200000"
  }
}
```

## 9. Sess / Day / Mon 如何统计

### Sess

`Sess` 读取当前 Claude Code 传入的：

```text
transcript_path
```

然后解析这个 JSONL 文件中的 token usage 字段，统计当前会话 token。

常见字段包括：

```text
input_tokens
output_tokens
cache_creation_input_tokens
cache_read_input_tokens
```

### Day / Mon

`Day` 和 `Mon` 优先尝试请求：

```text
/api/monitor/usage/model-usage
```

如果接口不可用，则回退到本地扫描：

```text
~/.claude/projects/**/*.jsonl
```

其中：

- `Day`：今天 0 点到现在
- `Mon`：最近 30 天

注意：本地扫描是兜底方案。如果你同时在 Claude Code 中混用 Claude、GLM、Kimi、Qwen 等多个 provider，本地统计可能会包含所有 Claude Code transcript，不一定是纯 GLM。

如果想强制只使用本地统计，可以配置：

```json
{
  "env": {
    "GLM_STATUSLINE_USAGE_SOURCE": "local"
  }
}
```

## 10. 缓存机制

为了避免每 5 秒都请求 API，脚本会缓存远程接口结果。

缓存文件：

```text
~/.claude/glm-statusline-cache.json
```

默认缓存时间：

```text
60 秒
```

虽然 `settings.json` 里可以写：

```json
"refreshInterval": 5
```

但实际 API 不会每 5 秒请求一次，而是优先读取 60 秒内的缓存。

如果要调整缓存时间，可以配置：

```json
{
  "env": {
    "GLM_STATUSLINE_CACHE_TTL_MS": "60000"
  }
}
```

## 11. 常见问题

### 1. 底部没有显示

先检查 Node.js：

```bash
node -v
```

再手动测试脚本：

```bash
node ~/.claude/glm-statusline.js
```

如果能输出两行，说明脚本本身正常。

### 2. 5H / MCP 一直是 0%

常见原因：

- `ANTHROPIC_AUTH_TOKEN` 没有配置
- `ANTHROPIC_BASE_URL` 配错
- 当前 API Key 无法访问 monitor usage 接口
- GLM quota API 返回结构发生变化
- 网络或代理导致请求失败

可以临时开启 debug：

```json
{
  "env": {
    "GLM_STATUSLINE_DEBUG": "1"
  }
}
```

### 3. 套餐名显示成 GLM

说明 quota API 返回中没有识别到套餐字段。

可以手动加：

```json
{
  "env": {
    "GLM_STATUSLINE_PLAN": "GLM Lite"
  }
}
```

### 4. 模型名不对

检查这几个环境变量：

```json
{
  "env": {
    "ANTHROPIC_DEFAULT_OPUS_MODEL": "glm-5.1",
    "ANTHROPIC_DEFAULT_SONNET_MODEL": "glm-5.1",
    "ANTHROPIC_DEFAULT_HAIKU_MODEL": "glm-4.5-air"
  }
}
```

如果 Claude Code 当前选的是 Opus，就会显示 `ANTHROPIC_DEFAULT_OPUS_MODEL` 对应的 GLM 模型。

## 12. 最终推荐配置

```json
{
  "env": {
    "ANTHROPIC_AUTH_TOKEN": "你的 GLM / Z.ai API Key",
    "ANTHROPIC_BASE_URL": "https://open.bigmodel.cn/api/anthropic",

    "ANTHROPIC_DEFAULT_OPUS_MODEL": "glm-5.1",
    "ANTHROPIC_DEFAULT_SONNET_MODEL": "glm-5.1",
    "ANTHROPIC_DEFAULT_HAIKU_MODEL": "glm-4.5-air",

    "GLM_STATUSLINE_CONTEXT_WINDOW": "200000"
  },
  "statusLine": {
    "type": "command",
    "command": "node ~/.claude/glm-statusline.js",
    "refreshInterval": 5,
    "padding": 0
  }
}
```

## 13. 总结

这套实现的核心是：

```text
一个文件：~/.claude/glm-statusline.js
一个配置：settings.json 里的 statusLine.command
两行输出：套餐 / 5H / MCP / Context + 时间 / Sess / Day / Mon
```

它尽量做到：

- 套餐名优先从 API 获取
- 模型名跟随 Claude Code 当前 Opus / Sonnet / Haiku 选择自动映射
- 5H / MCP 优先从 GLM quota API 获取
- Session token 从当前 transcript 获取
- Day / Mon 优先 API，失败后本地扫描
- 只有一个 JS 文件，方便复制、修改和维护
