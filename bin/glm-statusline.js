#!/usr/bin/env node
/**
 * glm-statusline.js
 *
 * A single-file Claude Code statusLine script for GLM Coding Plan.
 *
 * Output:
 *   5H ██░░░░░░ 22% @18:30 │ MCP █░░░░░░░ 8% @06-14 │ Session 160K │ Day 42.8M
 *
 * Details:
 *   glm-statusline.js --plan-details
 *
 * Usage in ~/.claude/settings.json:
 * {
 *   "env": {
 *     "ANTHROPIC_AUTH_TOKEN": "your-token",
 *     "ANTHROPIC_BASE_URL": "https://open.bigmodel.cn/api/anthropic",
 *     "ANTHROPIC_DEFAULT_OPUS_MODEL": "glm-5.1",
 *     "ANTHROPIC_DEFAULT_SONNET_MODEL": "glm-5.1",
 *     "ANTHROPIC_DEFAULT_HAIKU_MODEL": "glm-4.5-air"
 *   },
 *   "statusLine": {
 *     "type": "command",
 *     "command": "node ~/.claude/glm-statusline-launcher.js",
 *     "refreshInterval": 30,
 *     "padding": 0
 *   }
 * }
 */

// 严格模式：强制变量声明、静默错误显式抛错
'use strict';

// 路径处理：跨平台拼接等（文件读写已统一走 lib/file-io.js）
const path = require('path');
// 系统信息：定位用户主目录 HOME
const os = require('os');
// URL 构造器：解析 base URL（apiHostLabel 用；网络传输已移入 lib/monitor-api.js）
const { URL } = require('url');
// 字段定义库：全部字段表 DISPLAY_FIELDS（未配置时默认全显）、分组 groupDisplay、display 清洗+回退 displayOrDefault
const { DISPLAY_FIELDS, groupDisplay, displayOrDefault } = require('../lib/display-fields');
// 文件读写共享库（与安装器共用）：安全读 JSON、配置路径、调试日志
const {
  // 调试日志（读文件/API 出错时记 stderr，仅 GLM_STATUSLINE_DEBUG=1 可见）
  debugLog,
  // "~" 路径展开（transcript_path 等处仍直接使用）
  expandHome,
  // 通用 JSON 读取（吞错返回 null —— 经下方 readJsonSafe 包装记 debugLog）
  readJsonFile,
  // 配置文件路径解析（env 覆盖 → 默认 + ~ 展开）
  configFilePath,
} = require('../lib/file-io');
// transcript 统计库：两个 JSONL 读取器（速度与会话字段的数值来源）
const {
  // 会话 token 统计（session 字段）
  readJsonlTokenStats,
  // 输出 token 统计 + 最后一行时间戳（速度字段）
  readJsonlOutputStats,
} = require('../lib/transcript-stats');
// 共享缓存层：读/写（一次读一次写不变量的载体；TTL 判断与条目清理由 lib/session-metrics.js 使用）
const {
  // 读共享缓存（坏文件 → 空对象）
  loadCache,
  // 原子写共享缓存（吞写错误）
  saveCache,
} = require('../lib/status-cache');
// 兼容式解析库（纯函数）：监控 API 无固定 schema，按候选键递归归一 quota/limit 与 model-usage 响应
const {
  // 套餐名归一（渲染 plan 字段的兜底）
  normalizePlanName,
  // Title Case（plan-details 的 limit 标签）
  titleCase,
} = require('../lib/quota-parsing');
// 监控 API 客户端：配额/用量抓取（60s 缓存 + 多级回退）
const {
  // 抓配额 API
  fetchQuota,
  // 抓 day/month token 用量 API
  fetchModelUsage,
  // base URL 归一（--plan-details 直接用）
  normalizeBaseRoot,
} = require('../lib/monitor-api');
// 模型名映射库：Claude 模型名 → GLM 模型名 + 努力档位（纯函数，env 经参数传入）
const {
  // 推理努力档位（effort 字段渲染）
  getEffortLevel,
  // Claude → GLM 模型名映射（model 字段渲染）
  mapClaudeModelToGlm,
} = require('../lib/model-mapping');
// 会话指标库：上下文百分比保持（防闪烁）+ 输出速度解析（增量法/锚定法，全部不变量随迁）
const {
  // 上下文百分比解析（context 字段）
  resolveContextPercent,
  // 输出速度解析（speed 字段）
  resolveSpeed,
} = require('../lib/session-metrics');
// 渲染原语库（下面逐项解构引入）
const {
  // 相对时间文本（"5m ago"）—— 缓存年龄展示用
  formatAge,
  // 时间戳 → "YYYY-MM-DD HH:mm"（plan-details 的长重置时间）
  formatLocalDateTime,
  // 任意形态重置时间 → "HH:mm"（5H 重置时刻）
  formatResetHHmm,
  // 任意形态重置时间 → "MM-DD"（MCP 重置日）
  formatResetMMDD,
  // 时间戳 → "HH:mm"
  formatTimeHHmm,
  // 速度文本（<1 或未知 → "--"）
  formatSpeed,
  // token 数 → "42.8M" 式缩写
  formatTokens,
  // 各形态时间 → 毫秒时间戳（失败为 null）
  parseResetTime,
  // 渲染 "██░░░░ 42%" 进度条
  renderBar,
  // 相邻行宽度够时把多行段数组合并成一行
  mergeRows,
  // 按终端宽度自动换行拼接段
  wrapSegments,
} = require('../lib/statusline-format');

