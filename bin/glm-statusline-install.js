#!/usr/bin/env node
// 严格模式：强制变量声明、静默错误显式抛错
'use strict';

// 文件系统：读写 settings / 配置 / 启动器文件
const fs = require('fs');
// 系统信息：定位主目录
const os = require('os');
// 路径处理
const path = require('path');
// readline：TTY 交互式配置的逐行读取
const readline = require('readline');
// 子进程：同步调用状态栏脚本做预览、让启动器转发执行
const { spawnSync } = require('child_process');
// 字段定义库（安装/配置界面要用字段清单与标签）
const {
  // 字段总表重命名为 FIELD_ORDER（= 编号列表顺序；未配置时默认全选全部字段）
  DISPLAY_FIELDS: FIELD_ORDER,
  // 字段 → 标签映射（列表文案）
  FIELD_LABELS,
  // display 清洗
  normalizeDisplayList,
  // 按规范顺序重排（切换字段后保持稳定顺序）
  orderDisplay,
} = require('../lib/display-fields');

// 本插件源码根目录（bin/ 的上一级）
const PLUGIN_ROOT = path.resolve(__dirname, '..');
// 入口脚本路径（安装时校验存在性；也是启动器的回退目标）
const LAUNCHER = path.join(PLUGIN_ROOT, 'bin', 'glm-statusline.js');
// Claude 主 settings 文件（statusLine 配置写在这里；可用环境变量重定向 —— 测试隔离用）
const SETTINGS_FILE =
  process.env.GLM_STATUSLINE_SETTINGS_FILE || path.join(os.homedir(), '.claude', 'settings.json');
// 稳定启动器路径（~/.claude/glm-statusline-launcher.js；statusLine.command 指向它而非易变的缓存路径）
const STABLE_LAUNCHER_FILE =
  process.env.GLM_STATUSLINE_LAUNCHER_FILE || path.join(os.homedir(), '.claude', 'glm-statusline-launcher.js');
// 状态栏用户配置文件（display）
const CONFIG_FILE =
  process.env.GLM_STATUSLINE_CONFIG_FILE || path.join(os.homedir(), '.claude', 'glm-statusline-config.json');
// "由本插件管理"的识别标记：statusLine.command 含本插件文件名即视为已接管
const MANAGED_MARKER = 'glm-statusline.js';
// 启动器文件名标记（同上，识别启动器式配置）
const LAUNCHER_MARKER = 'glm-statusline-launcher.js';
// 本地 marketplace 名（对应 .claude-plugin/marketplace.json）
const MARKETPLACE_NAME = 'bingqiangzhou-tools';
// 插件名
const PLUGIN_NAME = 'glm-statusline';
// 插件版本缓存根目录（claude plugin update 后新版本装在这里，启动器会扫描它找最新版）
const PLUGIN_CACHE_ROOT =
  process.env.GLM_STATUSLINE_PLUGIN_CACHE_ROOT ||
  path.join(os.homedir(), '.claude', 'plugins', 'cache', MARKETPLACE_NAME, PLUGIN_NAME);

// POSIX 单引号转义：把值安全包进单引号（内部单引号转成 '"'"' 形式）
function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

// 构造 statusLine.command 字符串："node" "启动器路径"（各自安全转义）
function statusLineCommand() {
  return `${shellQuote(process.execPath)} ${shellQuote(STABLE_LAUNCHER_FILE)}`;
}

// 读 Claude settings JSON（文件不存在返回空对象；解析失败抛错 —— 安装场景要让用户看到问题）
function readSettings() {
  // 文件不存在 → 空对象（视为首次安装）
  if (!fs.existsSync(SETTINGS_FILE)) return {};
  // 保护块
  try {
    // 读文件并去空白
    const raw = fs.readFileSync(SETTINGS_FILE, 'utf8').trim();
    // 空文件 → 空对象；否则解析
    return raw ? JSON.parse(raw) : {};
  // catch：解析失败
  } catch (err) {
    // 抛出带文件路径的错误（不能静默吞掉用户的 settings 问题）
    throw new Error(`Cannot parse ${SETTINGS_FILE}: ${err.message}`);
  }
}

