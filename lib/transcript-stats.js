// 严格模式：强制变量声明、把静默错误转为显式抛错，文件顶层统一开启
'use strict';

// 文件读写共享库：transcript JSONL 遍历器（内置 message.id 去重协议）
const { forEachTranscriptLine } = require('./file-io');

// 从 usage 对象算 token 总量：各计数键求和（输入+输出+缓存读写都算真实消耗）
function tokenTotalFromUsage(usage) {
  // 非对象 → 0
  if (!usage || typeof usage !== 'object') return 0;
  // 计数候选键
  const keys = [
    'input_tokens',
    'output_tokens',
    'cache_creation_input_tokens',
    'cache_read_input_tokens',
    'inputTokens',
    'outputTokens',
    'cacheCreationInputTokens',
    'cacheReadInputTokens',
    'promptTokens',
    'completionTokens',
    'prompt_tokens',
    'completion_tokens',
  ];
  // 累计器
  let total = 0;
  // 遍历候选键
  for (const key of keys) {
    // 取值
    const value = Number(usage[key]);
    // 有效正值才累加
    if (Number.isFinite(value) && value > 0) total += value;
  }
  // 返回总量
  return total;
}

// 从 transcript 行对象算 token 总量：三个常见 usage 挂载位置都试
function tokenTotalFromObject(obj) {
  // 非对象 → 0
  if (!obj || typeof obj !== 'object') return 0;
  // 累计器
  let total = 0;
  // 顶层 usage
  if (obj.usage && typeof obj.usage === 'object') total += tokenTotalFromUsage(obj.usage);
  // message.usage（assistant 消息行）
  if (obj.message?.usage && typeof obj.message.usage === 'object') total += tokenTotalFromUsage(obj.message.usage);
  // response.usage（部分封装结构）
  if (obj.response?.usage && typeof obj.response.usage === 'object') total += tokenTotalFromUsage(obj.response.usage);
  // 返回总量
  return total;
}

// 从 usage 对象只取输出 token（速度专用）
function outputTokensFromUsage(usage) {
  // 非对象 → 0
  if (!usage || typeof usage !== 'object') return 0;
  // 输出 token 候选键
  const keys = ['output_tokens', 'outputTokens', 'completion_tokens', 'completionTokens'];
  // 累计器
  let total = 0;
  // 遍历候选键
  for (const key of keys) {
    // 取值
    const value = Number(usage[key]);
    // 有效正值累加
    if (Number.isFinite(value) && value > 0) total += value;
  }
  // 返回
  return total;
}

// 从行对象提取输出 token（同样三个挂载位置）
function outputTokensFromObject(obj) {
  if (!obj || typeof obj !== 'object') return 0;
  // 累计器
  let total = 0;
  // 顶层 usage
  if (obj.usage && typeof obj.usage === 'object') total += outputTokensFromUsage(obj.usage);
  // message.usage
  if (obj.message?.usage && typeof obj.message.usage === 'object') {
    total += outputTokensFromUsage(obj.message.usage);
  }
  // response.usage
  if (obj.response?.usage && typeof obj.response.usage === 'object') {
    total += outputTokensFromUsage(obj.response.usage);
  }
  // 返回
  return total;
}

// 会话 token 统计：读 transcript JSONL 累加全部 token，可按时间窗过滤
//（文件读取/逐行解析/message.id 去重的公共骨架在 lib/file-io.js 的 forEachTranscriptLine —— 这里只是累加器）
function readJsonlTokenStats(filePath, options = {}) {
  // 时间窗参数（默认全量）
  const { startMs = -Infinity, endMs = Infinity } = options;
  // 累计器（读失败时 visit 一次都不调用 → 保持 0，与原"文件级错误归 0"一致）
  let total = 0;
  // 遍历每行：时间窗过滤 → 去重跳过 → 提取累加
  //（Dedup by message.id：一条消息每个内容块各占一行且都带完整 usage，不去重会放大 ~N 倍 —— 去重协议见 lib/file-io.js）
  forEachTranscriptLine(filePath, (obj, ts, line) => {
    // 时间窗之外的行不计（不计入 → 也不登记 id，与原实现一致）
    if (ts < startMs || ts >= endMs) return;
    // 同 message.id 已计过 → 跳过（关键去重）
    if (line.duplicate) return;
    // 本行 token 数
    const add = tokenTotalFromObject(obj);
    // 有有效数值才累计；且只有真正计入才登记消息 ID（add=0 的行不占用去重名额，同原实现）
    if (add > 0) {
      line.countOnce();
      total += add;
    }
  });
  // 返回总量
  return total;
}

// One pass over the transcript JSONL: sum output tokens and capture the most-recent line
// timestamp. Mirrors readJsonlTokenStats but isolates output_tokens (for speed) and returns the
// last-line timestamp (a fallback denominator source when cost.total_api_duration_ms is absent).
// 一趟遍历 transcript：累计输出 token + 记录最后一行时间戳（速度专用，见上方英文注释）
function readJsonlOutputStats(filePath) {
  // 累计输出 token（读失败保持 0）
  let outputTokens = 0;
  // 最后一行时间戳（初始未知）
  let lastLineMs = null;
  // 遍历每行：先刷新"最后一行时间"（对每行含重复行 —— 同消息各内容块时间戳可能差数秒，必须在去重跳过之前）→ 去重 → 提取累加
  // Claude Code writes one transcript line per content block (thinking/text/tool_use/...) and
  // attaches the FULL message.usage to each, so a single message would be summed N times. Count
  // its usage once per message.id (protocol in lib/file-io.js). Lines without a message.id
  // (e.g. test fixtures) count as-is. 实测不去重会放大约 3 倍。
  forEachTranscriptLine(filePath, (obj, ts, line) => {
    // 刷新"最后一行时间"（取更大者）
    if (lastLineMs === null || ts > lastLineMs) lastLineMs = ts;
    // 同 message.id 已计过 → 跳过（关键去重）
    if (line.duplicate) return;
    // 本行输出 token
    const add = outputTokensFromObject(obj);
    // 有效正值才累计；且只有真正计入才登记消息 ID（同原实现）
    if (add > 0) {
      line.countOnce();
      outputTokens += add;
    }
  });
  // 返回统计（读失败 → 全零）
  return { outputTokens, lastLineMs };
}

// 导出本模块全部公共 API（消费者：bin/glm-statusline.js、lib/quota-parsing.js、lib/session-metrics.js）
module.exports = {
  // 从 usage 对象算 token 总量（quota-parsing 的 model-usage 提取也用）
  tokenTotalFromUsage,
  // 从 transcript 行对象算 token 总量
  tokenTotalFromObject,
  // 从 usage 对象只取输出 token
  outputTokensFromUsage,
  // 从行对象提取输出 token
  outputTokensFromObject,
  // 会话 token 统计（可按时间窗过滤）
  readJsonlTokenStats,
  // 输出 token 统计 + 最后一行时间戳（速度专用）
  readJsonlOutputStats,
};