// 用户主目录：所有默认路径的根
const HOME = os.homedir();
// 安全读 JSON：不存在/解析失败一律返回 null（状态栏绝不能因读文件抛错）
//（底层是 lib/file-io.js 的 readJsonFile —— 这里包装出"出错记 debugLog"的调用形态）
function readJsonSafe(filePath) {
  return readJsonFile(filePath, { onError: (err) => debugLog(`cannot parse JSON file ${filePath}`, err) });
}

// 读取并归一化状态栏配置：display 字段列表 + 最大宽度
//（布局已统一为分组多行 + 自动合并；配置文件里残留的 layout 键会被静默忽略）
function readStatusConfig(env = process.env) {
  // 配置文件路径（env 覆盖 → 默认路径，含 ~ 展开；解析逻辑在 lib/file-io.js）
  const configPath = configFilePath(env);
  // 读配置 JSON（失败得到空对象）
  const fileConfig = readJsonSafe(configPath) || {};
  // display 清洗 + 未配置回退全字段（逻辑在 lib/display-fields.js）
  const display = displayOrDefault(fileConfig.display);
  // 读终端最大宽度
  const maxWidth = readMaxWidth(env);

  // 返回归一化后的配置对象
  return {
    // 配置文件实际路径（调试用）
    configPath,
    // 要显示的字段列表（已清洗/去重）
    display,
    // 换行宽度（0 表示不主动折行、也不合并）
    maxWidth,
  };
}

// 读终端宽度（换行用）
function readMaxWidth(env) {
  // 优先级：COLUMNS 环境变量 → stdout 实测列数 → 80 兜底
  const raw = env.COLUMNS ?? process.stdout.columns ?? 80;
  // 转成数字
  const value = Number(raw);
  // 非法或非正数 → 0（表示"不折行"）
  if (!Number.isFinite(value) || value <= 0) return 0;
  // 下限 20 列：避免极端小宽度把每一段都拆成一行
  return Math.max(20, Math.round(value));
}

// 合并三层 settings 的 env —— 状态栏在任何项目目录都能拿到凭据/端点的关键：用户级 → 项目级 → 项目本地级 → process.env
function mergeEnvFromSettings(sessionContext) {
  // 确定项目目录：优先 stdin 会话上下文的 workspace.current_dir，其次 cwd，最后进程 cwd
  const currentDir =
    sessionContext?.workspace?.current_dir ||
    sessionContext?.cwd ||
    process.cwd();

  // 三层 settings 文件路径（按优先级从低到高排列，后读的覆盖先读的）
  const files = [
    // 第 1 层：用户全局 settings（凭据通常配在这里）
    path.join(HOME, '.claude', 'settings.json'),
    // 第 2 层：当前项目 .claude/settings.json
    path.join(currentDir, '.claude', 'settings.json'),
    // 第 3 层：当前项目 .claude/settings.local.json（个人覆盖，不进 git）
    path.join(currentDir, '.claude', 'settings.local.json'),
  ];

  // 合并结果容器
  const merged = {};
  // 逐层读取合并
  for (const file of files) {
    // 读该层 settings JSON（读不到为 null）
    const json = readJsonSafe(file);
    // 只关心其中的 env 对象
    if (json && json.env && typeof json.env === 'object') {
      // 浅合并：后读的层覆盖先读的层
      Object.assign(merged, json.env);
    }
  }

  // 最后铺上当前进程环境变量 —— 显式 export 的值永远最高优先级
  return { ...merged, ...process.env };
}