// 写 Claude settings（2 空格缩进 + 末尾换行，与 Claude Code 手写格式一致）
function writeSettings(settings) {
  // 确保 ~/.claude 目录存在
  fs.mkdirSync(path.dirname(SETTINGS_FILE), { recursive: true });
  // 写入
  fs.writeFileSync(SETTINGS_FILE, `${JSON.stringify(settings, null, 2)}\n`);
}

// 读状态栏配置 JSON（不存在/空文件 → 空对象；解析失败抛错）
function readJsonFile(filePath) {
  // 保护块
  try {
    // 路径为空或文件不存在 → 空对象
    if (!filePath || !fs.existsSync(filePath)) return {};
    // 读文件并去空白
    const raw = fs.readFileSync(filePath, 'utf8').trim();
    // 空文件 → 空对象；否则解析
    return raw ? JSON.parse(raw) : {};
  // catch：解析失败
  } catch (err) {
    // 抛出带路径的错误
    throw new Error(`Cannot parse ${filePath}: ${err.message}`);
  }
}

// 写状态栏配置文件（同样 2 空格缩进 + 末尾换行）
function writeConfig(config) {
  // 确保目录存在
  fs.mkdirSync(path.dirname(CONFIG_FILE), { recursive: true });
  // 写入
  fs.writeFileSync(CONFIG_FILE, `${JSON.stringify(config, null, 2)}\n`);
}

// 从既有配置构造交互式配置的初始状态（老用户的勾选延续下来）
function baseConfigFromFile() {
  // 读既有配置
  const previous = readJsonFile(CONFIG_FILE);
  // 清洗 display 列表
  const display = normalizeDisplayList(previous.display);
  // 返回初始配置
  return {
    // 显示字段：有配置用配置的；未配置 → 默认勾选全部字段
    //（布局已统一为分组多行 + 自动合并，配置文件里残留的 layout 键被忽略）
    display: display.length ? display : [...FIELD_ORDER],
  };
}

// 备份 settings（改动前先备份，出问题可手工恢复）
function backupSettings() {
  // 文件不存在就不用备份
  if (!fs.existsSync(SETTINGS_FILE)) return '';
  // 时间戳（ISO 格式，冒号/点替换成 - 以便进文件名）
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  // 备份路径：settings.json.glm-statusline-plugin.bak.<时间戳>
  const backupPath = `${SETTINGS_FILE}.glm-statusline-plugin.bak.${stamp}`;
  // 复制完成备份
  fs.copyFileSync(SETTINGS_FILE, backupPath);
  // 返回备份路径（没备份返回空串）
  return backupPath;
}

// 写稳定启动器 —— statusLine.command 永远指向这个文件，插件升级换缓存路径也不影响命令（稳定启动器模式，见 CLAUDE.md）
function writeStableLauncher() {
  // 启动器脚本内容（多行模板串，内部不能插注释）：启动时扫描插件缓存目录选最高 semver 版本执行，找不到就回退源码树入口
  const script = `#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const CACHE_ROOT = ${JSON.stringify(PLUGIN_CACHE_ROOT)};
const FALLBACK = ${JSON.stringify(LAUNCHER)};

function versionParts(version) {
  return String(version).split('.').map((part) => Number(part) || 0);
}

function compareVersions(a, b) {
  const aa = versionParts(a);
  const bb = versionParts(b);
  for (let i = 0; i < Math.max(aa.length, bb.length); i += 1) {
    const diff = (aa[i] || 0) - (bb[i] || 0);
    if (diff) return diff;
  }
  return String(a).localeCompare(String(b));
}

function findLatestLauncher() {
  try {
    if (!fs.existsSync(CACHE_ROOT)) return '';
    return fs
      .readdirSync(CACHE_ROOT, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => ({
        version: entry.name,
        launcher: path.join(CACHE_ROOT, entry.name, 'bin', 'glm-statusline.js'),
      }))
      .filter((entry) => fs.existsSync(entry.launcher))
      .sort((a, b) => compareVersions(b.version, a.version))[0]?.launcher || '';
  } catch (_) {
    return '';
  }
}

const target = findLatestLauncher() || FALLBACK;
const result = spawnSync(process.execPath, [target], {
  stdio: 'inherit',
  env: process.env,
});

if (result.error) {
  console.error(result.error.message || String(result.error));
  process.exit(1);
}
process.exit(result.status === null ? 1 : result.status);
`;

  // 确保启动器目录存在
  fs.mkdirSync(path.dirname(STABLE_LAUNCHER_FILE), { recursive: true });
  // 写入启动器（mode 0o755：可执行权限）
  fs.writeFileSync(STABLE_LAUNCHER_FILE, script, { mode: 0o755 });
}

