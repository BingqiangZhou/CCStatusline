// 严格模式：强制变量声明、把静默错误转为显式抛错，文件顶层统一开启
'use strict';

// HTTP 客户端：本地 fixture 测试服务器走 http
const http = require('http');
// HTTPS 客户端：请求配额/用量 API（生产端点）
const https = require('https');
// URL 构造器：解析 base URL（非法输入由 try/catch 兜住）
const { URL } = require('url');
// 共享缓存层：fetch 双雄的 TTL 缓存与提交契约
const { loadCache, isFresh, commitCache } = require('./status-cache');
// 兼容式解析库：响应 → 统一结构
const { extractQuotaData, extractTokenSumFromModelUsage, normalizePlanName } = require('./quota-parsing');
// 文件读写共享库：调试日志
const { debugLog } = require('./file-io');

// API 请求超时毫秒数（可用环境变量调整；模块级读取，与原核心内联版一致）
const API_TIMEOUT_MS = Number(process.env.GLM_STATUSLINE_TIMEOUT_MS || 2200);

// 从 base URL 提取协议+主机（去掉路径部分）；失败返回空串
//（被 fetchQuota/fetchModelUsage 与核心的 --plan-details 共用，故导出）
function normalizeBaseRoot(baseUrl) {
  try {
    // 解析 URL（非法 URL 走 catch）
    const u = new URL(baseUrl);
    // 只保留 protocol//host，如 https://open.bigmodel.cn
    return `${u.protocol}//${u.host}`;
  // catch：解析失败
  } catch (_) {
    // 返回空串（调用方据此短路、不碰网络）
    return '';
  }
}

// 零依赖 GET JSON：按协议自动选 http/https，带鉴权头与超时，返回 Promise
function httpJson(url, authToken) {
  // 返回 Promise：resolve 解析后的 JSON，reject Error
  return new Promise((resolve, reject) => {
    // 在 Promise 内先解析 URL —— 异常要变成 reject 而不是 throw
    let parsed;
    try {
      // 解析成功
      parsed = new URL(url);
    // catch：非法 URL
    } catch (err) {
      // 转成 reject
      reject(err);
      // 必须 return：reject 之后不能继续往下走
      return;
    }

    // 按协议选标准库：http: 用 http，其余（https:）用 https
    const lib = parsed.protocol === 'http:' ? http : https;
    // 发起请求（参数：URL、请求选项、响应回调）
    const req = lib.request(
      parsed,
      {
        // GET 请求
        method: 'GET',
        // 超时毫秒数（超时触发下面的 timeout 事件）
        timeout: API_TIMEOUT_MS,
        headers: {
          // 鉴权头：ANTHROPIC_AUTH_TOKEN
          Authorization: authToken || '',
          // 语言偏好：让 API 优先返回英文文案
          'Accept-Language': 'en-US,en;q=0.9,zh-CN;q=0.8,zh;q=0.7',
          // 要求 JSON 响应
          Accept: 'application/json',
          // 内容类型声明
          'Content-Type': 'application/json',
          // 自定义 UA：标识本插件
          'User-Agent': 'glm-statusline/1.0',
        },
      },
      // 响应回调：拿到可流式读取的 res
      (res) => {
        // 响应体累积器
        let body = '';
        // 按 UTF-8 解码
        res.setEncoding('utf8');
        // 数据块到达：累积
        res.on('data', (chunk) => (body += chunk));
        // 响应结束：开始判定结果
        res.on('end', () => {
          // 非 2xx 状态码视为失败
          if (res.statusCode < 200 || res.statusCode >= 300) {
            // reject 并带状态码 + 响应体片段（便于排查）
            reject(new Error(`HTTP ${res.statusCode}: ${body.slice(0, 160)}`));
            // reject 后直接 return
            return;
          }
          // 尝试解析 JSON
          try {
            // 成功：resolve 解析结果
            resolve(JSON.parse(body));
          // catch：响应体不是合法 JSON
          } catch (err) {
            // reject："Invalid JSON"
            reject(new Error(`Invalid JSON: ${err.message}`));
          }
        });
      }
    );

    // 超时：销毁请求并以超时错误 reject
    req.on('timeout', () => req.destroy(new Error('Request timeout')));
    // 网络层错误（DNS/连接中断等）：透传 reject
    req.on('error', reject);
    // 真正发出请求（GET 无 body）
    req.end();
  });
}