function formatLimitLine(label, detail, options = {}) {
  // 百分比文本（读不到 → "unavailable"）
  const percent = Number.isFinite(detail?.percent) ? `${detail.percent}%` : 'unavailable';
  // 用量明细（分子/分母都有才显示）
  const usage =
    Number.isFinite(detail?.used) && Number.isFinite(detail?.total)
      ? ` · ${formatTokens(detail.used)} / ${formatTokens(detail.total)}`
      : '';
  // 重置时间（可选；longReset 用完整日期时间）
  const reset =
    Number.isFinite(detail?.resetTime) && options.showReset
      ? ` · resets ${options.longReset ? formatLocalDateTime(detail.resetTime) : formatTimeHHmm(detail.resetTime)}`
      : '';
  // 拼接完整行
  return `${label}: ${percent}${usage}${reset}`;
}

// 缓存条目年龄（毫秒）：直接读缓存文件 —— 不在渲染路径上，独立 loadCache 是有意的
function cacheAgeFor(key) {
  // 读缓存
  const cache = loadCache();
  // 取条目
  const entry = cache[key];
  // 有 ts → 现在减它；否则 NaN（显示 unknown）
  return entry && typeof entry.ts === 'number' ? Date.now() - entry.ts : NaN;
}

// API host 展示标签
function apiHostLabel(baseRoot) {
  // 没配置 → "not configured"
  if (!baseRoot) return 'not configured';
  // try 解析
  try {
    // 取 host
    return new URL(baseRoot).host;
  // catch
  } catch (_) {
    // 原样返回
    return baseRoot;
  }
}

// 是否 --plan-details 模式（看命令行参数）
function isPlanDetailsMode() {
  // 两种写法都接受
  return process.argv.includes('--plan-details') || process.argv.includes('plan-details');
}

// 是否 --preview 模式
function isPreviewMode() {
  // 两种写法
  return process.argv.includes('--preview') || process.argv.includes('preview');
}

// --plan-details 视图：套餐与全部额度的详细报告
async function renderPlanDetails() {
  // 合并 env（此模式没有会话上下文）
  const env = mergeEnvFromSettings({});
  // base URL
  const baseRoot = normalizeBaseRoot(env.ANTHROPIC_BASE_URL || '');
  // 配额缓存键（报告"缓存年龄"用）
  const quotaCacheKey = `quota:${baseRoot}`;
  // 并行抓三份数据
  const [quota, dayFromApi, monthFromApi] = await Promise.all([
    // 配额
    fetchQuota(env),
    // 当日用量
    fetchModelUsage(env, 'day'),
    // 30 天用量
    fetchModelUsage(env, 'month'),
  ]);

  // 报告标题行 + 套餐名行
  const lines = ['GLM Coding Plan', `Plan: ${quota.planName || normalizePlanName(env.GLM_STATUSLINE_PLAN) || 'GLM'}`];
  // 追加 5H 行
  lines.push(
    // （有明细用明细；否则用仅有的百分比+重置时间拼临时对象）
    formatLimitLine('5H', quota.fiveHourLimit || { percent: quota.fiveHourPercent, resetTime: quota.fiveHourResetTime }, { showReset: true })
  );
  // MCP 行（长重置格式）
  lines.push(formatLimitLine('MCP', quota.mcpLimit || { percent: quota.mcpPercent }, { showReset: true, longReset: true }));
  // 有 weekly 数据才显示
  if (quota.weeklyLimit || quota.weeklyPercent !== null) {
    // weekly 行
    lines.push(formatLimitLine('Weekly', quota.weeklyLimit || { percent: quota.weeklyPercent }, { showReset: true, longReset: true }));
  }
  // 其余额度逐行输出
  for (const detail of quota.otherLimits || []) {
    // 标签：明细名或 "Other"
    const label = detail.name ? titleCase(detail.name) : 'Other';
    // 输出行
    lines.push(formatLimitLine(label, detail, { showReset: true, longReset: true }));
  }
  // 当日汇总
  lines.push(`Day: ${formatTokens(dayFromApi ?? 0)} tokens`);
  // 30 天汇总
  lines.push(`30D: ${formatTokens(monthFromApi ?? 0)} tokens`);
  // API 状态行（host/密钥/缓存年龄；下方多行模板串内部不插注释）
  lines.push(
    `API: ${apiHostLabel(baseRoot)} · key ${env.ANTHROPIC_AUTH_TOKEN ? 'configured' : 'missing'} · cache ${formatAge(
      cacheAgeFor(quotaCacheKey)
    )}`
  );

  // 各行以换行连接
  return lines.join('\n');
}

