// 严格模式：强制变量声明、把静默错误转为显式抛错，文件顶层统一开启
'use strict';

// 进度条的默认格子数（每格一个字符位）
const BAR_WIDTH = 8;

// Shade levels for gap-free bar rendering (each fills the full cell width)
// ░=empty ▒=medium ▓=dark █=full
// 4 levels × 8 cells → 24 steps, ~4.17% per step
// 阴影等级字符表（从空到满）：让一格内还能再分 4 档，8 格合计约 24 级梯度
const SHADE_LEVELS = ['░', '▒', '▓', '█'];
// 阴影字符集合：displayLength 用它做 O(1) 成员判断（块字符按显示宽度 2 计）
const SHADE_CHAR_SET = new Set(SHADE_LEVELS);

// 计算字符串在终端里的"显示列宽"（不是字符个数）：
// ░▒▓█ 块字符与 CJK 等宽字符在终端占 2 列，其余占 1 列 —— 换行宽度判断必须用它而非 .length
function displayLength(value) {
  // 累加的列宽总数
  let width = 0;
  // 按码点逐字符遍历（Array.from 正确切分多字节字符；null/undefined 先归一为空串）
  for (const char of Array.from(String(value || ''))) {
    // 阴影块字符：按 2 列计
    if (SHADE_CHAR_SET.has(char)) {
      width += 2;
    } else if (/[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︐-︙︰-﹯＀-｠￠-￦]/u.test(char)) {
      // CJK / 谚文 / 全角标点等宽字符区间：同样按 2 列计
      width += 2;
    } else {
      // 其余（ASCII、半角符号等）按 1 列计
      width += 1;
    }
  }
  // 返回总列宽
  return width;
}

// 把多个字段段（segment）拼成不超过 maxWidth 列的多行文本：
// 段与段之间用 " │ " 连接，当前行塞不下下一段就换行 —— 状态栏自动换行的核心
function wrapSegments(segments, maxWidth) {
  // 宽度未知或非法时不强行折行：单行拼接，交给终端自行折行
  if (!Number.isFinite(maxWidth) || maxWidth <= 0) return segments.join(' │ ');

  // 已定格式的行列表
  const lines = [];
  // 当前正在拼接的行
  let current = '';
  // 逐段尝试并入当前行
  for (const segment of segments) {
    // 候选新行：当前行已有内容就追加 " │ "+段，否则该段自己就是开头
    const next = current ? `${current} │ ${segment}` : segment;
    // 并入后超宽（且当前行非空）→ 当前行定格，新段另起一行
    if (current && displayLength(next) > maxWidth) {
      // 当前行收入结果
      lines.push(current);
      // 新段成为新一行的开头
      current = segment;
    } else {
      // 没超宽：直接并入当前行
      current = next;
    }
  }
  // 循环结束后把最后一行也收进去（可能为空串则跳过）
  if (current) lines.push(current);
  // 各行以换行符连接返回
  return lines.join('\n');
}

// " │ " 分隔符的显示列宽（空格 + 全角竖线 + 空格）
const SEPARATOR_WIDTH = 3;

// 计算一行段数组渲染后的显示列宽：各段宽度之和 + 分隔符宽度
//（在拼接字符串之前就能算，供 mergeRows 判断"并进来是否超宽"）
function segmentsWidth(segments) {
  // 各段显示宽度求和（复用 displayLength：CJK/块字符按 2 列计）
  const total = segments.reduce((sum, segment) => sum + displayLength(segment), 0);
  // n 个段之间有 n-1 个 " │ " 分隔符
  return total + SEPARATOR_WIDTH * Math.max(0, segments.length - 1);
}

// 行合并：相邻两行（甚至三行）的总宽度能装进一行（≤ maxWidth）时，把它们合并成一行。
// 行是原子单位 —— 只做整行与整行的合并，绝不把某一行拆散与别行穿插；按行序贪心累积
//（row1+row2 装得下就并，再 +row3 还装得下就继续并）。maxWidth 未知/非法（≤0）时不
// 合并，与 wrapSegments 的"无宽度不折行"口径一致。
function mergeRows(rows, maxWidth) {
  // 先滤掉空行（没有选中任何字段的分组）
  const nonEmpty = rows.filter((row) => row.length);
  // 无有效宽度信息：原样返回（不合并）
  if (!Number.isFinite(maxWidth) || maxWidth <= 0) return nonEmpty;
  // 合并结果（每项是一个段数组 = 渲染后的一行）
  const merged = [];
  // 当前正在累积的行（null = 还没开始）
  let current = null;
  // 按行序逐行尝试并入
  for (const row of nonEmpty) {
    if (current === null) {
      // 第一行：作为累积起点（复制一份，不改动调用方的数组）
      current = [...row];
    } else if (segmentsWidth([...current, ...row]) <= maxWidth) {
      // 并入后总宽仍在一行以内 → 合并进当前行
      current = [...current, ...row];
    } else {
      // 装不下 → 当前行定格收进结果，新行另起
      merged.push(current);
      current = [...row];
    }
  }
  // 最后一行别忘了收尾
  if (current) merged.push(current);
  // 返回合并后的行列表
  return merged;
}

