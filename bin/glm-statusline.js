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
// HTTPS 客户端：请求配额/用量 API（生产端点）
const https = require('https');
// HTTP 客户端：同上（本地 fixture 测试服务器走 http）
const http = require('http');
// URL 构造器：解析 base URL（非法输入由 try/catch 兜住）
const { URL } = require('url');
// 字段定义库：全部字段表 DISPLAY_FIELDS（未配置时默认全显）、分组 groupDisplay、display 清洗+回退 displayOrDefault
const { DISPLAY_FIELDS, groupDisplay, displayOrDefault } = require('../lib/display-fields');
// 文件读写共享库（与安装器共用）：安全读 JSON、原子写、transcript 遍历、配置路径、调试日志
const {
  // 调试日志（读文件/写缓存/API 出错时记 stderr，仅 GLM_STATUSLINE_DEBUG=1 可见）
  debugLog,
  // "~" 路径展开（transcript_path 等处仍直接使用）
  expandHome,
  // 通用 JSON 读取（吞错返回 null —— 经下方 readJsonSafe 包装记 debugLog）
  readJsonFile,
  // 通用 JSON 写入（saveCache 用其原子写模式）
  writeJsonFile,
  // 配置文件路径解析（env 覆盖 → 默认 + ~ 展开）
  configFilePath,
} = require('../lib/file-io');
// transcript 统计库：usage/token 提取器 + 两个 JSONL 读取器（速度与会话字段的数值来源）
const {
  // 从 usage 对象算 token 总量（model-usage 兼容提取的兜底也用）
  tokenTotalFromUsage,
  // 会话 token 统计（session 字段）
  readJsonlTokenStats,
  // 输出 token 统计 + 最后一行时间戳（速度字段）
  readJsonlOutputStats,
} = require('../lib/transcript-stats');
// 共享缓存层：原子写、TTL 判断、per-session 条目清理（一次读一次写不变量的载体）
const {
  // 读共享缓存（坏文件 → 空对象）
  loadCache,
  // 原子写共享缓存（吞写错误）
  saveCache,
  // 提交缓存变更（mark 标脏 / 无 mark 立即落盘）
  commitCache,
  // TTL 新鲜度判断
  isFresh,
  // 清理过期 context: 条目
  pruneContextCache,
  // 清理过期 speed: 基线
  pruneSpeedCache,
} = require('../lib/status-cache');
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
// API 请求超时毫秒数（可用环境变量调整）
const API_TIMEOUT_MS = Number(process.env.GLM_STATUSLINE_TIMEOUT_MS || 2200);

// Output-speed tuning. The status line is a fresh process each render, so speed is derived from a
// per-session cached baseline (see resolveSpeed). When idle the last measured value is held (it
// never decays to 0); SPEED_MIN_DENOM_S floors the denominator so a tiny ΔapiMs can't produce a
// multimillion tok/s spike.
// 输出速度分母下限（秒）：防止极小的 ΔapiMs 算出百万级 tok/s 的瞬时尖峰
const SPEED_MIN_DENOM_S = 0.1;

// 套餐名候选键列表：兼容式解析会在响应里递归找这些键（API 无固定 schema，只能广撒网）
const PLAN_KEYS = [
  'planName',
  'packageName',
  'packageTitle',
  'subscriptionName',
  'productName',
  'levelName',
  'plan',
  'package',
  'level',
  'tier',
  'skuName',
  'sku',
  'edition',
];

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

// 从 base URL 提取协议+主机（去掉路径部分）；失败返回空串
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

