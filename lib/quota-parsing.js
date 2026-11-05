// 严格模式：强制变量声明、把静默错误转为显式抛错，文件顶层统一开启
'use strict';

// 渲染原语库：百分比夹取 + 重置时间解析
const { clampPercent, parseResetTime } = require('./statusline-format');
// transcript 统计库：usage token 总量提取（model-usage 第 3 级回退用）
const { tokenTotalFromUsage } = require('./transcript-stats');

// 兼容式解析模块：GLM / Z.ai 监控 API **无固定 schema**，本模块用候选键 + 递归遍历把
// quota/limit 响应和 model-usage 响应都归一成统一结构。全部纯函数：不读 env、不碰 fs、无副作用。
//（对应 CLAUDE.md 的 "Domain logic to know: compatibility parsing" 一节）

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

// 导出本模块全部公共 API（消费者：bin/glm-statusline.js、lib/monitor-api.js）
module.exports = {
  // 套餐名候选键
  PLAN_KEYS,
  // 递归找字符串原语
  recursiveFindStringByKeys,
  // 套餐名归一
  normalizePlanName,
  // Title Case 辅助
  titleCase,
  // limit 百分比读取
  readPercent,
  // 候选键数字读取
  readNumberFromKeys,
  // 已用/总额明细读取
  readUsageDetail,
  // 重置时间读取
  readResetTime,
  // limit 分类器
  classifyLimit,
  // limit 展示名
  readLimitDisplayName,
  // limit → 统一明细结构
  limitDetail,
  // 配额响应 → 统一结构总入口
  extractQuotaData,
  // 递归收集全部对象
  collectObjects,
  // 递归找正数（model-usage）
  recursiveFindNumberByKeys,
  // 递归找正数数组（model-usage 按日序列）
  recursiveFindNumberArrayByKeys,
  // model-usage 响应 → token 总量（三级回退）
  extractTokenSumFromModelUsage,
};