// 读 stdin 的会话上下文 JSON（CC 就是这样把会话信息喂给状态栏的）
async function readStdinJson() {
  // 累积器
  let data = '';
  try {
    // 异步读完整个 stdin
    for await (const chunk of process.stdin) data += chunk;
    // 非空才解析；空输入给空对象
    return data.trim() ? JSON.parse(data) : {};
  // catch → 空对象（绝不抛错）
  } catch (_) {
    return {};
  }
}

// 状态栏渲染主流程（每次刷新走一遍）
async function renderStatusLine(sessionContext = {}) {
  // 合并三层 settings + process.env 的 env
  const env = mergeEnvFromSettings(sessionContext);
  // 读 display/宽度 配置
  const config = readStatusConfig(env);

  // transcript 路径（~ 展开；三种字段名兼容）
  const transcriptPath = expandHome(
    sessionContext?.transcript_path || sessionContext?.transcriptPath || sessionContext?.conversation_log_path || ''
  );
  // 读会话累计 token
  const sessionTokens = readJsonlTokenStats(transcriptPath);

  // One cache read + one cache write per render: each field mutates this shared object and flags it
  // dirty via markCache, then a single saveCache persists everything. This replaces the old pattern
  // where each field did its own loadCache+saveCache (~4 whole-file reads + ~4 whole-file writes per
  // render). The write window also shrinks ~4×, lowering the chance of racing another project's write.
  // 每渲染一次读缓存：本次渲染所有字段共用这个对象（见下方英文注释）
  const cache = loadCache();
  // 脏标记
  let cacheDirty = false;
  // mark 回调：字段变更只标脏，不立即写盘
  const markCache = () => {
    cacheDirty = true;
  };

  // 解析输出速度（内部自带 cost gate）
  const speedStats = resolveSpeed(sessionContext, transcriptPath, config, cache, markCache);

  // 抓配额（共享 cache/mark）
  const quota = await fetchQuota(env, cache, markCache);
  // 解析上下文百分比（防闪烁）
  const contextPercent = resolveContextPercent(sessionContext, sessionTokens, env, config, cache, markCache);
  // ?? 0 例外：5H 空读数显示 0%（空条）而不是 --
  const fiveHourPercent = quota.fiveHourPercent ?? 0;
  // 5H 重置时刻文本
  const fiveHourReset = formatResetHHmm(quota.fiveHourUpdateTime || quota.fiveHourResetTime);
  // 是否需要当日数据
  const needsDay = config.display.includes('day');
  // 是否需要 30 天数据
  const needsMonth = config.display.includes('30d');
  // 并行抓（不需要的用 null 占位 —— 成本闸门：不显示就不抓）
  const [dayTokens, monthTokens] = await Promise.all([
    // day 请求
    needsDay ? fetchModelUsage(env, 'day', cache, markCache) : Promise.resolve(null),
    // month 请求
    needsMonth ? fetchModelUsage(env, 'month', cache, markCache) : Promise.resolve(null),
  ]);

  // 整个渲染唯一的写缓存点：任何字段变过才写
  if (cacheDirty) saveCache(cache);

  // 套餐名（多级回退）
  const planName = quota.planName || normalizePlanName(env.GLM_STATUSLINE_PLAN) || 'GLM';
  // 努力档位
  const effortLevel = getEffortLevel(sessionContext, env);
  // 各字段的文本段（key 即 display 字段名）
  const fields = {
    // 套餐名
    plan: planName,
    // 5H 进度条 + 重置时刻
    '5h': `5H ${renderBar(fiveHourPercent)} @${fiveHourReset}`,
    // MCP 进度条 + 重置日期（?? 0 例外同上）
    mcp: `MCP ${renderBar(quota.mcpPercent ?? 0)} @${formatResetMMDD(quota.mcpLimit?.resetTime)}`,
    // 上下文进度条（null → --%）
    context: `Context ${renderBar(contextPercent)}`,
    // 映射后的模型名
    model: `Model ${mapClaudeModelToGlm(sessionContext, env)}`,
    // 努力档位（缺 → --）
    effort: `Effort ${effortLevel || '--'}`,
    // 会话 token
    session: `Session ${formatTokens(sessionTokens)}`,
    // 当日 token（?? 0 例外）
    day: `Day ${formatTokens(dayTokens ?? 0)}`,
    // 30 天 token（?? 0 例外）
    '30d': `30D ${formatTokens(monthTokens ?? 0)}`,
    // formatSpeed(null) -> '--'，未选中 speed 时（speedStats 为双 null）该段显示为占位。
    // 速度段是普通段，位于第 1 行与 model/effort 同行（不再有独立末行的特例）
    speed: `Speed ${formatSpeed(speedStats.current)} t/s · Avg ${formatSpeed(speedStats.average)} t/s`,
  };

  // 唯一布局：分组多行 + 自动合并。字段按类别分组（FIELD_GROUPS 行序 + 行内规范顺序），
  // 相邻行的总宽度能装进一行（≤ maxWidth）时由 mergeRows 自动合并成一行 —— 宽终端可
  // 能只有 2 行甚至 1 行；单行自身超宽时仍由 wrapSegments 在字段边界折行；空分组整行跳过
  const rows = groupDisplay(config.display)
    // 每组映射为该行的文本段数组（过滤掉空段）
    .map((keys) => keys.map((key) => fields[key]).filter(Boolean))
    // 空分组整行跳过
    .filter((segments) => segments.length);
  // Defensive fallback: nothing to render -> show every field (unreachable in practice).
  // 防御兜底：一组都没有（异常配置）→ 退回全部字段的单一行流
  if (!rows.length) {
    const segments = DISPLAY_FIELDS.map((key) => fields[key]).filter(Boolean);
    if (segments.length) rows.push(segments);
  }
  // 先把装得下的相邻行合并，再对每行做超宽折行（合并行必 ≤ 宽度不会内折）
  const lines = mergeRows(rows, config.maxWidth).map((segments) => wrapSegments(segments, config.maxWidth));
  // 多行连接返回
  return lines.join('\n');
}