// 兼容式解析原语：在任意嵌套结构里按候选键名递归找第一个非空字符串（API 无固定 schema）
function recursiveFindStringByKeys(obj, keys, depth = 0) {
  // 空值或深度超限（防循环引用/超深嵌套）→ 空串
  if (!obj || depth > 7) return '';
  // 数组：逐项递归找
  if (Array.isArray(obj)) {
    // 遍历数组元素
    for (const item of obj) {
      // 递归子项（深度 +1）
      const found = recursiveFindStringByKeys(item, keys, depth + 1);
      // 找到非空值立即返回
      if (found) return found;
    }
    // 数组里没找到 → 空串
    return '';
  }
  // 既非数组也非对象（纯值）→ 没有键可言
  if (typeof obj !== 'object') return '';

  // 先在当前对象上按候选键顺序直接找
  for (const key of keys) {
    // 取该键的值
    const value = obj[key];
    // 非空字符串 → 返回（去首尾空白）
    if (typeof value === 'string' && value.trim()) return value.trim();
    // 有限数字 → 转字符串返回
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  }

  // 当前对象找不到 → 递归子树
  for (const value of Object.values(obj)) {
    // 遍历所有属性值
    const found = recursiveFindStringByKeys(value, keys, depth + 1);
    // 子树里找到就返回
    if (found) return found;
  }
  // 彻底没找到 → 空串
  return '';
}

// 把各种原始套餐名归一成展示名："GLM Lite" / "GLM Pro" 等
function normalizePlanName(raw) {
  // 先转字符串并去空白
  const value = String(raw || '').trim();
  // 空值 → 空串
  if (!value) return '';
  // 以 "glm " 开头：把前缀规范成大写 GLM
  if (/^glm\s+/i.test(value)) return value.replace(/^glm/i, 'GLM');
  // 含 lite → GLM Lite
  if (/lite/i.test(value)) return 'GLM Lite';
  // 含 pro → GLM Pro
  if (/pro/i.test(value)) return 'GLM Pro';
  // 含 standard/std → GLM Standard
  if (/standard|std/i.test(value)) return 'GLM Standard';
  // 含 plus → GLM Plus
  if (/plus/i.test(value)) return 'GLM Plus';
  // 含 free → GLM Free
  if (/free/i.test(value)) return 'GLM Free';
  // 其余短名：加 GLM 前缀并 Title Case；长名原样保留
  return value.length <= 18 ? `GLM ${titleCase(value)}` : value;
}

