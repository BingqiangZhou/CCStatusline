// 严格模式：强制变量声明、把静默错误转为显式抛错，文件顶层统一开启
'use strict';

// 共享缓存层：per-session 基线/保持值的读写与提交
const { loadCache, commitCache, pruneContextCache, pruneSpeedCache } = require('./status-cache');
// transcript 统计库：输出 token 统计 + 最后一行时间戳（速度解析的输入）
const { readJsonlOutputStats } = require('./transcript-stats');
// 渲染原语库：百分比夹取
const { clampPercent } = require('./statusline-format');

// 上下文窗口大小的兜底值：20 万 token
const DEFAULT_CONTEXT_WINDOW = 200000;

// Output-speed tuning. The status line is a fresh process each render, so speed is derived from a
// per-session cached baseline (see resolveSpeed). When idle the last measured value is held (it
// never decays to 0); SPEED_MIN_DENOM_S floors the denominator so a tiny ΔapiMs can't produce a
// multimillion tok/s spike.
// 输出速度分母下限（秒）：防止极小的 ΔapiMs 算出百万级 tok/s 的瞬时尖峰
const SPEED_MIN_DENOM_S = 0.1;

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
  // 上次显示值 ≥1 tok/s 才可直接沿用（<1 会被 formatSpeed 渲染成 --；阈值镜像见 lib/statusline-format.js 的 formatSpeed）
  const heldUsable = typeof prev.shown === 'number' && prev.shown >= 1;
  // current = 沿用上次显示值，否则退到有效平均（防止共享缓存损坏后速度永远卡 --）
  const current = heldUsable ? prev.shown : validAvg;
  // 返回（空闲分支刻意不写缓存 —— 基线必须留给下个活跃 tick 使用）
  return { current, average: anchored != null ? anchored : average };
}

// 导出本模块全部公共 API（消费者：bin/glm-statusline.js）
module.exports = {
  // 读上下文信息（百分比 + 窗口大小）
  getContextInfo,
  // 上下文百分比解析（防闪烁保持）
  resolveContextPercent,
  // 锚定平均速度计算
  anchoredAverage,
  // 输出速度解析（current 增量法 + average 锚定法）
  resolveSpeed,
};
