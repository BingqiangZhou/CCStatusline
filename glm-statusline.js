#!/usr/bin/env node
/**
 * glm-statusline.js
 *
 * A single-file Claude Code statusLine script for GLM Coding Plan.
 *
 * Output:
 *   5H ██░░░░░░ 22% @18:30 │ MCP █░░░░░░░ 8% │ Session 160K │ Day 42.8M
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
 *     "command": "node ~/.claude/glm-statusline.js",
 *     "refreshInterval": 5,
 *     "padding": 0
 *   }
 * }
 */

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const https = require('https');
const http = require('http');
const { URL } = require('url');
const { DEFAULT_DISPLAY, normalizeDisplayList } = require('./lib/display-fields');
const {
  clampPercent,
  formatAge,
  formatLocalDateTime,
  formatResetHHmm,
  formatTimeHHmm,
  formatTokens,
  parseResetTime,
  renderBar,
  wrapSegments,
} = require('./lib/statusline-format');

const HOME = os.homedir();
const CACHE_FILE = process.env.GLM_STATUSLINE_CACHE_FILE || path.join(HOME, '.claude', 'glm-statusline-cache.json');
const DEFAULT_CONFIG_FILE = path.join(HOME, '.claude', 'glm-statusline-config.json');
const DEFAULT_CONTEXT_WINDOW = 200000;
const API_TIMEOUT_MS = Number(process.env.GLM_STATUSLINE_TIMEOUT_MS || 2200);
const CACHE_TTL_MS = Number(process.env.GLM_STATUSLINE_CACHE_TTL_MS || 60_000);

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

function debugLog(label, err) {
  if (process.env.GLM_STATUSLINE_DEBUG !== '1') return;
  const message = err && err.message ? err.message : String(err || 'unknown error');
  console.error(`[glm-statusline] ${label}: ${message}`);
}

function expandHome(input) {
  if (!input || typeof input !== 'string') return input;
  if (input === '~') return HOME;
  if (input.startsWith('~/')) return path.join(HOME, input.slice(2));
  return input;
}

function readJsonFile(filePath) {
  try {
    if (!filePath || !fs.existsSync(filePath)) return null;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (err) {
    debugLog(`cannot parse JSON file ${filePath}`, err);
    return null;
  }
}

function readStatusConfig(env = process.env) {
  const configPath = expandHome(env.GLM_STATUSLINE_CONFIG_FILE || DEFAULT_CONFIG_FILE);
  const fileConfig = readJsonFile(configPath) || {};
  const fromFile = normalizeDisplayList(fileConfig.display);
  let display = fromFile.length ? fromFile : [...DEFAULT_DISPLAY];
  if (!display.length) display = [...DEFAULT_DISPLAY];
  const maxWidth = readMaxWidth(env);

  return {
    configPath,
    display,
    maxWidth,
  };
}

function readMaxWidth(env) {
  const raw = env.COLUMNS ?? process.stdout.columns ?? 80;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.max(20, Math.round(value));
}

function mergeEnvFromSettings(sessionContext) {
  const currentDir =
    sessionContext?.workspace?.current_dir ||
    sessionContext?.cwd ||
    process.cwd();

  const files = [
    path.join(HOME, '.claude', 'settings.json'),
    path.join(currentDir, '.claude', 'settings.json'),
    path.join(currentDir, '.claude', 'settings.local.json'),
  ];

  const merged = {};
  for (const file of files) {
    const json = readJsonFile(file);
    if (json && json.env && typeof json.env === 'object') {
      Object.assign(merged, json.env);
    }
  }

  return { ...merged, ...process.env };
}

function normalizeBaseRoot(baseUrl) {
  try {
    const u = new URL(baseUrl);
    return `${u.protocol}//${u.host}`;
  } catch (_) {
    return '';
  }
}

function httpJson(url, authToken) {
  return new Promise((resolve, reject) => {
    let parsed;
    try {
      parsed = new URL(url);
    } catch (err) {
      reject(err);
      return;
    }

    const lib = parsed.protocol === 'http:' ? http : https;
    const req = lib.request(
      parsed,
      {
        method: 'GET',
        timeout: API_TIMEOUT_MS,
        headers: {
          Authorization: authToken || '',
          'Accept-Language': 'en-US,en;q=0.9,zh-CN;q=0.8,zh;q=0.7',
          Accept: 'application/json',
          'Content-Type': 'application/json',
          'User-Agent': 'glm-statusline/1.0',
        },
      },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => (body += chunk));
        res.on('end', () => {
          if (res.statusCode < 200 || res.statusCode >= 300) {
            reject(new Error(`HTTP ${res.statusCode}: ${body.slice(0, 160)}`));
            return;
          }
          try {
            resolve(JSON.parse(body));
          } catch (err) {
            reject(new Error(`Invalid JSON: ${err.message}`));
          }
        });
      }
    );

    req.on('timeout', () => req.destroy(new Error('Request timeout')));
    req.on('error', reject);
    req.end();
  });
}