// 辅助：把 "coding_max"/"coding-max" 转成 "Coding Max"
function titleCase(input) {
  // 入口：转字符串后链式清洗
  return String(input)
    // 下划线/连字符统一成空格
    .replace(/[_-]+/g, ' ')
    // 连续空白折叠成一个空格
    .replace(/\s+/g, ' ')
    // 去首尾空白
    .trim()
    // 每个单词首字母大写
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

// 从 limit 对象读百分比：先试"直接百分比"候选键，都不中再退回 used/total 比值
function readPercent(obj) {
  // 非对象 → null（表示"读不出"，渲染成 unknown）
  if (!obj || typeof obj !== 'object') return null;
  // 直接百分比候选键（优先级即数组顺序）
  const directKeys = [
    'percentage',
    'percent',
    'usagePercentage',
    'usedPercentage',
    'usedPercent',
    'usagePercent',
    'rate',
    'ratio',
  ];
  // 按优先级逐个试
  for (const key of directKeys) {
    // 取值并转数字
    const value = Number(obj[key]);
    // 有限数字即命中
    if (Number.isFinite(value)) {
      // 夹取到 0..100；键名含 ratio 且值 ≤1 视为 0..1 小数，×100 转百分比
      return clampPercent(value <= 1 && key.toLowerCase().includes('ratio') ? value * 100 : value);
    }
  }

  // 分子候选：已用量的各种命名
  const used = Number(obj.used ?? obj.usage ?? obj.current ?? obj.consumed ?? obj.usedValue);
  // 分母候选：总额度的各种命名
  const total = Number(obj.total ?? obj.limit ?? obj.max ?? obj.quota ?? obj.limitValue);
  // 分子分母都有效且总额 > 0 → 算比值
  if (Number.isFinite(used) && Number.isFinite(total) && total > 0) {
    // used/total×100 后夹取
    return clampPercent((used / total) * 100);
  }

  // 两条路都读不出 → null
  return null;
}

// 按候选键顺序读第一个非负有限数字（读不到为 null）
function readNumberFromKeys(obj, keys) {
  if (!obj || typeof obj !== 'object') return null;
  // 遍历候选键
  for (const key of keys) {
    // 取值转数字
    const value = Number(obj[key]);
    // 有限且 ≥0 → 命中返回
    if (Number.isFinite(value) && value >= 0) return value;
  }
  // 全部未命中 → null
  return null;
}

// 读"已用量/总额度"明细：两组候选键 + usage 字段的兜底转换
function readUsageDetail(obj) {
  // 非对象 → 双 null
  if (!obj || typeof obj !== 'object') {
    // 占位结构（渲染层显示为不可用）
    return { used: null, total: null };
  }

  // 已用量候选键（驼峰/下划线两套命名都覆盖）
  const used = readNumberFromKeys(obj, [
    'currentValue',
    'current_value',
    'usedValue',
    'used_value',
    'used',
    'current',
    'consumed',
    'requestUsed',
    'usedCount',
    'usageValue',
  ]);

  // 总额度候选键
  let total = readNumberFromKeys(obj, [
    'total',
    'totalValue',
    'total_value',
    'limit',
    'limitValue',
    'limit_value',
    'max',
    'quota',
    'quotaValue',
  ]);

  // usage 字段：可能是总额也可能是已用量，下面按缺失情况解释
  const usage = Number(obj.usage);
  // total 缺失而 usage 有效 → 把 usage 当总额
  if (total === null && used !== null && Number.isFinite(usage) && usage >= 0) {
    // 赋值
    total = usage;
  }

  // 归一已用量：优先 used；否则 total+usage 都有效时把 usage 当已用量
  const normalizedUsed =
    used !== null
      ? used
      : total !== null && Number.isFinite(usage) && usage >= 0
        ? usage
        : null;

  // 返回明细
  return { used: normalizedUsed, total };
}

// 读重置时间：按候选键找第一个能解析成毫秒时间戳的值
function readResetTime(obj) {
  // 非对象 → null
  if (!obj || typeof obj !== 'object') return null;
  // 重置时间候选键（多种命名）
  const keys = [
    'nextResetTime',
    'next_reset_time',
    'resetTime',
    'reset_time',
    'resetAt',
    'reset_at',
    'renewalTime',
    'renewal_time',
    'expiredTime',
    'expireTime',
  ];

  // 按顺序遍历
  for (const key of keys) {
    // 取值
    const value = obj[key];
    // 空值跳过（continue 而非 return，后面的键还有机会）
    if (value === undefined || value === null || value === '') continue;
    // 归一成毫秒时间戳
    const parsed = parseResetTime(value);
    // 解析成功 → 返回
    if (parsed !== null) return parsed;
  }

  // 全没中 → null
  return null;
}

// limit 对象分类器：把可能标识类别的字段拼成大写文本后按关键词分类 —— 兼容式解析的核心一步
function classifyLimit(limit) {
  // 挑出类别相关字段拼成 JSON 再转大写，供正则一次判定
  const text = JSON.stringify({
    type: limit.type,
    limitType: limit.limitType,
    quotaType: limit.quotaType,
    name: limit.name,
    title: limit.title,
    code: limit.code,
    key: limit.key,
  }).toUpperCase();

  // 含周关键词（WEEK/7D/SEVEN）→ weekly
  if (/WEEK|7D|SEVEN/.test(text)) return 'weekly';
  // 含 MCP/TOOL/TIME → mcp
  if (/MCP|TOOL|TOOLS|TIME_LIMIT|TIME/.test(text)) return 'mcp';
  // 含 5H/FIVE/TOKEN/MODEL → fiveHour
  if (/5H|FIVE|TOKEN|TOKENS|TOKENS_LIMIT|MODEL/.test(text)) return 'fiveHour';
  // 都匹配不上 → 空串（未分类，进 otherLimits）
  return '';
}

// 读 limit 的展示名：从 title/name/type 等候选字段取第一个有值的
function readLimitDisplayName(limit) {
  if (!limit || typeof limit !== 'object') return '';
  // 按优先级链取第一个真值
  const value = limit.title || limit.name || limit.type || limit.limitType || limit.quotaType || limit.code || limit.key;
  // 字符串直接用；空值空串；其余 String 化
  return typeof value === 'string' ? value : value === undefined || value === null ? '' : String(value);
}

// 把 limit 对象 + 分类结果组装成统一的 detail 结构
function limitDetail(limit, kind) {
  // 读用量明细
  const usage = readUsageDetail(limit);
  // 返回统一结构
  return {
    // 分类（fiveHour/mcp/weekly/other）
    kind,
    // 展示名
    name: readLimitDisplayName(limit),
    // 使用百分比
    percent: readPercent(limit),
    // 已用量
    used: usage.used,
    // 总额度
    total: usage.total,
    // 重置时间（毫秒时间戳）
    resetTime: readResetTime(limit),
  };
}

// 配额 API 响应 → 统一结构的总入口：找套餐名 + 收集全部 limit 对象并逐个分类提取
function extractQuotaData(json) {
  // 递归找套餐名原始值
  const planRaw = recursiveFindStringByKeys(json, PLAN_KEYS);
  // 结果容器（额度字段全部先置空）
  const result = {
    // 归一后的套餐名
    planName: normalizePlanName(planRaw),
    // 5H 使用百分比（null=未知）
    fiveHourPercent: null,
    // 5H 重置时间
    fiveHourResetTime: null,
    // 5H 数据更新时间
    fiveHourUpdateTime: null,
    // MCP 使用百分比
    mcpPercent: null,
    // weekly 使用百分比
    weeklyPercent: null,
    // 5H limit 明细
    fiveHourLimit: null,
    // MCP limit 明细
    mcpLimit: null,
    // weekly limit 明细
    weeklyLimit: null,
    // 未分类但带百分比的 limit 列表
    otherLimits: [],
    // 全部已分类 limit 的明细列表
    limits: [],
  };

  // 对象收集容器
  const candidates = [];
  // 递归收集响应里所有对象（深度限制 8）
  collectObjects(json, candidates, 0);

  // 逐个对象处理
  for (const item of candidates) {
    // 先分类
    const kind = classifyLimit(item);
    // 再读百分比
    const percent = readPercent(item);
    // 未分类对象：
    if (!kind) {
      // 带百分比的进 otherLimits（供 --plan-details 展示）
      if (percent !== null) result.otherLimits.push(limitDetail(item, 'other'));
      // 处理下一个
      continue;
    }
    // 分了类但没有百分比 → 无有效数据，跳过
    if (percent === null) continue;
    // 组装明细
    const detail = limitDetail(item, kind);
    // 计入 limits 总表
    result.limits.push(detail);
    // 第一个 fiveHour 读数生效（后续同类忽略，防重复计数）
    if (kind === 'fiveHour' && result.fiveHourPercent === null) {
      // 记录百分比
      result.fiveHourPercent = percent;
      // 记录明细
      result.fiveHourLimit = detail;
    }
    // 第一个 fiveHour 的重置时间生效
    if (kind === 'fiveHour' && result.fiveHourResetTime === null) {
      // 记录
      result.fiveHourResetTime = detail.resetTime;
    }
    // 第一个 mcp 读数生效
    if (kind === 'mcp' && result.mcpPercent === null) {
      // 记录百分比
      result.mcpPercent = percent;
      // 记录明细
      result.mcpLimit = detail;
    }
    // 第一个 weekly 读数生效
    if (kind === 'weekly' && result.weeklyPercent === null) {
      // 记录百分比
      result.weeklyPercent = percent;
      // 记录明细
      result.weeklyLimit = detail;
    }
  }

  // 返回统一结构
  return result;
}

// 递归收集响应里所有对象（数组与嵌套对象都展开，深度限制 8）
function collectObjects(obj, out, depth) {
  // 空值或超深 → 停止
  if (!obj || depth > 8) return;
  // 数组：逐元素收集
  if (Array.isArray(obj)) {
    // 递归元素（深度+1）
    for (const item of obj) collectObjects(item, out, depth + 1);
    // 数组本身不算对象，收集完直接返回
    return;
  }
  // 非对象（纯值）→ 不收集
  if (typeof obj !== 'object') return;
  // 收集当前对象
  out.push(obj);
  // 递归所有属性值
  for (const value of Object.values(obj)) collectObjects(value, out, depth + 1);
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

// 从会话上下文提取 Claude 模型原始名（多种字段名兼容）
function getClaudeModelRaw(sessionContext) {
  // model 节点
  const model = sessionContext?.model;
  // 字符串形态直接用（少见但兼容）
  if (typeof model === 'string') return model;
  // 对象形态：display_name → displayName → name → id → 顶层字段，取第一个有值的
  return (
    model?.display_name ||
    model?.displayName ||
    model?.name ||
    model?.id ||
    sessionContext?.model_display_name ||
    sessionContext?.model_id ||
    ''
  );
}

// Read the current reasoning effort level. Primary source is `effort.level` in the stdin JSON
// (Claude Code v2.1.119+); env var is a fallback for when it is absent or on older versions.
// 读推理努力档位：优先 stdin 的 effort.level（新版 CC），旧字段与 env 做回退
function getEffortLevel(sessionContext, env) {
  // 取 effort 节点
  const effort = sessionContext?.effort;
  // 按优先级取档位：对象.level → 字符串形态 → 顶层旧字段 → env 变量
  const level =
    (effort && typeof effort === 'object' ? effort.level : '') ||
    (typeof effort === 'string' ? effort : '') ||
    sessionContext?.effortLevel ||
    sessionContext?.effort_level ||
    env?.CLAUDE_CODE_EFFORT_LEVEL ||
    '';
  // 归一：转小写字符串（high/medium/low）
  return String(level || '').trim().toLowerCase();
}

// Claude 模型名 → GLM 模型名：Opus/Sonnet/Haiku 映射到对应的 ANTHROPIC_DEFAULT_*_MODEL env
function mapClaudeModelToGlm(sessionContext, env) {
  // 取原始名并去空白
  const raw = String(getClaudeModelRaw(sessionContext) || '').trim();
  // 统一大写做关键词匹配
  const upper = raw.toUpperCase();

  // 映射结果
  let mapped = '';
  // 名含 OPUS → OPUS 映射（如 glm-5.1）
  if (/OPUS/.test(upper)) mapped = env.ANTHROPIC_DEFAULT_OPUS_MODEL;
  // 名含 SONNET → SONNET 映射
  else if (/SONNET/.test(upper)) mapped = env.ANTHROPIC_DEFAULT_SONNET_MODEL;
  // 名含 HAIKU → HAIKU 映射
  else if (/HAIKU/.test(upper)) mapped = env.ANTHROPIC_DEFAULT_HAIKU_MODEL;
  // 名含 GLM → 已是 GLM 名，原样用
  else if (/GLM/.test(upper)) mapped = raw;

  // 映射链兜底：SONNET 映射 → 专用 env → 原名 → "GLM"
  mapped = mapped || env.ANTHROPIC_DEFAULT_SONNET_MODEL || env.GLM_STATUSLINE_MODEL || raw || 'GLM';
  // 美化展示（大小写规范）
  return beautifyModelName(mapped);
}

// 模型名美化：去厂商前缀 + 规范 GLM 系列大小写
function beautifyModelName(input) {
  // 转字符串去空白
  let value = String(input || '').trim();
  // 空 → "GLM"
  if (!value) return 'GLM';
  // 去 anthropic/ 前缀
  value = value.replace(/^anthropic\//i, '');
  // 去 zai/ 前缀
  value = value.replace(/^zai\//i, '');
  // 去 bigmodel/ 前缀
  value = value.replace(/^bigmodel\//i, '');
  // glm 开头的名字做大小写规范
  if (/^glm/i.test(value)) {
    // 前缀大写 + 常见后缀首字母大写（后面 5 个 replace）
    return value
      .replace(/^glm/i, 'GLM')
      .replace(/-air$/i, '-Air')
      .replace(/-flash$/i, '-Flash')
      .replace(/-plus$/i, '-Plus')
      .replace(/-thinking$/i, '-Thinking');
  }
  // 非 GLM 名原样返回
  return value;
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

// 兼容式解析：递归找第一个正数（结构同 recursiveFindStringByKeys）
function recursiveFindNumberByKeys(obj, keys, depth = 0) {
  // 空值/超深 → null
  if (!obj || depth > 7) return null;
  // 数组逐项递归
  if (Array.isArray(obj)) {
    for (const item of obj) {
      // 递归元素
      const found = recursiveFindNumberByKeys(item, keys, depth + 1);
      // 找到立即返回
      if (found !== null) return found;
    }
    // 数组没找到 → null
    return null;
  }
  // 纯值 → null
  if (typeof obj !== 'object') return null;

  // 当前对象按候选键直接找
  for (const key of keys) {
    // 取值
    const value = Number(obj[key]);
    // 有限正数 → 返回
    if (Number.isFinite(value) && value > 0) return value;
  }

  // 递归子树
  for (const value of Object.values(obj)) {
    // 递归
    const found = recursiveFindNumberByKeys(value, keys, depth + 1);
    // 找到返回
    if (found !== null) return found;
  }
  // 没找到 → null
  return null;
}

// 兼容式解析：递归找第一个"正数数组"（按日序列求和用）
function recursiveFindNumberArrayByKeys(obj, keys, depth = 0) {
  // 空/超深 → null
  if (!obj || depth > 7) return null;
  // 数组逐项递归
  if (Array.isArray(obj)) {
    for (const item of obj) {
      // 递归
      const found = recursiveFindNumberArrayByKeys(item, keys, depth + 1);
      // 找到返回
      if (found) return found;
    }
    // 没找到 → null
    return null;
  }
  // 纯值 → null
  if (typeof obj !== 'object') return null;

  // 当前对象按候选键找数组
  for (const key of keys) {
    // 取值
    const value = obj[key];
    // 是数组？
    if (Array.isArray(value)) {
      // 逐项转数字并过滤出正数
      const numbers = value.map((item) => Number(item)).filter((item) => Number.isFinite(item) && item > 0);
      // 有有效项 → 返回
      if (numbers.length) return numbers;
    }
  }

  // 递归子树：遍历所有属性值
  for (const value of Object.values(obj)) {
    // 递归（找到即返回）
    const found = recursiveFindNumberArrayByKeys(value, keys, depth + 1);
    if (found) return found;
  }
  // 没找到 → null
  return null;
}

// 从 model-usage 响应提取 token 总量：三级回退（汇总字段 → 按日序列求和 → 全对象收集累加）
function extractTokenSumFromModelUsage(json) {
  // data 解包（有的响应多包一层 data）
  const root = json?.data || json;
  // 第 1 级：找"总用量"聚合字段
  const aggregate = recursiveFindNumberByKeys(root, [
    'totalTokensUsage',
    'totalTokenUsage',
    'total_tokens_usage',
    'totalTokenCount',
    'total_tokens',
  ]);
  // 找到 → 直接用
  if (aggregate !== null) return aggregate;

  // 第 2 级：找按日 token 序列数组
  const series = recursiveFindNumberArrayByKeys(root, ['tokensUsage', 'tokenUsage', 'tokens_usage']);
  // 找到 → 求和
  if (series) return series.reduce((sum, value) => sum + value, 0);

  // 第 3 级：收集所有对象，逐个累加 usage
  const objects = [];
  // 收集
  collectObjects(json, objects, 0);
  // 累计器
  let total = 0;
  // 遍历
  for (const obj of objects) {
    // 累加
    total += tokenTotalFromUsage(obj);
  }
  // 返回总量
  return total;
}

// 抓 day/month token 用量 API（带缓存；仅显示对应字段时才被调用）
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