// 渲染预览：用一份固定的模拟会话 JSON 调用真实状态栏脚本
function renderPreview() {
  // 同步子进程执行 bin/glm-statusline.js --preview
  const result = spawnSync(process.execPath, [LAUNCHER, '--preview'], {
    // 在插件根目录运行
    cwd: PLUGIN_ROOT,
    // stdin 喂入模拟会话上下文
    input: JSON.stringify({
      // 模型名（会走 Opus/Sonnet → GLM 映射）
      model: { display_name: 'Sonnet' },
      // 努力档位
      effort: { level: 'high' },
      // 上下文窗口（0% + 20 万窗口）
      context_window: { used_percentage: 0, context_window_size: 200000 },
      // transcript 留空（会话 token 显示 0）
      transcript_path: '',
    }),
    // 让预览读到刚保存的配置文件
    env: { ...process.env, GLM_STATUSLINE_CONFIG_FILE: CONFIG_FILE },
    // 以 UTF-8 解码子进程输出
    encoding: 'utf8',
  });
  // 启动失败 → 提示不可用
  if (result.error) return `Preview unavailable: ${result.error.message}`;
  // 非零退出且有 stderr → 同样提示不可用
  if (result.status !== 0 && result.stderr) return `Preview unavailable: ${result.stderr.trim()}`;
  // 正常返回预览文本
  return result.stdout.trim();
}

