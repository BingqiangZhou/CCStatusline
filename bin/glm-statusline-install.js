#!/usr/bin/env node
// 严格模式：强制变量声明、静默错误显式抛错
'use strict';

// 文件系统：读写 settings / 启动器文件
const fs = require('fs');
// 系统信息：定位主目录
const os = require('os');
// 路径处理
const path = require('path');
// 子进程：同步调用状态栏脚本做预览、让启动器转发执行
const { spawnSync } = require('child_process');
// 文件读写共享库（与核心共用）：settings 读写用
const {
  // 通用 JSON 读取（安装器契约：缺失/空 → {}，坏文件抛错）
  readJsonFile,
  // 通用 JSON 写入（2 空格缩进 + 末尾换行；出错冒泡）
  writeJsonFile,
  // 遗留配置文件路径解析（env 覆盖 → 默认 + ~ 展开；uninstall 清理用）
  configFilePath,
} = require('../lib/file-io');

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
// 安装器的 JSON 读取契约：文件缺失/为空 → 空对象，解析失败 → 抛错（与核心的静默兜底刻意相反：
// 安装场景要让用户看到坏文件，状态栏则绝不能崩 —— 见 lib/file-io.js readJsonFile 注释）
const STRICT_JSON_READ = { fallback: {}, throwOnParse: true };
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

// 解析写入命令的 node 路径：优先取 PATH 中指向同一二进制的稳定入口（如 Homebrew 的
// /opt/homebrew/bin/node），而不是版本化的 process.execPath —— macOS 下后者常解析成
// Cellar/node/<version>/bin/node，brew upgrade 删掉旧版本目录后该路径即失效，
// statusLine 会静默消失。找不到稳定入口时回退 process.execPath（保持原行为）。
function stableNodePath() {
  try {
    // 真实二进制位置（所有候选与之比对）
    const realExec = fs.realpathSync(process.execPath);
    // 在 PATH 各目录中查找同名可执行（basename 自动适配 Windows 的 node.exe）
    const base = path.basename(process.execPath);
    const dirs = String(process.env.PATH || '').split(path.delimiter).filter(Boolean);
    // 第一个命中候选（可能就是 execPath 所在目录，稳定性不增不减）
    let firstMatch = '';
    for (const dir of dirs) {
      const candidate = path.join(dir, base);
      try {
        // 存在、是文件、且解析到同一二进制 → 命中
        if (fs.statSync(candidate).isFile() && fs.realpathSync(candidate) === realExec) {
          // 与 execPath 不同的路径更稳定（避开 PATH 里也列了版本化目录的情况），直接采用
          if (candidate !== process.execPath) return candidate;
          if (!firstMatch) firstMatch = candidate;
        }
      } catch (_) {
        // 候选不存在/不可读 → 继续下一个目录
      }
    }
    // 没有更稳的候选：有自命中用自命中，否则原样回退
    return firstMatch || process.execPath;
  } catch (_) {
    // realpath 异常等场景 → 原样回退，绝不因路径解析失败阻断安装
    return process.execPath;
  }
}

// 构造 statusLine.command 字符串："node" "启动器路径"（各自安全转义）
function statusLineCommand() {
  return `${shellQuote(stableNodePath())} ${shellQuote(STABLE_LAUNCHER_FILE)}`;
}

// 读 Claude settings JSON（文件不存在/为空返回空对象；解析失败抛错 —— 安装场景要让用户看到问题）
function readSettings() {
  // 委托共享读取原语（STRICT_JSON_READ 即上述安装器契约）
  return readJsonFile(SETTINGS_FILE, STRICT_JSON_READ);
}

// 写 Claude settings（2 空格缩进 + 末尾换行，与 Claude Code 手写格式一致）
function writeSettings(settings) {
  // 委托共享写入原语（newline：末尾换行；非原子 + 出错冒泡 —— 与原实现一致）
  writeJsonFile(SETTINGS_FILE, settings, { newline: true });
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
    // 子进程继承当前 env（状态栏不读配置文件，无需额外注入）
    env: process.env,
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

// 打印安装后的下一步提示
function printInstallNextSteps() {
  // 空行分隔
  console.log('');
  // 说明字段固定全显，没有可配置项
  console.log('The status line always shows all fields; there is nothing to configure.');
  // 说明刷新时机
  console.log('It refreshes automatically as you use Claude Code.');
}

// install 子命令：写启动器 + 改 settings
async function install(args = []) {
  // 入口脚本不存在（源码树不完整）
  if (!fs.existsSync(LAUNCHER)) {
    // 报错
    throw new Error(`Status line launcher not found: ${LAUNCHER}`);
  }
  // install 不接受任何参数
  if (args.length) {
    // 报错
    throw new Error('Install does not take arguments.');
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
    // 空闲保底刷新 30 秒：活跃时 CC 事件驱动刷新（300ms 防抖）与此值无关；
    // 空闲时远端字段最快 60s（API 缓存 TTL）才有一档新值，30s 轮询已足够，
    // 相比 5s 把空闲渲染量降约 83%（每小时 720 → 120 次）
    refreshInterval: 30,
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
    // 启动器不存在则忽略
  }
  // 清理遗留的 display 配置文件（状态栏已不再读取它；只有过去的 configure 会写过）。
  // 尽力而为：不存在/不可删都静默忽略（此后正常情况就是不存在）。
  try {
    fs.unlinkSync(configFilePath(process.env));
  } catch (_) {
    // 遗留配置文件不存在/不可删则忽略
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
  glm-statusline-install.js uninstall [--force]
  glm-statusline-install.js print-command

Environment:
  GLM_STATUSLINE_SETTINGS_FILE  Override the settings file for tests or project-local installs.
  GLM_STATUSLINE_LAUNCHER_FILE  Override the stable launcher file for tests.
  GLM_STATUSLINE_CONFIG_FILE    Override the legacy config file (cleaned up by uninstall).
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
