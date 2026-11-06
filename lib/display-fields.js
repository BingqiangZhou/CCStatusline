// 严格模式：强制变量声明、把静默错误转为显式抛错，文件顶层统一开启
'use strict';

// 全部字段的"规范顺序"，是排序/去重的唯一事实来源：
// 新增显示字段必须先加进这个数组（分组布局的行内排序也以它为准）。
// 状态栏固定渲染这里的全部字段，没有字段选择配置。
const DISPLAY_FIELDS = ['plan', '5h', 'mcp', 'context', 'model', 'effort', 'session', 'speed', 'day', '30d'];

// 唯一布局（固定分组）的行定义：数组顺序 = 屏幕上从上到下的行序；
// 组内字段按 DISPLAY_FIELDS 规范顺序排列，每个 DISPLAY_FIELDS 字段恰好属于一组；
// `id` 只是内部标签，不参与渲染。
const FIELD_GROUPS = [
  // 第 1 行：模型名 / 努力档位 / 输出速度
  { id: 'row1', fields: ['model', 'effort', 'speed'] },
  // 第 2 行：上下文 / 会话 token / 当日 / 30 天
  { id: 'row2', fields: ['context', 'session', 'day', '30d'] },
  // 第 3 行：套餐名 / 5H 配额 / MCP 配额
  { id: 'row3', fields: ['plan', '5h', 'mcp'] },
];

// 把全部字段切分为"每行一个数组"的二维数组（组内同样按规范顺序）
function groupRows() {
  // 逐组映射出该组要显示的字段列表
  return FIELD_GROUPS.map((group) => {
    // 本组定义的字段集合
    const inGroup = new Set(group.fields);
    // 规范顺序 ∩ 本组字段 = 本行最终的字段列表
    return DISPLAY_FIELDS.filter((field) => inGroup.has(field));
  });
}

// 导出本模块全部公共 API（消费者：bin/glm-statusline.js）
module.exports = {
  // 字段总表（规范顺序，唯一事实来源；状态栏固定全显）
  DISPLAY_FIELDS,
  // 分组布局的行定义
  FIELD_GROUPS,
  // 全部字段 → 按行分组的二维数组
  groupRows,
};