// 抓配额 API（带 60s 缓存与多级回退）—— 每次渲染的主数据源
async function fetchQuota(env, cache, mark) {
  // 归一 base URL（去掉路径）
  const baseRoot = normalizeBaseRoot(env.ANTHROPIC_BASE_URL || '');
  // 鉴权 token
  const authToken = env.ANTHROPIC_AUTH_TOKEN || '';
  // env 里配置的兜底套餐名
  const fallbackPlan = normalizePlanName(env.GLM_STATUSLINE_PLAN || '');
  // 完全回退值（没网/没配置时用）
  const fallback = {
    // 套餐名：env 兜底或 "GLM"
    planName: fallbackPlan || 'GLM',
    // 5H 百分比未知
    fiveHourPercent: null,
    // 5H 重置时间未知
    fiveHourResetTime: null,
    // 5H 更新时间未知
    fiveHourUpdateTime: null,
    // MCP 百分比未知
    mcpPercent: null,
    // weekly 百分比未知
    weeklyPercent: null,
    // 5H 明细未知
    fiveHourLimit: null,
    // MCP 明细未知
    mcpLimit: null,
    // weekly 明细未知
    weeklyLimit: null,
    // 无其他额度
    otherLimits: [],
    // 无额度列表
    limits: [],
  };

  // 缺 base URL 或 token → 不碰网络直接回退（测试正是靠空串短路实现无网络验证）
  if (!baseRoot || !authToken) return fallback;

  // 自管理调用方没传 cache 时自己读一次
  cache = cache || loadCache();
  // 缓存键：按 base URL 区分不同端点
  const cacheKey = `quota:${baseRoot}`;
  // 缓存新鲜 → 直接用缓存值（覆盖回退默认）
  if (isFresh(cache[cacheKey])) {
    // 返回 缓存值（回退值补缺失字段）
    return { ...fallback, ...cache[cacheKey].value };
  }

  // try：走网络
  try {
    // 请求配额 API 端点
    const json = await httpJson(`${baseRoot}/api/monitor/usage/quota/limit`, authToken);
    // 兼容式解析成统一结构
    const value = extractQuotaData(json);
    // 记录抓取时刻
    const fetchedAt = Date.now();
    // 响应里没有套餐名 → 用回退套餐名
    if (!value.planName) value.planName = fallback.planName;
    // 5H 更新时间：优先重置时间，否则记为抓取时刻
    value.fiveHourUpdateTime = value.fiveHourResetTime || fetchedAt;
    // 写入缓存（ts=现在）
    cache[cacheKey] = { ts: Date.now(), value };
    // 提交（共享 cache 只标脏）
    commitCache(cache, mark);
    // 返回 实测值（回退值兜底缺失字段）
    return { ...fallback, ...value };
  // catch：API 报错
  } catch (err) {
    // 记调试日志
    debugLog('quota API error', err);
    // 有过期缓存 → 用旧缓存顶上（比回退值信息多）
    if (cache[cacheKey]?.value) return { ...fallback, ...cache[cacheKey].value };
    // 实在没有 → 纯回退值
    return fallback;
  }
}

// monitor API 要求的时间参数格式 "YYYY-MM-DD HH:mm:ss"（下方是多行模板串，内部不能插注释）
function formatDateTimeForMonitorApi(date) {
  // （模板整体：本地时间各位 padStart 两位补零后拼接）
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(
    date.getDate()
  ).padStart(2, '0')} ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(
    2,
    '0'
  )}:${String(date.getSeconds()).padStart(2, '0')}`;
}

// 抓 day/month token 用量 API（带 60s 缓存；字段恒显 → 每帧尝试请求，实际频率受缓存约束）
async function fetchModelUsage(env, period, cache, mark) {
  // 归一 base URL
  const baseRoot = normalizeBaseRoot(env.ANTHROPIC_BASE_URL || '');
  // 鉴权 token
  const authToken = env.ANTHROPIC_AUTH_TOKEN || '';
  // 缺配置 → null（渲染层显示 0）
  if (!baseRoot || !authToken) return null;

  // 自管理调用方自己读缓存
  cache = cache || loadCache();
  // 缓存键按 base+周期 区分
  const cacheKey = `model:${baseRoot}:${period}`;
  // 新鲜 → 直接用
  if (isFresh(cache[cacheKey])) return cache[cacheKey].value;

  // 现在时刻
  const now = new Date();
  // 统计窗口终点
  const endTime = formatDateTimeForMonitorApi(now);
  // 窗口起点（先复制一份"现在"）
  const startDate = new Date(now.getTime());
  // day 周期？
  if (period === 'day') {
    // 当日：从今天 0 点起
    startDate.setHours(0, 0, 0, 0);
  } else {
    // 30 天：起点往前推 30 天
    startDate.setDate(startDate.getDate() - 30);
  }
  // 起点格式化
  const startTime = formatDateTimeForMonitorApi(startDate);

  // 请求 URL（startTime/endTime 需 URL 编码；下方多行模板串内部不插注释）
  const url = `${baseRoot}/api/monitor/usage/model-usage?startTime=${encodeURIComponent(
    startTime
  )}&endTime=${encodeURIComponent(endTime)}`;

  // try：走网络
  try {
    // 请求并解析
    const json = await httpJson(url, authToken);
    // 提取 token 总量
    const value = extractTokenSumFromModelUsage(json);
    // 写缓存
    cache[cacheKey] = { ts: Date.now(), value };
    // 提交
    commitCache(cache, mark);
    // 返回
    return value;
  // catch：报错
  } catch (err) {
    // 记调试日志
    debugLog(`model usage API error (${period})`, err);
    // 有过期缓存 → 旧值顶上
    if (cache[cacheKey]?.value !== undefined) return cache[cacheKey].value;
    // 没有 → null
    return null;
  }
}

// 导出本模块全部公共 API（消费者：bin/glm-statusline.js）
module.exports = {
  // 抓配额 API（60s 缓存 + 多级回退）
  fetchQuota,
  // 抓 day/month token 用量 API（带缓存）
  fetchModelUsage,
  // base URL 归一（核心 --plan-details 也要用）
  normalizeBaseRoot,
  // 零依赖 GET JSON 传输原语
  httpJson,
  // monitor API 时间参数格式化
  formatDateTimeForMonitorApi,
};