// 打印交互式配置界面（勾选清单 + 预览）
function printInteractiveState(config) {
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

// 保存交互式配置并回显预览
function saveInteractiveConfig(config) {
  // 写配置文件
  writeConfig(config);
  // 告知保存位置
  console.log(`GLM StatusLine config written to ${CONFIG_FILE}`);
  // 打印新配置的预览
  console.log(renderPreview());
}

// 打印安装后的下一步提示
function printInstallNextSteps() {
  // 空行分隔
  console.log('');
  // 提示运行 configure 选择字段
  console.log('Next step: run /glm-statusline:configure to choose which fields are shown.');
  // 说明每次选择即时保存并刷新预览
  console.log('Each selection saves immediately and prints a fresh preview.');
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

// 交互式配置主循环
async function interactiveConfigure() {
  // 初始配置 = 既有配置归一化
  let config = baseConfigFromFile();
  // 先落盘一次（保证配置文件存在）
  writeConfig(config);
  // 打印界面
  printInteractiveState(config);

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
    printInteractiveState(config);
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
async function configure(args = []) {
  // 带参数
  if (args.length) {
    // 报错引导用交互模式
    throw new Error('Use the interactive selector: glm-statusline-install.js configure');
  }
  // 进入交互配置
  await interactiveConfigure();
}

// install 子命令：写启动器 + 改 settings
async function install(args = []) {
  // 入口脚本不存在（源码树不完整）
  if (!fs.existsSync(LAUNCHER)) {
    // 报错
    throw new Error(`Status line launcher not found: ${LAUNCHER}`);
  }
  // install 不接受 display 参数（选字段是 configure 的事）
  if (args.length) {
    // 报错引导
    throw new Error('Install does not take display arguments. Run /glm-statusline:configure after install.');
  }
  // 写稳定启动器
  writeStableLauncher();

  // 读当前 settings
  const settings = readSettings();
  // 既有的 statusLine 配置
  const previous = settings.statusLine;
  // 判断是否已由本插件接管（command 含插件标记或启动器标记）
  const alreadyInstalled =
    previous &&
    previous.type === 'command' &&
    typeof previous.command === 'string' &&
    (previous.command.includes(MANAGED_MARKER) || previous.command.includes(LAUNCHER_MARKER));

  // 已被接管不再重复备份；首次接管才备份（保护用户手写的其他配置）
  const backupPath = alreadyInstalled ? '' : backupSettings();
  // 写入新的 statusLine 配置
  settings.statusLine = {
    // 命令型状态栏
    type: 'command',
    // 命令 = node + 稳定启动器路径
    command: statusLineCommand(),
    // 刷新间隔 5 秒
    refreshInterval: 5,
    // 无内边距
    padding: 0,
  };
  // 写回 settings
  writeSettings(settings);

  // 告知启用成功
  console.log(`GLM StatusLine enabled in ${SETTINGS_FILE}`);
  // 有备份则提示备份位置
  if (backupPath) console.log(`Backup written to ${backupPath}`);
  // 展示写入的命令
  console.log(`Command: ${settings.statusLine.command}`);
  // 展示启动器路径
  console.log(`Launcher: ${STABLE_LAUNCHER_FILE}`);
  // 展示预览
  console.log(renderPreview());
  // 打印下一步提示
  printInstallNextSteps();
}

// uninstall 子命令：还原 settings + 清理启动器
function uninstall(force = false) {
  // 读当前 settings
  const settings = readSettings();
  // 当前 statusLine 配置
  const current = settings.statusLine;
  // 判断是否本插件管理（同 install 的判定逻辑）
  const isManaged =
    current &&
    current.type === 'command' &&
    typeof current.command === 'string' &&
    (current.command.includes(MANAGED_MARKER) || current.command.includes(LAUNCHER_MARKER));

  // 不是本插件管理且未加 --force → 拒绝动用户的配置
  if (!isManaged && !force) {
    // 提示未做任何更改
    console.log('GLM StatusLine is not the active statusLine. Nothing changed.');
    // 返回
    return;
  }

  // 先备份（卸载也要能恢复）
  const backupPath = backupSettings();
  // 移除 statusLine 配置项
  delete settings.statusLine;
  // 写回 settings
  writeSettings(settings);
  // 尝试删除稳定启动器
  try {
    // 删除文件
    fs.unlinkSync(STABLE_LAUNCHER_FILE);
  // catch：删除失败
  } catch (_) {
    // （启动器不存在则忽略 —— 英文原注释）
    // Ignore missing launcher.
  }
  // 告知已禁用
  console.log(`GLM StatusLine disabled in ${SETTINGS_FILE}`);
  // 有备份则提示备份位置
  if (backupPath) console.log(`Backup written to ${backupPath}`);
}

// 打印用法说明
function printUsage() {
  // （多行模板串：子命令与环境变量清单，内部不插注释）
  console.log(`Usage:
  glm-statusline-install.js install
  glm-statusline-install.js configure
  glm-statusline-install.js uninstall [--force]
  glm-statusline-install.js print-command

Environment:
  GLM_STATUSLINE_SETTINGS_FILE  Override the settings file for tests or project-local installs.
  GLM_STATUSLINE_LAUNCHER_FILE  Override the stable launcher file for tests.
  GLM_STATUSLINE_CONFIG_FILE    Override the display config file.
`);
}

// 命令分发主入口
async function main() {
  // 第一个参数是子命令（默认 install），其余是参数
  const [command = 'install', ...args] = process.argv.slice(2);
  // install / enable 别名
  if (command === 'install' || command === 'enable') {
    // 执行安装
    await install(args);
    // 结束
    return;
  }
  // configure / config 别名
  if (command === 'configure' || command === 'config') {
    // 执行交互配置
    await configure(args);
    // 结束
    return;
  }
  // uninstall / disable / remove 别名
  if (command === 'uninstall' || command === 'disable' || command === 'remove') {
    // 执行卸载（--force 透传）
    uninstall(args.includes('--force'));
    // 结束
    return;
  }
  // print-command：只打印 statusLine.command 内容
  if (command === 'print-command') {
    // 输出命令
    console.log(statusLineCommand());
    // 结束
    return;
  }
  // 帮助
  if (command === '--help' || command === '-h' || command === 'help') {
    // 打印用法
    printUsage();
    // 结束
    return;
  }
  // 未知命令
  throw new Error(`Unknown command: ${command}`);
}

// 顶层保护：错误信息打到 stderr、退出码置 1（不抛未捕获异常）
try {
  // async main 的 rejection 兜底
  main().catch((err) => {
    // 打印错误信息
    console.error(err.message || String(err));
    // 退出码 1
    process.exitCode = 1;
  });
// 同步异常兜底
} catch (err) {
  // 打印错误信息
  console.error(err.message || String(err));
  // 退出码 1
  process.exitCode = 1;
}
