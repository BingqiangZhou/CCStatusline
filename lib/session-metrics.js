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

// 输出速度调参：状态栏每次渲染都是全新进程，速度因此来自按会话缓存的基线（见 resolveSpeed）。
// 空闲时保持上次实测值（绝不衰减到 0）；SPEED_MIN_DENOM_S 给分母设下限（秒），
// 防止极小的 ΔapiMs 算出百万级 tok/s 的瞬时尖峰。
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
    // 仅为兜底估算：会话累计 token 不等于实时上下文 token，但比空白强；
    // 要求 >0 —— 空转录意味着"没有数据可估算"，而不是"已用 0%"
    // 估算赋值
    percent = (sessionTokens / max) * 100;
  }

  // 返回结构：percent 读不到保持 null（如会话早期或 /compact 后 used_percentage 为 null，即"未知"）——
  // 怎么渲染/保持由调用方决定，此处绝不强转成 0（未知由渲染层显示 --%）
  return {
    // 有限才夹取返回，否则 null
    percent: Number.isFinite(percent) ? clampPercent(percent) : null,
    // 窗口大小无效 → 默认 20 万
    max: Number.isFinite(max) && max > 0 ? max : DEFAULT_CONTEXT_WINDOW,
  };
}

// 上下文百分比解析（防闪烁核心）：解析要显示的百分比，当 Claude Code 上报的读数不可靠时，
// 沿用该会话上次已知的值，让进度条绝不闪成 0%。两种情况视为"本 tick 无可靠读数"：
//   - null：会话早期与 /compact 之后，Claude Code 会上报 used_percentage 为 null；
//   - 已持有真值时的字面 0：Claude Code 有时在会话切换（回合之间、切换模型）时发出一个字面 0。
//     会话一旦产出过 token，真实上下文就不会是 0；而 /clear 会换新的 session_id、没有保持值，
//     因此这里沿用上次已知值总是安全的。
// 瞬时 0 刻意不写入缓存，避免污染后续 tick。
function resolveContextPercent(sessionContext, sessionTokens, env, cache, mark) {
  // 读原始上下文信息
  const info = getContextInfo(sessionContext, sessionTokens, env);

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
    // 沿用上次已知值让进度条保持稳定 —— 不缓存这个瞬时 0
    // 有历史值 → 保持显示（进度条不闪 0%）
    if (hasHeldValue) return held.percent;
    // 从未有过读数 → 返回 null（渲染为 --%，绝不是 0%）
    return null; // 首个 tick 什么都不知道 → 渲染为 --%，绝不是 0%
  }

  // 本 tick 读数可靠 → 记入缓存，供之后未知的 tick 保持使用（瞬时 0 永远到不了这里，不会污染缓存）
  cache[key] = { percent: info.percent, ts: Date.now() };
  // 顺手清理过期条目
  pruneContextCache(cache);
  // 提交（共享 cache 只标脏）
  commitCache(cache, mark);
  // 返回本 tick 读数
  return info.percent;
}

// 输出速度解析器：current 用增量法、average 用锚定法。返回 { current, average }（单位 tok/s，
// 各自为 null 时渲染为 '--'），绝不把未知强转成 0。
//
// current：由 transcript 累计 output_tokens 的增量 ÷ cost.total_api_duration_ms 的增量得出
//   （真实 API 时间，不含渲染之间的空闲 —— 空闲灌不大分母）。分母依次回退：transcript 行
//   时间戳跨度 → 墙钟时间差。每会话基线持久化在缓存里（与 resolveContextPercent 同一套
//   读-保持-写模式）。空闲时保持（HELD）上次实测值，绝不衰减到 0；只有首次真实测量之前才是 null。
//
// average：自本会话首个被观测 tick 以来的吞吐 —— (out - out0) / ((apiMs - api0)/1000)，
//   其中 out0/api0 播种在本 session_id 的首个 tick（重置时重新播种）。两项一起锚定，让
//   cost.total_api_duration_ms 带进会话的"外来"API 时间（/clear 不清零它 —— 它是进程级
//   累计器）在分子分母中同时抵消，而不是压低均值。在还没有增量时（首个 tick / 重置播种后的
//   第一帧）回退到绝对累计比值 out / (apiMs/1000)，该段因此绝不裸显 '--'。cost 缺失/为 0 时为 null。
//
// 锚定平均速度：以会话首个 tick 为锚（out0/apiMs0）算增量比值，抵消 /clear 不清零的 API 时间累计
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

// 输出速度解析器：current 用增量法、average 用锚定法
function resolveSpeed(sessionContext, transcriptPath, cache, mark) {
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

  // 该会话首个 tick：播种基线，还没有可显示的 current → Speed -- t/s
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

  // 会话重置/切换守卫：基线按 session_id 存，但 /clear（以及其它切换 —— /compact、会话恢复）
  // 可能让播种 tick 短暂拿到一个陈旧且更大的累计输出值（例如新 session_id 的 transcript_path
  // 仍指向上一个会话的 transcript）。这会毒化基线：新会话不断增长的值永远超不过它，dOut 一直
  // ≤ 0，current 在会话剩余时间里冻结在 --。真实会话内累计输出只会增长，因此"正值且小于缓存
  // 基线"是明确的重置信号 —— 从当前读数重新播种，让下一个 tick 测到真实增量。
  //（> 0 的判断避免在瞬时读取失败时误触发：transcript 读不出来时合理地返回 0。）
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

  // 空闲（无新输出）。上次实测值可用时（≥ 1 t/s —— 低于该阈值 formatSpeed 会渲染 '--'）优先沿用；
  // 否则回退到一个有效的平均值，避免基线丢失（如多项目并发写坏共享缓存 —— 而空闲分支刻意不
  // 重写缓存）后 Speed 永远卡在 '--'。锚定平均恰好在"无增长"条件下为 null，因此回退值是绝对
  // 累计比值 outputTokens/(apiMs/1000) —— 仅当播种基线自洽（同一进程生命周期：out0===0，或
  // out0>0 且 apiMs0>0）时有效。恢复的旧会话（out0>0、apiMs0 为 0/null）是"旧 transcript +
  // 新进程"的错配基准 → 保持 '--'。不要写缓存 —— 基线必须原样保留给下一个活跃 tick 计算。
  // 绝不返回 0。
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