// 主入口
async function main() {
  // --plan-details 模式
  if (isPlanDetailsMode()) {
    // 输出详细报告
    console.log(await renderPlanDetails());
    // 结束
    return;
  }

  // 读 stdin 会话上下文
  const sessionContext = await readStdinJson();
  // 渲染状态栏
  const output = await renderStatusLine(sessionContext);
  // preview 模式加前缀
  console.log(isPreviewMode() ? `Preview:\n${output}` : output);
}

// 兜底：任何未捕获异常都不能搞挂 Claude Code
main().catch((err) => {
  // Keep Claude Code usable even if the script crashes.
  // 取错误信息
  const msg = err && err.message ? err.message : String(err);
  // plan-details 模式的兜底文本
  if (isPlanDetailsMode()) {
    // 输出占位报告
    console.log('GLM Coding Plan\nPlan: GLM\n5H: unavailable\nMCP: unavailable\nDay: 0 tokens\n30D: 0 tokens\nAPI: not configured · key missing · cache unknown');
    // 结束
    return;
  }
  // 状态栏兜底行（保证永远有一行输出）
  console.log(`5H ${renderBar(0)} @--:-- │ MCP ${renderBar(0)} │ Session 0 │ Day 0`);
  // 调试模式才把错误打到 stderr
  if (process.env.GLM_STATUSLINE_DEBUG === '1') {
    // 输出错误信息
    console.error(msg);
  }
});
