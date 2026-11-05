// 严格模式：强制变量声明、把静默错误转为显式抛错，文件顶层统一开启
'use strict';

// 全部可用字段的"规范顺序"，是排序/去重的唯一事实来源：
// 新增显示字段必须先加进这个数组（分组布局的行内排序也以它为准）。
// 未配置 display 时默认显示这里的全部字段（无单独的默认集）
const DISPLAY_FIELDS = ['plan', '5h', 'mcp', 'context', 'model', 'effort', 'session', 'speed', 'day', '30d'];
// 每个 field key 对应的展示标签：用于配置界面（bin/glm-statusline-install.js）里的字段清单文案
const FIELD_LABELS = {
  // plan 字段：当前订阅的套餐名
  plan: 'plan',
  // 5h 字段：5 小时滚动窗口的额度使用百分比
  '5h': '5h quota',
  // mcp 字段：MCP / 工具调用的额度使用百分比
  mcp: 'mcp/tools',
  // context 字段：上下文窗口占用百分比
  context: 'context',
  // model 字段：映射后的 GLM 模型名
  model: 'model',
  // effort 字段：推理努力档位（high / medium / low）
  effort: 'effort level',
  // session 字段：本会话累计 token 数
  session: 'session tokens',
  // speed 字段：输出速度（当前速率 + 平均速率，单位 tok/s）
  speed: 'output speed',
  // day 字段：当日 token 用量
  day: 'day tokens',
  // 30d 字段：近 30 天 token 用量
  '30d': '30d tokens',
};

// 清洗用户配置里的 display 列表：过滤非法字段名、去重、保持用户书写顺序。
// 传入非数组（缺失或类型错误）时得到空数组 —— 空数组即"未配置"，调用方据此显示全部字段
function normalizeDisplayList(value) {
  // 非数组一律当作"没配置"处理
  const raw = Array.isArray(value) ? value : [];
  // 已收录字段的去重集合
  const seen = new Set();
  // 清洗后的结果列表
  const display = [];
  // 逐项检查用户书写的字段名
  for (const item of raw) {
    // 只接受 DISPLAY_FIELDS 中存在的名字，非法名置为空串（等效丢弃）
    const normalized = DISPLAY_FIELDS.includes(item) ? item : '';
    // 合法且尚未收录才进入结果
    if (normalized && !seen.has(normalized)) {
      // 标记为已收录
      seen.add(normalized);
      // 追加进结果列表
      display.push(normalized);
    }
  }
  // 返回清洗结果（可能为空数组）
  return display;
}

// 把任意顺序的字段列表重排为 DISPLAY_FIELDS 的规范顺序，
// 保证分组分区与 configure 勾选后的展示顺序稳定（顺带完成去重）
function orderDisplay(display) {
  // 用集合加速"是否选中"的判断
  const selected = new Set(display);
  // 按规范总表过滤出被选中的字段：天然输出规范顺序
  return DISPLAY_FIELDS.filter((field) => selected.has(field));
}

// Category groups for the (only) grouped layout; adjacent rows auto-merge when they fit.
// Order of groups = on-screen line order. Within a group, DISPLAY_FIELDS canonical order is used.
// Every DISPLAY_FIELDS key belongs to exactly one group. `id` is an internal label only.
// 分组布局（默认布局）的行定义：数组顺序 = 屏幕上从上到下的行顺序，组内再用规范顺序
const FIELD_GROUPS = [
  // 第 1 行：模型名 / 努力档位 / 输出速度
  { id: 'row1', fields: ['model', 'effort', 'speed'] },
  // 第 2 行：上下文 / 会话 token / 当日 / 30 天
  { id: 'row2', fields: ['context', 'session', 'day', '30d'] },
  // 第 3 行：套餐名 / 5H 配额 / MCP 配额
  { id: 'row3', fields: ['plan', '5h', 'mcp'] },
];

// Partition a selected field list into per-group field-key arrays (canonical order within group).
// Groups with no selected fields yield an empty array, which the caller skips.
// 把选中的字段列表切分为"每行一个数组"的二维数组（组内同样按规范顺序）；
// 某行没有选中字段时该行为空数组，由调用方跳过（不渲染空行）
function groupDisplay(display) {
  // 选中字段的集合
  const selected = new Set(display);
  // 逐组映射出该组实际要显示的字段列表
  return FIELD_GROUPS.map((group) => {
    // 本组定义的字段集合
    const inGroup = new Set(group.fields);
    // 规范顺序 ∩ 本组字段 ∩ 选中字段 = 本行最终的字段列表
    return DISPLAY_FIELDS.filter((field) => inGroup.has(field) && selected.has(field));
  });
}

// 导出本模块全部公共 API（消费者：glm-statusline.js 与 bin/glm-statusline-install.js）
module.exports = {
  // 字段总表（规范顺序，唯一事实来源；未配置 display 时默认全显）
  DISPLAY_FIELDS,
  // 分组布局的行定义
  FIELD_GROUPS,
  // 字段 key → 展示标签映射
  FIELD_LABELS,
  // 选中字段 → 按行分组的二维数组
  groupDisplay,
  // 清洗用户 display 配置（过滤非法名 + 去重）
  normalizeDisplayList,
  // 按规范顺序重排字段列表
  orderDisplay,
};