function loadCache() {
  const cache = readJsonFile(CACHE_FILE);
  return cache && typeof cache === 'object' ? cache : {};
}

function saveCache(cache) {
  try {
    fs.mkdirSync(path.dirname(CACHE_FILE), { recursive: true });
    fs.writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2));
  } catch (err) {
    debugLog(`cannot write cache ${CACHE_FILE}`, err);
    // Ignore cache write errors; statusLine should never break Claude Code.
  }
}

function isFresh(entry, ttl = CACHE_TTL_MS) {
  return entry && typeof entry.ts === 'number' && Date.now() - entry.ts < ttl;
}

function recursiveFindStringByKeys(obj, keys, depth = 0) {
  if (!obj || depth > 7) return '';
  if (Array.isArray(obj)) {
    for (const item of obj) {
      const found = recursiveFindStringByKeys(item, keys, depth + 1);
      if (found) return found;
    }
    return '';
  }
  if (typeof obj !== 'object') return '';

  for (const key of keys) {
    const value = obj[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  }

  for (const value of Object.values(obj)) {
    const found = recursiveFindStringByKeys(value, keys, depth + 1);
    if (found) return found;
  }
  return '';
}

function normalizePlanName(raw) {
  const value = String(raw || '').trim();
  if (!value) return '';
  if (/^glm\s+/i.test(value)) return value.replace(/^glm/i, 'GLM');
  if (/lite/i.test(value)) return 'GLM Lite';
  if (/pro/i.test(value)) return 'GLM Pro';
  if (/standard|std/i.test(value)) return 'GLM Standard';
  if (/plus/i.test(value)) return 'GLM Plus';
  if (/free/i.test(value)) return 'GLM Free';
  return value.length <= 18 ? `GLM ${titleCase(value)}` : value;
}

function titleCase(input) {
  return String(input)
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

function readPercent(obj) {
  if (!obj || typeof obj !== 'object') return null;
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
  for (const key of directKeys) {
    const value = Number(obj[key]);
    if (Number.isFinite(value)) {
      return clampPercent(value <= 1 && key.toLowerCase().includes('ratio') ? value * 100 : value);
    }
  }

  const used = Number(obj.used ?? obj.usage ?? obj.current ?? obj.consumed ?? obj.usedValue);
  const total = Number(obj.total ?? obj.limit ?? obj.max ?? obj.quota ?? obj.limitValue);
  if (Number.isFinite(used) && Number.isFinite(total) && total > 0) {
    return clampPercent((used / total) * 100);
  }

  return null;
}

function readNumberFromKeys(obj, keys) {
  if (!obj || typeof obj !== 'object') return null;
  for (const key of keys) {
    const value = Number(obj[key]);
    if (Number.isFinite(value) && value >= 0) return value;
  }
  return null;
}

function readUsageDetail(obj) {
  if (!obj || typeof obj !== 'object') {
    return { used: null, total: null };
  }

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

  const usage = Number(obj.usage);
  if (total === null && used !== null && Number.isFinite(usage) && usage >= 0) {
    total = usage;
  }

  const normalizedUsed =
    used !== null
      ? used
      : total !== null && Number.isFinite(usage) && usage >= 0
        ? usage
        : null;

  return { used: normalizedUsed, total };
}

function readResetTime(obj) {
  if (!obj || typeof obj !== 'object') return null;
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

  for (const key of keys) {
    const value = obj[key];
    if (value === undefined || value === null || value === '') continue;
    const parsed = parseResetTime(value);
    if (parsed !== null) return parsed;
  }

  return null;
}

function classifyLimit(limit) {
  const text = JSON.stringify({
    type: limit.type,
    limitType: limit.limitType,
    quotaType: limit.quotaType,
    name: limit.name,
    title: limit.title,
    code: limit.code,
    key: limit.key,
  }).toUpperCase();

  if (/WEEK|7D|SEVEN/.test(text)) return 'weekly';
  if (/MCP|TOOL|TOOLS|TIME_LIMIT|TIME/.test(text)) return 'mcp';
  if (/5H|FIVE|TOKEN|TOKENS|TOKENS_LIMIT|MODEL/.test(text)) return 'fiveHour';
  return '';
}

function readLimitDisplayName(limit) {
  if (!limit || typeof limit !== 'object') return '';
  const value = limit.title || limit.name || limit.type || limit.limitType || limit.quotaType || limit.code || limit.key;
  return typeof value === 'string' ? value : value === undefined || value === null ? '' : String(value);
}

function limitDetail(limit, kind) {
  const usage = readUsageDetail(limit);
  return {
    kind,
    name: readLimitDisplayName(limit),
    percent: readPercent(limit),
    used: usage.used,
    total: usage.total,
    resetTime: readResetTime(limit),
  };
}

function extractQuotaData(json) {
  const planRaw = recursiveFindStringByKeys(json, PLAN_KEYS);
  const result = {
    planName: normalizePlanName(planRaw),
    fiveHourPercent: null,
    fiveHourResetTime: null,
    fiveHourUpdateTime: null,
    mcpPercent: null,
    weeklyPercent: null,
    fiveHourLimit: null,
    mcpLimit: null,
    weeklyLimit: null,
    otherLimits: [],
    limits: [],
  };

  const candidates = [];
  collectObjects(json, candidates, 0);

  for (const item of candidates) {
    const kind = classifyLimit(item);
    const percent = readPercent(item);
    if (!kind) {
      if (percent !== null) result.otherLimits.push(limitDetail(item, 'other'));
      continue;
    }
    if (percent === null) continue;
    const detail = limitDetail(item, kind);
    result.limits.push(detail);
    if (kind === 'fiveHour' && result.fiveHourPercent === null) {
      result.fiveHourPercent = percent;
      result.fiveHourLimit = detail;
    }
    if (kind === 'fiveHour' && result.fiveHourResetTime === null) {
      result.fiveHourResetTime = detail.resetTime;
    }
    if (kind === 'mcp' && result.mcpPercent === null) {
      result.mcpPercent = percent;
      result.mcpLimit = detail;
    }
    if (kind === 'weekly' && result.weeklyPercent === null) {
      result.weeklyPercent = percent;
      result.weeklyLimit = detail;
    }
  }

  return result;
}

function collectObjects(obj, out, depth) {
  if (!obj || depth > 8) return;
  if (Array.isArray(obj)) {
    for (const item of obj) collectObjects(item, out, depth + 1);
    return;
  }
  if (typeof obj !== 'object') return;
  out.push(obj);
  for (const value of Object.values(obj)) collectObjects(value, out, depth + 1);
}

async function fetchQuota(env) {
  const baseRoot = normalizeBaseRoot(env.ANTHROPIC_BASE_URL || '');
  const authToken = env.ANTHROPIC_AUTH_TOKEN || '';
  const fallbackPlan = normalizePlanName(env.GLM_STATUSLINE_PLAN || '');
  const fallback = {
    planName: fallbackPlan || 'GLM',
    fiveHourPercent: null,
    fiveHourResetTime: null,
    fiveHourUpdateTime: null,
    mcpPercent: null,
    weeklyPercent: null,
    fiveHourLimit: null,
    mcpLimit: null,
    weeklyLimit: null,
    otherLimits: [],
    limits: [],
  };

  if (!baseRoot || !authToken) return fallback;

  const cache = loadCache();
  const cacheKey = `quota:${baseRoot}`;
  if (isFresh(cache[cacheKey])) {
    return { ...fallback, ...cache[cacheKey].value };
  }

  try {
    const json = await httpJson(`${baseRoot}/api/monitor/usage/quota/limit`, authToken);
    const value = extractQuotaData(json);
    const fetchedAt = Date.now();
    if (!value.planName) value.planName = fallback.planName;
    value.fiveHourUpdateTime = value.fiveHourResetTime || fetchedAt;
    cache[cacheKey] = { ts: Date.now(), value };
    saveCache(cache);
    return { ...fallback, ...value };
  } catch (err) {
    debugLog('quota API error', err);
    if (cache[cacheKey]?.value) return { ...fallback, ...cache[cacheKey].value };
    return fallback;
  }
}

function getClaudeModelRaw(sessionContext) {
  const model = sessionContext?.model;
  if (typeof model === 'string') return model;
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

function mapClaudeModelToGlm(sessionContext, env) {
  const raw = String(getClaudeModelRaw(sessionContext) || '').trim();
  const upper = raw.toUpperCase();

  let mapped = '';
  if (/OPUS/.test(upper)) mapped = env.ANTHROPIC_DEFAULT_OPUS_MODEL;
  else if (/SONNET/.test(upper)) mapped = env.ANTHROPIC_DEFAULT_SONNET_MODEL;
  else if (/HAIKU/.test(upper)) mapped = env.ANTHROPIC_DEFAULT_HAIKU_MODEL;
  else if (/GLM/.test(upper)) mapped = raw;

  mapped = mapped || env.ANTHROPIC_DEFAULT_SONNET_MODEL || env.GLM_STATUSLINE_MODEL || raw || 'GLM';
  return beautifyModelName(mapped);
}

function beautifyModelName(input) {
  let value = String(input || '').trim();
  if (!value) return 'GLM';
  value = value.replace(/^anthropic\//i, '');
  value = value.replace(/^zai\//i, '');
  value = value.replace(/^bigmodel\//i, '');
  if (/^glm/i.test(value)) {
    return value
      .replace(/^glm/i, 'GLM')
      .replace(/-air$/i, '-Air')
      .replace(/-flash$/i, '-Flash')
      .replace(/-plus$/i, '-Plus')
      .replace(/-thinking$/i, '-Thinking');
  }
  return value;
}

function getContextInfo(sessionContext, sessionTokens, env) {
  const cw =
    sessionContext?.context_window ||
    sessionContext?.contextWindow ||
    sessionContext?.context ||
    {};

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

  let percent = Number(
    cw.used_percentage ??
      cw.usedPercentage ??
      cw.percentage ??
      cw.percent ??
      cw.usage_percentage ??
      cw.usagePercentage
  );

  const used = Number(cw.used_tokens ?? cw.usedTokens ?? cw.current_tokens ?? cw.currentTokens);
  if (!Number.isFinite(percent) && Number.isFinite(used) && Number.isFinite(max) && max > 0) {
    percent = (used / max) * 100;
  }
  if (!Number.isFinite(percent) && Number.isFinite(sessionTokens) && Number.isFinite(max) && max > 0) {
    // Fallback only. Session tokens are not identical to live context tokens, but this is better than blank.
    percent = (sessionTokens / max) * 100;
  }

  return {
    percent: clampPercent(Number.isFinite(percent) ? percent : 0),
    max: Number.isFinite(max) && max > 0 ? max : DEFAULT_CONTEXT_WINDOW,
  };
}

function tokenTotalFromUsage(usage) {
  if (!usage || typeof usage !== 'object') return 0;
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
  let total = 0;
  for (const key of keys) {
    const value = Number(usage[key]);
    if (Number.isFinite(value) && value > 0) total += value;
  }
  return total;
}

function tokenTotalFromObject(obj) {
  if (!obj || typeof obj !== 'object') return 0;
  let total = 0;
  if (obj.usage && typeof obj.usage === 'object') total += tokenTotalFromUsage(obj.usage);
  if (obj.message?.usage && typeof obj.message.usage === 'object') total += tokenTotalFromUsage(obj.message.usage);
  if (obj.response?.usage && typeof obj.response.usage === 'object') total += tokenTotalFromUsage(obj.response.usage);
  return total;
}

function lineTimestamp(obj, fallbackMs) {
  const raw = obj?.timestamp || obj?.created_at || obj?.createdAt || obj?.message?.timestamp;
  const ms = raw ? new Date(raw).getTime() : NaN;
  return Number.isFinite(ms) ? ms : fallbackMs;
}

function readJsonlTokenStats(filePath, options = {}) {
  const { startMs = -Infinity, endMs = Infinity } = options;
  try {
    if (!filePath || !fs.existsSync(filePath)) return 0;
    const stat = fs.statSync(filePath);
    const content = fs.readFileSync(filePath, 'utf8');
    let total = 0;
    for (const line of content.split('\n')) {
      if (!line.trim()) continue;
      try {
        const obj = JSON.parse(line);
        const ts = lineTimestamp(obj, stat.mtimeMs);
        if (ts < startMs || ts >= endMs) continue;
        total += tokenTotalFromObject(obj);
      } catch (_) {
        // Ignore malformed jsonl lines.
      }
    }
    return total;
  } catch (_) {
    return 0;
  }
}

function formatDateTimeForMonitorApi(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(
    date.getDate()
  ).padStart(2, '0')} ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(
    2,
    '0'
  )}:${String(date.getSeconds()).padStart(2, '0')}`;
}

function recursiveFindNumberByKeys(obj, keys, depth = 0) {
  if (!obj || depth > 7) return null;
  if (Array.isArray(obj)) {
    for (const item of obj) {
      const found = recursiveFindNumberByKeys(item, keys, depth + 1);
      if (found !== null) return found;
    }
    return null;
  }
  if (typeof obj !== 'object') return null;

  for (const key of keys) {
    const value = Number(obj[key]);
    if (Number.isFinite(value) && value > 0) return value;
  }

  for (const value of Object.values(obj)) {
    const found = recursiveFindNumberByKeys(value, keys, depth + 1);
    if (found !== null) return found;
  }
  return null;
}

function recursiveFindNumberArrayByKeys(obj, keys, depth = 0) {
  if (!obj || depth > 7) return null;
  if (Array.isArray(obj)) {
    for (const item of obj) {
      const found = recursiveFindNumberArrayByKeys(item, keys, depth + 1);
      if (found) return found;
    }
    return null;
  }
  if (typeof obj !== 'object') return null;

  for (const key of keys) {
    const value = obj[key];
    if (Array.isArray(value)) {
      const numbers = value.map((item) => Number(item)).filter((item) => Number.isFinite(item) && item > 0);
      if (numbers.length) return numbers;
    }
  }

  for (const value of Object.values(obj)) {
    const found = recursiveFindNumberArrayByKeys(value, keys, depth + 1);
    if (found) return found;
  }
  return null;
}

function extractTokenSumFromModelUsage(json) {
  const root = json?.data || json;
  const aggregate = recursiveFindNumberByKeys(root, [
    'totalTokensUsage',
    'totalTokenUsage',
    'total_tokens_usage',
    'totalTokenCount',
    'total_tokens',
  ]);
  if (aggregate !== null) return aggregate;

  const series = recursiveFindNumberArrayByKeys(root, ['tokensUsage', 'tokenUsage', 'tokens_usage']);
  if (series) return series.reduce((sum, value) => sum + value, 0);

  const objects = [];
  collectObjects(json, objects, 0);
  let total = 0;
  for (const obj of objects) {
    total += tokenTotalFromUsage(obj);
  }
  return total;
}

async function fetchModelUsage(env, period) {
  const baseRoot = normalizeBaseRoot(env.ANTHROPIC_BASE_URL || '');
  const authToken = env.ANTHROPIC_AUTH_TOKEN || '';
  if (!baseRoot || !authToken) return null;

  const cache = loadCache();
  const cacheKey = `model:${baseRoot}:${period}`;
  if (isFresh(cache[cacheKey])) return cache[cacheKey].value;

  const now = new Date();
  const endTime = formatDateTimeForMonitorApi(now);
  const startDate = new Date(now.getTime());
  if (period === 'day') {
    startDate.setHours(0, 0, 0, 0);
  } else {
    startDate.setDate(startDate.getDate() - 30);
  }
  const startTime = formatDateTimeForMonitorApi(startDate);

  const url = `${baseRoot}/api/monitor/usage/model-usage?startTime=${encodeURIComponent(
    startTime
  )}&endTime=${encodeURIComponent(endTime)}`;

  try {
    const json = await httpJson(url, authToken);
    const value = extractTokenSumFromModelUsage(json);
    cache[cacheKey] = { ts: Date.now(), value };
    saveCache(cache);
    return value;
  } catch (err) {
    debugLog(`model usage API error (${period})`, err);
    if (cache[cacheKey]?.value !== undefined) return cache[cacheKey].value;
    return null;
  }
}

function formatLimitLine(label, detail, options = {}) {
  const percent = Number.isFinite(detail?.percent) ? `${detail.percent}%` : 'unavailable';
  const usage =
    Number.isFinite(detail?.used) && Number.isFinite(detail?.total)
      ? ` · ${formatTokens(detail.used)} / ${formatTokens(detail.total)}`
      : '';
  const reset =
    Number.isFinite(detail?.resetTime) && options.showReset
      ? ` · resets ${options.longReset ? formatLocalDateTime(detail.resetTime) : formatTimeHHmm(detail.resetTime)}`
      : '';
  return `${label}: ${percent}${usage}${reset}`;
}

function cacheAgeFor(key) {
  const cache = loadCache();
  const entry = cache[key];
  return entry && typeof entry.ts === 'number' ? Date.now() - entry.ts : NaN;
}

function apiHostLabel(baseRoot) {
  if (!baseRoot) return 'not configured';
  try {
    return new URL(baseRoot).host;
  } catch (_) {
    return baseRoot;
  }
}

function isPlanDetailsMode() {
  return process.argv.includes('--plan-details') || process.argv.includes('plan-details');
}

function isPreviewMode() {
  return process.argv.includes('--preview') || process.argv.includes('preview');
}

async function renderPlanDetails() {
  const env = mergeEnvFromSettings({});
  const baseRoot = normalizeBaseRoot(env.ANTHROPIC_BASE_URL || '');
  const quotaCacheKey = `quota:${baseRoot}`;
  const [quota, dayFromApi, monthFromApi] = await Promise.all([
    fetchQuota(env),
    fetchModelUsage(env, 'day'),
    fetchModelUsage(env, 'month'),
  ]);

  const lines = ['GLM Coding Plan', `Plan: ${quota.planName || normalizePlanName(env.GLM_STATUSLINE_PLAN) || 'GLM'}`];
  lines.push(
    formatLimitLine('5H', quota.fiveHourLimit || { percent: quota.fiveHourPercent, resetTime: quota.fiveHourResetTime }, { showReset: true })
  );
  lines.push(formatLimitLine('MCP', quota.mcpLimit || { percent: quota.mcpPercent }));
  if (quota.weeklyLimit || quota.weeklyPercent !== null) {
    lines.push(formatLimitLine('Weekly', quota.weeklyLimit || { percent: quota.weeklyPercent }, { showReset: true, longReset: true }));
  }
  for (const detail of quota.otherLimits || []) {
    const label = detail.name ? titleCase(detail.name) : 'Other';
    lines.push(formatLimitLine(label, detail, { showReset: true, longReset: true }));
  }
  lines.push(`Day: ${formatTokens(dayFromApi ?? 0)} tokens`);
  lines.push(`30D: ${formatTokens(monthFromApi ?? 0)} tokens`);
  lines.push(
    `API: ${apiHostLabel(baseRoot)} · key ${env.ANTHROPIC_AUTH_TOKEN ? 'configured' : 'missing'} · cache ${formatAge(
      cacheAgeFor(quotaCacheKey)
    )}`
  );

  return lines.join('\n');
}

async function readStdinJson() {
  let data = '';
  try {
    for await (const chunk of process.stdin) data += chunk;
    return data.trim() ? JSON.parse(data) : {};
  } catch (_) {
    return {};
  }
}

async function renderStatusLine(sessionContext = {}) {
  const env = mergeEnvFromSettings(sessionContext);
  const config = readStatusConfig(env);

  const transcriptPath = expandHome(
    sessionContext?.transcript_path || sessionContext?.transcriptPath || sessionContext?.conversation_log_path || ''
  );
  const sessionTokens = readJsonlTokenStats(transcriptPath);

  const quota = await fetchQuota(env);
  const contextInfo = getContextInfo(sessionContext, sessionTokens, env);
  const fiveHourPercent = quota.fiveHourPercent ?? 0;
  const fiveHourReset = formatResetHHmm(quota.fiveHourUpdateTime || quota.fiveHourResetTime);
  const needsDay = config.display.includes('day');
  const needsMonth = config.display.includes('30d');
  const [dayTokens, monthTokens] = await Promise.all([
    needsDay ? fetchModelUsage(env, 'day') : Promise.resolve(null),
    needsMonth ? fetchModelUsage(env, 'month') : Promise.resolve(null),
  ]);

  const planName = quota.planName || normalizePlanName(env.GLM_STATUSLINE_PLAN) || 'GLM';
  const fields = {
    plan: planName,
    '5h': `5H ${renderBar(fiveHourPercent)} @${fiveHourReset}`,
    mcp: `MCP ${renderBar(quota.mcpPercent ?? 0)}`,
    context: `Context ${renderBar(contextInfo.percent)}`,
    model: `Model ${mapClaudeModelToGlm(sessionContext, env)}`,
    session: `Session ${formatTokens(sessionTokens)}`,
    day: `Day ${formatTokens(dayTokens ?? 0)}`,
    '30d': `30D ${formatTokens(monthTokens ?? 0)}`,
  };

  const segments = config.display.map((item) => fields[item]).filter(Boolean);
  return wrapSegments(segments.length ? segments : DEFAULT_DISPLAY.map((item) => fields[item]), config.maxWidth);
}

async function main() {
  if (isPlanDetailsMode()) {
    console.log(await renderPlanDetails());
    return;
  }

  const sessionContext = await readStdinJson();
  const output = await renderStatusLine(sessionContext);
  console.log(isPreviewMode() ? `Preview:\n${output}` : output);
}

main().catch((err) => {
  // Keep Claude Code usable even if the script crashes.
  const msg = err && err.message ? err.message : String(err);
  if (isPlanDetailsMode()) {
    console.log('GLM Coding Plan\nPlan: GLM\n5H: unavailable\nMCP: unavailable\nDay: 0 tokens\n30D: 0 tokens\nAPI: not configured · key missing · cache unknown');
    return;
  }
  console.log(`5H ${renderBar(0)} @--:-- │ MCP ${renderBar(0)} │ Session 0 │ Day 0`);
  if (process.env.GLM_STATUSLINE_DEBUG === '1') {
    console.error(msg);
  }
});
