// 严格模式：强制变量声明、把静默错误转为显式抛错，文件顶层统一开启
'use strict';

// 路径处理：缓存默认路径拼接
const path = require('path');
// 系统信息：定位主目录
const os = require('os');
// 文件读写共享库：JSON 读写原语 + 调试日志
const { readJsonFile, writeJsonFile, debugLog } = require('./file-io');

// 用户主目录：缓存默认路径的根
const HOME = os.homedir();
// 共享缓存文件路径（所有项目写同一文件；可用环境变量重定向 —— 测试即靠它隔离；模块级读取，与原核心内联版一致）
const CACHE_FILE = process.env.GLM_STATUSLINE_CACHE_FILE || path.join(HOME, '.claude', 'glm-statusline-cache.json');
// 配额/用量缓存默认 TTL：60 秒（降低对监控 API 的请求频率）
const CACHE_TTL_MS = Number(process.env.GLM_STATUSLINE_CACHE_TTL_MS || 60_000);
// How long a per-session "last known" context percentage is held in the cache.
// 每会话"最后一次已知上下文百分比"的缓存保留时长：24 小时（见 lib/session-metrics.js 的 resolveContextPercent）
const CONTEXT_CACHE_TTL_MS = Number(
  process.env.GLM_STATUSLINE_CONTEXT_CACHE_TTL_MS || 24 * 60 * 60 * 1000
);
// How long a per-session speed baseline is held in the cache.
// 每会话速度基线的缓存保留时长：24 小时（见 lib/session-metrics.js 的 resolveSpeed）
const SPEED_CACHE_TTL_MS = Number(
  process.env.GLM_STATUSLINE_SPEED_CACHE_TTL_MS || 24 * 60 * 60 * 1000
);

// 读共享缓存文件：内容非法/不存在 → 空对象（绝不抛错）
function loadCache() {
  // 读缓存 JSON（解析失败返回 null 且记 debugLog —— 与核心 readJsonSafe 包装完全同标签）
  const cache = readJsonFile(CACHE_FILE, {
    onError: (err) => debugLog(`cannot parse JSON file ${CACHE_FILE}`, err),
  });
  // 是对象就用，否则（损坏成字符串/数字等非对象值）回空对象
  return cache && typeof cache === 'object' ? cache : {};
}

// 写缓存文件：委托 lib/file-io.js 的 writeJsonFile 原子写（见下方英文注释）
function saveCache(cache) {
  // Atomic write (temp file + rename). Several Claude Code projects share this one cache file and
  // every status-line render rewrites it. A plain in-place writeFileSync can interleave with a
  // concurrent writer and leave a half-written file; that then fails JSON.parse in loadCache and
  // wipes every entry — including the per-session speed baseline (see resolveSpeed), which the idle
  // branch never rewrites, so it strands Speed at '--'. rename is atomic on POSIX/darwin, so a
  // reader always sees a complete file. The temp is per-PID so concurrent writers don't clobber
  // each other's temp.
  // 委托共享写入原语：atomic 走"临时文件 + rename"原子写；swallowErrors 吞写失败（仅记 debugLog，
  // 缓存写失败绝不影响输出 —— statusLine should never break Claude Code）
  writeJsonFile(CACHE_FILE, cache, {
    atomic: true,
    swallowErrors: true,
    onError: (err) => debugLog(`cannot write cache ${CACHE_FILE}`, err),
  });
}

// Commit a cache mutation made by a field. When the caller shares one cache object across the
// whole render (renderStatusLine passes `mark`), just flag it dirty — a single end-of-render
// saveCache persists every field's mutation at once (one read + one write per render instead of
// ~4 each, and a far smaller concurrency window). Self-managed callers (renderPlanDetails) omit
// `mark` and save immediately, preserving the old per-field behavior.
// 提交缓存变更：渲染主流程共享同一 cache 对象时只标脏（mark），由结尾的一次 saveCache 统一落盘
function commitCache(cache, mark) {
  // 有 mark（状态栏渲染路径）：标脏即可，稍后统一写
  if (mark) mark();
  // 无 mark（自管理调用方如 renderPlanDetails）：立即写盘
  else saveCache(cache);
}

// 判断缓存条目是否仍在 TTL 内（默认 60 秒 —— 默认参数必须与常量同迁，丢了会退化成 undefined 比较）
function isFresh(entry, ttl = CACHE_TTL_MS) {
  // 有 ts 且距现在不足 TTL 才算新鲜
  return entry && typeof entry.ts === 'number' && Date.now() - entry.ts < ttl;
}

// Drop stale per-session "last known" context entries so the cache file can't grow unbounded.
// 删除过期的 per-session 上下文条目，防止缓存文件无限膨胀
function pruneContextCache(cache) {
  // 当前时间
  const now = Date.now();
  // 遍历缓存所有键
  for (const key of Object.keys(cache)) {
    // context: 前缀且超过 24h → 删除
    if (key.startsWith('context:') && now - (cache[key]?.ts || 0) > CONTEXT_CACHE_TTL_MS) {
      // 执行删除
      delete cache[key];
    }
  }
}

// Drop stale per-session speed baselines so the cache file can't grow unbounded.
// 删除过期的 per-session 速度基线（同上，防膨胀）
function pruneSpeedCache(cache) {
  // 当前时间
  const now = Date.now();
  // 遍历所有键
  for (const key of Object.keys(cache)) {
    // speed: 前缀且超过 TTL → 删除
    if (key.startsWith('speed:') && now - (cache[key]?.ts || 0) > SPEED_CACHE_TTL_MS) {
      // 执行删除
      delete cache[key];
    }
  }
}

// 导出本模块全部公共 API（消费者：bin/glm-statusline.js、lib/monitor-api.js、lib/session-metrics.js）
module.exports = {
  // 读共享缓存（坏文件 → 空对象）
  loadCache,
  // 原子写共享缓存（吞写错误）
  saveCache,
  // 提交缓存变更（mark 标脏 / 无 mark 立即落盘）
  commitCache,
  // TTL 新鲜度判断（默认 60s）
  isFresh,
  // 清理过期 context: 条目
  pruneContextCache,
  // 清理过期 speed: 基线
  pruneSpeedCache,
};
