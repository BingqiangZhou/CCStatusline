// 严格模式：强制变量声明、把静默错误转为显式抛错，文件顶层统一开启
'use strict';

// 文件系统：非 TTY 路径的全量 stdin 读取（fd 0）
const fs = require('fs');
// readline：TTY 交互式配置的逐行读取
const readline = require('readline');
// 字段定义库：字段总表 / 标签 / 清洗回退 / 规范排序
const {
  // 字段总表重命名为 FIELD_ORDER（= 编号列表顺序；未配置时默认全选全部字段）
  DISPLAY_FIELDS: FIELD_ORDER,
  // 字段 → 标签映射（列表文案）
  FIELD_LABELS,
  // display 清洗 + 未配置回退全字段
  displayOrDefault,
  // 按规范顺序重排（切换字段后保持稳定顺序）
  orderDisplay,
} = require('./display-fields');
// 文件读写共享库：配置文件读写与路径解析
const { readJsonFile, writeJsonFile, configFilePath } = require('./file-io');

// 交互式配置模块：/glm-statusline:configure 背后的勾选界面（打印清单 + 预览 + 即时保存）。
// renderPreview（用真实状态栏脚本渲染当前配置的预览）留在安装器 —— install() 也用它 ——
// 经 options 回调注入，本模块不依赖安装器的路径常量。

// 状态栏用户配置文件（display）；路径解析在 lib/file-io.js（env 覆盖 → 默认 + ~ 展开）
const CONFIG_FILE = configFilePath();
// 安装器侧的 JSON 读取契约：文件缺失/为空 → 空对象，解析失败 → 抛错（与核心的静默兜底刻意相反：
// 配置场景要让用户看到坏文件，状态栏则绝不能崩 —— 见 lib/file-io.js readJsonFile 注释）
const STRICT_JSON_READ = { fallback: {}, throwOnParse: true };

// 写状态栏配置文件（2 空格缩进 + 末尾换行，与 Claude Code 手写格式一致）
function writeConfig(config) {
  // 委托共享写入原语（newline：末尾换行；非原子 + 出错冒泡 —— 与原实现一致）
  writeJsonFile(CONFIG_FILE, config, { newline: true });
}

// 从既有配置构造交互式配置的初始状态（老用户的勾选延续下来）
function baseConfigFromFile() {
  // 读既有配置（坏文件抛错 —— 必须发生在任何 writeConfig 之前，坏文件不能被静默覆写）
  const previous = readJsonFile(CONFIG_FILE, STRICT_JSON_READ);
  // 返回初始配置
  return {
    // 显示字段：有配置用配置的；未配置 → 默认勾选全部字段（清洗+回退逻辑在 lib/display-fields.js）
    //（布局已统一为分组多行 + 自动合并，配置文件里残留的 layout 键被忽略）
    display: displayOrDefault(previous.display),
  };
}

// 打印交互式配置界面（勾选清单 + 预览；renderPreview 由安装器注入）
function printInteractiveState(config, renderPreview) {
  // 当前选中字段的集合
  const selected = new Set(config.display);
  // 空行分隔
  console.log('');
  // 操作提示：数字切换勾选，q 结束（布局已固定为分组多行 + 自动合并，无切换项）
  console.log('Select fields to show. Type a number to toggle it, q to finish.');
  // 按规范顺序列出全部字段（编号 = 输入的数字）
  FIELD_ORDER.forEach((field, index) => {
    // 一行一个字段：[x]/[ ] 勾选框 + 标签
    console.log(`${index + 1}. [${selected.has(field) ? 'x' : ' '}] ${FIELD_LABELS[field]}`);
  });
  // 空行分隔
  console.log('');
  // 末尾打印当前配置的实际预览
  console.log(renderPreview());
}

// 按编号切换一个字段的勾选状态
function toggleField(config, input) {
  // 输入转数字并 -1（界面从 1 数，数组从 0 数）
  const index = Number(String(input).trim()) - 1;
  // 非法编号（非整数/越界）
  if (!Number.isInteger(index) || index < 0 || index >= FIELD_ORDER.length) {
    // 提示忽略该输入
    console.log(`Ignored input: ${input}`);
    // 原配置返回
    return config;
  }

  // 目标字段
  const field = FIELD_ORDER[index];
  // 复制一份 display 数组再改（不直接改原数组）
  const display = [...config.display];
  // 该字段当前的下标
  const existingIndex = display.indexOf(field);
  // 已选中 → 这次是取消勾选
  if (existingIndex >= 0) {
    // 最后一个字段不允许取消（至少保留一个）
    if (display.length === 1) {
      // 提示必须保留一个
      console.log('At least one field must stay selected.');
      // 原配置返回
      return config;
    }
    // 移除该字段
    display.splice(existingIndex, 1);
  // 未选中 → 这次是勾选
  } else {
    // 追加该字段
    display.push(field);
  }
  // 返回新配置（display 重新按规范顺序排序）
  return { ...config, display: orderDisplay(display) };
}

// 交互式配置主循环（renderPreview 经 options 注入；两条输入路径逐字保持）
async function interactiveConfigure(options = {}) {
  // 预览回调（安装器提供）
  const { renderPreview } = options;
  // 初始配置 = 既有配置归一化（坏配置文件在此抛错，早于任何写入）
  let config = baseConfigFromFile();
  // 先落盘一次（保证配置文件存在）
  writeConfig(config);
  // 打印界面
  printInteractiveState(config, renderPreview);

  // 处理一行输入；返回 false 表示结束循环
  const handleInput = (line) => {
    // 归一化输入（去空白、转小写）
    const value = String(line || '').trim().toLowerCase();
    // 空输入 / q / quit / done → 结束
    if (!value || value === 'q' || value === 'quit' || value === 'done') return false;
    // 其余输入按编号切换字段
    config = toggleField(config, value);
    // 立即保存
    writeConfig(config);
    // 刷新界面
    printInteractiveState(config, renderPreview);
    // 继续循环
    return true;
  };

  // 非 TTY（脚本/管道喂输入）：一次性读完按行处理
  if (!process.stdin.isTTY) {
    // 从 stdin 全量读取（fd 0）
    const input = fs.readFileSync(0, 'utf8');
    // 逐行处理
    for (const line of input.split(/\r?\n/)) {
      // 遇到结束输入即停止
      if (!handleInput(line)) break;
    }
    // 返回
    return;
  }

  // TTY：readline 逐行交互
  const rl = readline.createInterface({
    // 输入流
    input: process.stdin,
    // 输出流
    output: process.stdout,
    // 提示语
    prompt: 'Choose field number, q to finish: ',
  });
  // 先显示一次提示
  rl.prompt();
  // 逐行等待输入
  for await (const line of rl) {
    // 结束输入即退出循环
    if (!handleInput(line)) break;
    // 每行后重新显示提示
    rl.prompt();
  }
  // 关闭 readline
  rl.close();
}

// configure 子命令（交互式；拒绝任何参数 —— 与技能说明一致）
async function configure(args = [], options = {}) {
  // 带参数
  if (args.length) {
    // 报错引导用交互模式
    throw new Error('Use the interactive selector: glm-statusline-install.js configure');
  }
  // 进入交互配置（注入预览回调）
  await interactiveConfigure(options);
}

// 导出本模块全部公共 API（消费者：bin/glm-statusline-install.js）
module.exports = {
  // configure 子命令（拒绝参数，交互式）
  configure,
  // 交互式配置主循环（供需要自定义入口时直接调用）
  interactiveConfigure,
  // 配置文件路径（安装器的 renderPreview 子进程 env 要用同一文件）
  CONFIG_FILE,
};
