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
// 共享缓存层：原子写、per-session 条目清理（一次读一次写不变量的载体）
const {
  // 读共享缓存（坏文件 → 空对象）
  loadCache,
  // 原子写共享缓存（吞写错误）
  saveCache,
  // 提交缓存变更（mark 标脏 / 无 mark 立即落盘）
  commitCache,
  // 清理过期 context: 条目
  pruneContextCache,
  // 清理过期 speed: 基线
  pruneSpeedCache,
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
// 渲染原语库（下面逐项解构引入）
const {
  // 百分比夹取到 [0,100] 整数
  clampPercent,
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
// 上下文窗口大小的兜底值：20 万 token
const DEFAULT_CONTEXT_WINDOW = 200000;

// Output-speed tuning. The status line is a fresh process each render, so speed is derived from a
// per-session cached baseline (see resolveSpeed). When idle the last measured value is held (it
// never decays to 0); SPEED_MIN_DENOM_S floors the denominator so a tiny ΔapiMs can't produce a
// multimillion tok/s spike.
// 输出速度分母下限（秒）：防止极小的 ΔapiMs 算出百万级 tok/s 的瞬时尖峰
const SPEED_MIN_DENOM_S = 0.1;

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

// 读上下文信息：使用百分比 + 窗口大小（多字段兼容，多级回退）
function getContextInfo(sessionContext, sessionTokens, env) {
  // context_window 节点（三种字段名兼容），兜底空对象
  const cw =
    sessionContext?.context_window ||
    sessionContext?.contextWindow ||
    sessionContext?.context ||
    {};

  // 窗口大小：候选字段 → env → 默认 20 万
  const max = Number(
    cw.context_window_size ??
      cw.contextWindowSize ??
      cw.max_tokens ??
      cw.maxTokens ??
      cw.total_tokens ??
      cw.totalTokens ??
      env.GLM_STATUSLINE_CONTEXT_WINDOW ??
      DEFAULT_CONTEXT_WINDOW
  );

  // 使用百分比：候选字段（读不到为 undefined → Number 后 NaN）
  let percent = Number(
    cw.used_percentage ??
      cw.usedPercentage ??
      cw.percentage ??
      cw.percent ??
      cw.usage_percentage ??
      cw.usagePercentage
  );

  // 已用 token 绝对值（部分版本提供）
  const used = Number(cw.used_tokens ?? cw.usedTokens ?? cw.current_tokens ?? cw.currentTokens);
  // 百分比读不到但有 used/max → 换算
  if (!Number.isFinite(percent) && Number.isFinite(used) && Number.isFinite(max) && max > 0) {
    // 赋值
    percent = (used / max) * 100;
  }
  // 再回退：用会话累计 token 估算（不精确但比空白强；要求 >0 —— 空转录是"没数据"不是"0%"）
  if (!Number.isFinite(percent) && Number.isFinite(sessionTokens) && sessionTokens > 0 && Number.isFinite(max) && max > 0) {
    // Fallback only. Session tokens are not identical to live context tokens, but this is better than blank.
    // Require sessionTokens > 0: an empty transcript means "no data to estimate", not "0% used".
    // 估算赋值
    percent = (sessionTokens / max) * 100;
  }

  // `percent: null` means "unknown" (e.g. used_percentage is null early in a session or
  // right after /compact). The caller decides how to render/hold it — never coerce to 0 here.
  // 返回结构：percent 读不到保持 null —— 未知由渲染层显示 --%，绝不在此强转 0
  return {
    // 有限才夹取返回，否则 null
    percent: Number.isFinite(percent) ? clampPercent(percent) : null,
    // 窗口大小无效 → 默认 20 万
    max: Number.isFinite(max) && max > 0 ? max : DEFAULT_CONTEXT_WINDOW,
  };
}

// Resolve the context percentage to display, holding the last known value for the session
// when Claude Code reports an unreliable reading so the bar never flashes to 0%. Two cases
// are treated as "no reliable reading this tick":
//   - `null`: Claude Code reports used_percentage null early in a session and after /compact.
//   - `0` while we already hold a real value: Claude Code sometimes emits a literal 0 during
//     session transitions (between turns, model switch). Real context is never 0 once a
//     session has produced tokens, and /clear starts a fresh session_id with no held value,
//     so holding the last known value is always safe here.
// The transient 0 is deliberately NOT written to the cache, so it can't poison later ticks.
// Only touches the cache when the context field is actually displayed.
// 上下文百分比解析（防闪烁核心）：本 tick 读数不可靠时，沿用该会话上次已知的百分比，让进度条不闪 0%
function resolveContextPercent(sessionContext, sessionTokens, env, config, cache, mark) {
  // 读原始上下文信息
  const info = getContextInfo(sessionContext, sessionTokens, env);
  // 不显示 context 字段 → 不碰缓存，原样返回（cost gate）
  if (!config?.display?.includes('context')) return info.percent;

  // 会话 ID（/clear 后是新 ID）
  const sessionId = String(sessionContext?.session_id || sessionContext?.sessionId || '');
  // 没有会话 ID → 没法做 per-session 保持
  if (!sessionId) return info.percent;

  // 自管理调用方没传 cache 时自己读
  cache = cache || loadCache();
  // 缓存键：context:<会话ID>
  const key = `context:${sessionId}`;
  // 已保存的保持值
  const held = cache[key];
  // 是否存在可用的历史保持值
  const hasHeldValue = held && typeof held.percent === 'number';
  // 瞬时 0 判定：本 tick 读到 0 但已持有 >0 的真值 → 是 CC 在会话切换时发出的假 0
  const isTransientZero = info.percent === 0 && hasHeldValue && held.percent > 0;

  // 两种"本 tick 无可靠读数"：null（会话早期 / compact 后）或上面的瞬时 0
  if (info.percent == null || isTransientZero) {
    // Hold the last known value so the bar stays steady — do not cache the transient 0.
    // 有历史值 → 保持显示（进度条不闪 0%）
    if (hasHeldValue) return held.percent;
    // 从未有过读数 → 返回 null（渲染为 --%，绝不是 0%）
    return null; // nothing known yet (first-ever tick) -> rendered as --%, never 0%
  }

  // Known this tick — remember it for future unknown ticks.
  // 本 tick 读数可靠 → 记入缓存供之后保持（瞬时 0 永远到不了这里，不会污染缓存）
  cache[key] = { percent: info.percent, ts: Date.now() };
  // 顺手清理过期条目
  pruneContextCache(cache);
  // 提交（共享 cache 只标脏）
  commitCache(cache, mark);
  // 返回本 tick 读数
  return info.percent;
}

// Resolve the output speed for the session: { current, average } in tokens/sec (null each ->
// rendered as '--'). Only runs when 'speed' is displayed (cost gate). Never coerces unknown to 0.
//
// current: derived from the delta of cumulative transcript output_tokens over the delta of
//   cost.total_api_duration_ms (real API time, which excludes idle between renders — idle can't
//   inflate the denominator). Falls back to the transcript-timestamp span, then wall-clock. The
//   per-session baseline persists in the cache (same read-hold-write pattern as
//   resolveContextPercent). On idle the last measured value is HELD (never decays to 0); it is
//   null only before the first real measurement.
//
// average: session throughput since the FIRST observed tick — (out - out0) / ((apiMs - api0)/1000),
//   where out0/api0 are seeded at this session_id's first tick (and re-seeded on a reset). Anchoring
//   both terms together makes foreign API time carried into the session by
//   cost.total_api_duration_ms (which /clear does NOT reset — it's a process-lifetime accumulator)
//   cancel, instead of depressing the average. Before the first delta exists (first tick / right
//   after a reset re-seed) it falls back to the absolute cumulative ratio out / (apiMs/1000) so the
//   segment never shows a bare '--'. null when cost is absent/0.
// 锚定平均速度：以会话首个 tick 为锚（out0/apiMs0）算增量比值，抵消 /clear 不清零的 API 时间累计（见上方英文注释）
function anchoredAverage(outputTokens, apiMs, prev) {
  // 缺锚点（旧缓存条目没有 out0/apiMs0）→ null，调用方退回绝对比值
  if (!prev || typeof prev.out0 !== 'number' || typeof prev.apiMs0 !== 'number') return null;
  // 输出 token 增量
  const dOut = outputTokens - prev.out0;
  // API 时间增量（ms；apiMs 缺失则 null）
  const dApiMs = apiMs != null ? apiMs - prev.apiMs0 : null;
  // 两个增量都有效 → 平均速度 = Δout / (ΔapiMs/1000)
  if (dOut > 0 && dApiMs != null && dApiMs > 0) return dOut / (dApiMs / 1000);
  // 否则 null（无增长或无时间基准）
  return null;
}

// 输出速度解析器：current 用增量法、average 用锚定法；仅当 display 含 speed 时才工作（cost gate）
function resolveSpeed(sessionContext, transcriptPath, config, cache, mark) {
  // 不显示 speed → 直接返回双 null（不读 transcript、不碰缓存）
  if (!config?.display?.includes('speed')) return { current: null, average: null };

  // 会话 ID（速度基线按会话存）
  const sessionId = String(sessionContext?.session_id || sessionContext?.sessionId || '');
  // 读 transcript：累计输出 token + 最后一行时间戳
  const { outputTokens, lastLineMs } = readJsonlOutputStats(transcriptPath);
  // 累计 API 时间（ms）—— CC 的进程生命周期累计器，/clear 不清零（锚定法存在的原因）
  const apiMsRaw = Number(sessionContext?.cost?.total_api_duration_ms);
  // 有限数字才有效，否则 null
  const apiMs = Number.isFinite(apiMsRaw) ? apiMsRaw : null;
  // 当前时刻
  const now = Date.now();

  // 绝对平均 = 累计输出 / 累计 API 秒（未锚定时的回退值，会被继承来的旧时间压低）
  const average = apiMs !== null && apiMs > 0 && outputTokens > 0 ? outputTokens / (apiMs / 1000) : null;

  // 自管理调用方自己读缓存
  cache = cache || loadCache();
  // 缓存键：speed:<会话ID>
  const key = `speed:${sessionId}`;
  // 上次的基线
  const prev = cache[key];

  // First tick for this session: seed the baseline, no current yet -> Speed -- t/s.
  // 该会话首个 tick：播种基线，还没有可显示的 current
  if (!prev || typeof prev.out !== 'number') {
    // 播种：累计输出、API 时间、行时间戳、显示值（null），以及锚点 out0/apiMs0
    cache[key] = { out: outputTokens, apiMs, lineMs: lastLineMs, ts: now, shown: null, out0: outputTokens, apiMs0: apiMs };
    // 清理过期条目
    pruneSpeedCache(cache);
    // 提交
    commitCache(cache, mark);
    // current 未知（--），average 先用绝对比值
    return { current: null, average };
  }

  // Session-reset / transition guard. The baseline is keyed by session_id, but /clear (and other
  // transitions — /compact, session restore) can briefly hand the seed tick a stale larger
  // cumulative output count (e.g. a new session_id whose transcript_path still resolves to the
  // previous session's transcript). That poisons the baseline: the new session's growing count can
  // never exceed it, so dOut stays <= 0 and `current` freezes at -- for the rest of the session.
  // Cumulative output only ever grows within a real session, so a positive count below the cached
  // baseline is an unambiguous reset — re-seed from the current reading and let the next tick
  // measure a real delta. (The `> 0` check avoids tripping on a transient read failure, where an
  // unreadable transcript legitimately returns 0.)
  // 会话重置守卫：0 < 本次输出 < 基线 → 必是 /clear 等切换带来的旧 transcript 读数，重新播种（见上方英文注释）
  if (outputTokens > 0 && outputTokens < prev.out) {
    // 重新播种基线与锚点（current 先置 --，下个 tick 才有真增量）
    cache[key] = { out: outputTokens, apiMs, lineMs: lastLineMs, ts: now, shown: null, out0: outputTokens, apiMs0: apiMs };
    // 清理过期条目
    pruneSpeedCache(cache);
    // 提交
    commitCache(cache, mark);
    // 返回
    return { current: null, average };
  }

  // 输出增量
  const dOut = outputTokens - prev.out;
  // 有新输出 → 计算 current
  if (dOut > 0) {
    // 分母（秒）
    let denomSeconds;
    // 首选分母：API 时间增量（真实请求时间，不含渲染间空闲）
    if (apiMs !== null && typeof prev.apiMs === 'number' && apiMs > prev.apiMs) {
      // 计算
      denomSeconds = (apiMs - prev.apiMs) / 1000;
    // 次选分母：transcript 行时间戳增量
    } else if (lastLineMs !== null && typeof prev.lineMs === 'number' && lastLineMs > prev.lineMs) {
      // 计算
      denomSeconds = (lastLineMs - prev.lineMs) / 1000;
    // 兜底分母：墙钟时间差
    } else {
      // 计算
      denomSeconds = (now - prev.ts) / 1000;
    }
    // 分母下限 0.1s：防止极小时间差算出天文数字速度
    denomSeconds = Math.max(denomSeconds, SPEED_MIN_DENOM_S);
    // 当前速度 = 输出增量 / 分母秒
    const current = dOut / denomSeconds;
    // 更新基线（out0/apiMs0 锚点原值透传保留）
    cache[key] = { out: outputTokens, apiMs, lineMs: lastLineMs, ts: now, shown: current, out0: prev.out0, apiMs0: prev.apiMs0 };
    // 清理过期条目
    pruneSpeedCache(cache);
    // 提交
    commitCache(cache, mark);
    // 锚定平均（可能为 null）
    const anchored = anchoredAverage(outputTokens, apiMs, prev);
    // 锚定值优先，否则退回绝对比值
    return { current, average: anchored != null ? anchored : average };
  }

  // Idle (no new output). Prefer the last measured reading when usable (>= 1 t/s — the threshold
  // below which formatSpeed renders '--'); otherwise fall back to a valid average so a lost
  // baseline (e.g. shared-cache corruption from concurrent projects, which the idle branch never
  // rewrites) doesn't strand Speed at '--'. The anchored average is null in exactly this no-growth
  // condition, so the fallback is the absolute cumulative ratio outputTokens/(apiMs/1000) — valid
  // only when the seed baseline is self-consistent (one process lifetime): out0===0, or out0>0
  // with apiMs0>0. A resumed session (out0>0, apiMs0 0/null) has a mismatched old-transcript /
  // new-process base -> leave '--'. Do NOT rewrite the cache — the baseline must stay intact so
  // the next active tick computes from it. `0` is never returned.
  // 空闲（无新输出）：先算锚定平均（此条件下必为 null）
  const anchored = anchoredAverage(outputTokens, apiMs, prev);
  // 播种一致性：out0=0，或 out0>0 且 apiMs0>0 → 同一进程生命周期，绝对比值可用
  const seedConsistent = prev.out0 === 0 || (typeof prev.apiMs0 === 'number' && prev.apiMs0 > 0);
  // 有效平均 = 锚定 ??（一致 ? 绝对 : null）—— 恢复的旧会话基准错配 → 保持 --
  const validAvg = anchored != null ? anchored : (seedConsistent ? average : null);
  // 上次显示值 ≥1 tok/s 才可直接沿用（<1 会被 formatSpeed 渲染成 --）
  const heldUsable = typeof prev.shown === 'number' && prev.shown >= 1;
  // current = 沿用上次显示值，否则退到有效平均（防止共享缓存损坏后速度永远卡 --）
  const current = heldUsable ? prev.shown : validAvg;
  // 返回（空闲分支刻意不写缓存 —— 基线必须留给下个活跃 tick 使用）
  return { current, average: anchored != null ? anchored : average };
}

// 速度文本格式化：未知或 <1 都显示 "--"（绝不显示 0 —— Number(null)===0 的坑）
function formatSpeed(value) {
  // null/undefined mean "no reading yet"; values < 1 tok/s are not a meaningful integer reading.
  // Both render as '-- so the segment can never display 0 (Number(null) === 0 would otherwise).
  // null/undefined → "--"
  if (value === null || value === undefined) return '--';
  // 转数字
  const n = Number(value);
  // 非有限或 <1 tok/s → "--"（不足 1 的整数读数无意义）
  if (!Number.isFinite(n) || n < 1) return '--';
  // <1000：整数
  if (n < 1000) return String(Math.round(n));
  // <100 万：K 单位 1 位小数
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}K`;
  // 更大：M 单位
  return `${(n / 1_000_000).toFixed(1)}M`;
}

// --plan-details 的单行额度格式化："标签: 42% · 1.2M/5M · resets 18:30"
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