// 把各种形态的"重置时间"归一成毫秒时间戳：Date 对象 / 秒或毫秒数字 / 数字字符串 / ISO 或空格日期串。
// 全部不匹配时返回 null（渲染层显示为 --），绝不抛错
function parseResetTime(value) {
  // 已是有效 Date：直接取毫秒时间戳
  if (value instanceof Date && Number.isFinite(value.getTime())) return value.getTime();

  // 合法正数：按大小区分秒/毫秒 —— 小于 1e10 视为秒级，×1000 归一到毫秒
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return value < 10_000_000_000 ? value * 1000 : value;
  }

  // 字符串形态
  if (typeof value === 'string') {
    // 先去掉首尾空白
    const trimmed = value.trim();
    // 空串：没有时间信息
    if (!trimmed) return null;
    // 尝试按"纯数字字符串"解析（同样按秒/毫秒歧义规则处理）
    const numeric = Number(trimmed);
    if (Number.isFinite(numeric) && numeric > 0) {
      return numeric < 10_000_000_000 ? numeric * 1000 : numeric;
    }
    // 非纯数字：按日期字符串解析 —— 把 "2024-01-02 03:04" 的空格分隔符替换成 ISO 的 "T"，提高 Date.parse 兼容性
    const normalized = trimmed.includes('T') ? trimmed : trimmed.replace(' ', 'T');
    // 能解析出有效时间就返回毫秒时间戳
    const parsed = Date.parse(normalized);
    if (Number.isFinite(parsed)) return parsed;
  }

  // 以上都不匹配：明确返回 null 表示"无有效时间"
  return null;
}

// 把百分比夹取成 [0,100] 的整数：NaN/Infinity 等非法值按 0 处理
function clampPercent(value) {
  // 非有限数 → 0
  if (!Number.isFinite(value)) return 0;
  // 先四舍五入再夹到 0..100
  return Math.max(0, Math.min(100, Math.round(value)));
}

// 渲染 "███▓░░░░ 42%" 形式的进度条文本（宽度默认 8 格）
function renderBar(percent, width = BAR_WIDTH) {
  // Unknown / missing value: render an empty bar with `--%` instead of a misleading `0%`.
  // 未知/缺失读数：渲染全空条 + "--%"，绝不显示误导性的 "0%"（关键不变量：unknown → --）
  if (percent == null || !Number.isFinite(Number(percent))) {
    // 固定格式：全空格 + --%
    return `${'░'.repeat(width)} --%`;
  }
  // 先夹取成 0..100 的整数百分比
  const p = clampPercent(percent);
  // 3 transitions per cell (░→▒→▓→█), giving width*3 total steps
  // 每格内部的过渡级数：4 档字符 → 3 次过渡，8 格共 24 级
  const subSteps = SHADE_LEVELS.length - 1;
  // 总梯度级数 = 格数 × 每格过渡数
  const totalSteps = width * subSteps;
  // 百分比换算成"已填充级数"，向上取整并夹在 [0, totalSteps]（有读数就有可见进度）
  const filledSteps = Math.max(0, Math.min(totalSteps, Math.ceil((p / 100) * totalSteps)));

  // 完全填满的格数（渲染为 █）
  const fullCells = Math.floor(filledSteps / subSteps);
  // 填不满一格的剩余级数 → 对应 ▒（1 级）或 ▓（2 级）的半满格
  const remainder = filledSteps % subSteps;

  // 逐格拼出进度条字符串
  let bar = '';
  for (let i = 0; i < width; i++) {
    // 位于满格区间 → █
    if (i < fullCells) {
      bar += '█';
    } else if (i === fullCells && remainder > 0) {
      // 正好轮到半满的那一格 → 按剩余级数取 ▒ 或 ▓
      bar += SHADE_LEVELS[remainder];
    } else {
      // 其余 → 空格 ░
      bar += '░';
    }
  }

  // 拼上百分比文本，如 "███▓░░░░ 42%"
  return `${bar} ${p}%`;
}

// token 数量缩写：160000 → "160K"、42_800_000 → "42.8M"、1_200_000_000 → "1.2B"
function formatTokens(value) {
  // 非法/缺失读数归 0
  const n = Number(value) || 0;
  // ≥ 10 亿 → B（十亿）单位
  if (n >= 1_000_000_000) return `${trimLargeNumber(n / 1_000_000_000)}B`;
  // ≥ 100 万 → M（百万）单位
  if (n >= 1_000_000) return `${trimNumber(n / 1_000_000)}M`;
  // ≥ 1000 → K（千）单位
  if (n >= 1_000) return `${trimNumber(n / 1_000)}K`;
  // 不足 1000：直接显示整数
  return String(Math.round(n));
}

// B 档大数的小数位与尾随零修剪：<10 保留 2 位小数、<100 保留 1 位、更大取整；"1.50" → "1.5"、"2.00" → "2"
function trimLargeNumber(value) {
  // 按量级选择小数位数
  const rounded = value < 10 ? value.toFixed(2) : value < 100 ? value.toFixed(1) : value.toFixed(0);
  // 先去掉纯整数化产生的 ".00"，再把 "1.50" 这类尾零修掉
  return rounded.replace(/\.0+$/, '').replace(/(\.\d*[1-9])0+$/, '$1');
}

