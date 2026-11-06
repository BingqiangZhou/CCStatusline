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
// 每会话"最后一次已知上下文百分比"的缓存保留时长：24 小时（见 lib/session-metrics.js 的 resolveContextPercent）
const CONTEXT_CACHE_TTL_MS = Number(
  process.env.GLM_STATUSLINE_CONTEXT_CACHE_TTL_MS || 24 * 60 * 60 * 1000
);
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

// 写缓存文件：委托 lib/file-io.js 的 writeJsonFile 原子写（见下方注释）
function saveCache(cache) {
  // 原子写（临时文件 + rename）：多个 Claude Code 项目共享这一个缓存文件，且每次状态栏渲染都会
  // 重写它。直接 writeFileSync 原地写会与并发写入者交错、留下半个文件；随后 loadCache 的
  // JSON.parse 失败、所有条目清零 —— 包括每会话的速度基线（见 resolveSpeed），而速度的空闲分支
  // 故意不重写缓存，基线一丢 Speed 就一直卡在 '--'。rename 在 POSIX/darwin 上是原子的，读方因此
  // 总能看到完整文件。临时文件按 PID 命名，并发写者不会互相覆盖对方的临时文件。
  // 委托共享写入原语：atomic 走"临时文件 + rename"原子写；swallowErrors 吞写失败（仅记 debugLog，
  // 缓存写失败绝不影响输出 —— 状态栏绝不能搞挂 Claude Code）
  writeJsonFile(CACHE_FILE, cache, {
    atomic: true,
    swallowErrors: true,
    onError: (err) => debugLog(`cannot write cache ${CACHE_FILE}`, err),
  });
}

// 提交某个字段做出的缓存变更：当调用方在整次渲染中共享同一个 cache 对象（renderStatusLine 传
// `mark`）时，只标脏 —— 渲染结尾的一次 saveCache 把所有字段的变更统一落盘（每次渲染一读一写，
// 而不是各字段约 4 读 4 写，并发窗口也小得多）。自管理调用方（renderPlanDetails）不传 `mark`，
// 立即写盘，保持原先的逐字段行为。
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

// 删除过期的每会话"最后一次已知"上下文条目，防止缓存文件无限膨胀
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

// 删除过期的每会话速度基线（同上，防膨胀）
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