// K/M 档的小数位与尾零修剪：≥100 取整、否则保留 1 位小数；"42.0" → "42"
function trimNumber(value) {
  // 按量级选择小数位数
  const rounded = value >= 100 ? value.toFixed(0) : value.toFixed(1);
  // 去掉整数的 ".0" 后缀
  return rounded.replace(/\.0$/, '');
}

// 毫秒时间戳 → "YYYY-MM-DD HH:mm" 本地时间文本；非法输入返回 "--"。
// 下面的模板字符串因行宽格式化跨了多行，内部不能插注释 ——
// 它做的事：年-月-日 时:分，月/日/时/分 各段 padStart(2,'0') 补零
function formatLocalDateTime(ms) {
  // 非法时间 → 占位符
  if (!Number.isFinite(ms)) return '--';
  // 毫秒时间戳转本地时区 Date
  const date = new Date(ms);
  // （多行模板字符串整体输出 "YYYY-MM-DD HH:mm"，各位补零）
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(
    date.getDate()
  ).padStart(2, '0')} ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(
    2,
    '0'
  )}`;
}

// 毫秒时间戳/Date → "HH:mm" 文本；非法输入返回 "--:--"（用于 @重置时刻 这类展示）
function formatTimeHHmm(ms) {
  // 兼容 Date 入参：统一转成毫秒数字
  const value = ms instanceof Date ? ms.getTime() : Number(ms);
  // 非法时间 → 占位符
  if (!Number.isFinite(value)) return '--:--';
  // 转本地时区 Date
  const date = new Date(value);
  // 时、分两位补零后拼接
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

// 任意形态的重置时间 → "HH:mm"：先 parseResetTime 归一成时间戳，失败显示 "--:--"
function formatResetHHmm(timestamp) {
  // 把 Date/秒级数字/字符串等归一成毫秒时间戳
  const ms = parseResetTime(timestamp);
  // 归一失败 → 占位符
  if (ms === null) return '--:--';
  // 复用 HH:mm 格式化
  return formatTimeHHmm(ms);
}

// 毫秒时间戳/Date → "MM-DD" 文本；非法输入返回 "--"（用于月-日重置日展示）
function formatDateMMDD(ms) {
  // 兼容 Date 入参：统一转成毫秒数字
  const value = ms instanceof Date ? ms.getTime() : Number(ms);
  // 非法时间 → 占位符
  if (!Number.isFinite(value)) return '--';
  // 转本地时区 Date
  const date = new Date(value);
  // 月、日两位补零后拼接（注意 getMonth 从 0 起，需要 +1）
  return `${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

// 任意形态的重置时间 → "MM-DD"：先 parseResetTime 归一成时间戳，失败显示 "--"
function formatResetMMDD(timestamp) {
  // 归一成毫秒时间戳
  const ms = parseResetTime(timestamp);
  // 归一失败 → 占位符
  if (ms === null) return '--';
  // 复用 MM-DD 格式化
  return formatDateMMDD(ms);
}

// 毫秒时长 → "Ns ago / Nm ago / Nh ago" 相对时间文本；非法或负值返回 "unknown"
function formatAge(ms) {
  // 非有限数或负数 → unknown
  if (!Number.isFinite(ms) || ms < 0) return 'unknown';
  // 先换算成整秒
  const seconds = Math.round(ms / 1000);
  // 不足 1 分钟 → 秒级
  if (seconds < 60) return `${seconds}s ago`;
  // 换算成整分钟
  const minutes = Math.round(seconds / 60);
  // 不足 1 小时 → 分钟级
  if (minutes < 60) return `${minutes}m ago`;
  // 换算成整小时（不再升级更大单位，状态栏场景够用）
  const hours = Math.round(minutes / 60);
  // 小时级文本
  return `${hours}h ago`;
}

// 导出全部渲染原语（消费者：glm-statusline.js 的字段渲染与 --plan-details 视图）
module.exports = {
  // 百分比夹取成 [0,100] 整数
  clampPercent,
  // 终端显示列宽计算（CJK/块字符按 2 列）
  displayLength,
  // 相对时间文本（Ns/Nm/Nh ago）
  formatAge,
  // 时间戳 → "MM-DD"
  formatDateMMDD,
  // 时间戳 → "YYYY-MM-DD HH:mm" 本地时间
  formatLocalDateTime,
  // 任意重置时间 → "HH:mm"
  formatResetHHmm,
  // 任意重置时间 → "MM-DD"
  formatResetMMDD,
  // 时间戳 → "HH:mm"
  formatTimeHHmm,
  // token 数 → "42.8M" 式缩写
  formatTokens,
  // 各形态时间 → 毫秒时间戳（失败为 null）
  parseResetTime,
  // 渲染 "███░░░░ 42%" 进度条
  renderBar,
  // 相邻行宽度够时把多行段数组合并成一行
  mergeRows,
  // 按终端宽度自动换行拼接段
  wrapSegments,
};
