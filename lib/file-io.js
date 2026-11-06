// 严格模式：强制变量声明、把静默错误转为显式抛错，文件顶层统一开启
'use strict';

// 文件系统：所有读写原语
const fs = require('fs');
// 系统信息：定位主目录
const os = require('os');
// 路径处理
const path = require('path');

// 用户主目录：所有默认路径的根
const HOME = os.homedir();
// 遗留配置文件路径（字段选择功能移除后状态栏不再读取它；仅 uninstall 清理时使用）
const DEFAULT_CONFIG_FILE = path.join(HOME, '.claude', 'glm-statusline-config.json');

// 调试日志：仅当 GLM_STATUSLINE_DEBUG=1 时输出（走 stderr，绝不污染 stdout —— 那是状态栏本体）
//（调用时读 env，保持与原先核心内联版一致的时机；本模块及 status-cache/monitor-api/核心共用）
function debugLog(label, err) {
  // 未开调试开关：静默返回
  if (process.env.GLM_STATUSLINE_DEBUG !== '1') return;
  // 取错误信息（err.message 优先，其余 String 化兜底）
  const message = err && err.message ? err.message : String(err || 'unknown error');
  // 带统一前缀打到 stderr
  console.error(`[glm-statusline] ${label}: ${message}`);
}

// 把 "~/xxx" 展开成绝对路径；非法输入原样返回（不抛错）
function expandHome(input) {
  // 空值或非字符串：原样返回
  if (!input || typeof input !== 'string') return input;
  // 单独的 "~" 即主目录
  if (input === '~') return HOME;
  // "~/" 开头：替换成 HOME + 剩余部分
  if (input.startsWith('~/')) return path.join(HOME, input.slice(2));
  // 其余情况原样返回
  return input;
}

// 通用 JSON 读取：两种刻意不同的错误契约用选项表达（原先在核心与安装器各有一份同名拷贝）
// - 状态栏（glm-statusline.js）：fallback=null + throwOnParse=false —— 任何错误静默返回 null（状态栏绝不能崩）
// - 安装器（bin/glm-statusline-install.js）：fallback={} + throwOnParse=true —— 坏文件要抛
//   `Cannot parse <path>` 让用户看到（安装场景不能静默吞掉用户的 settings/config 问题）
function readJsonFile(filePath, options = {}) {
  // 选项解构（fallback：兜底值；throwOnParse：解析失败是否抛错；onError：错误回调如 debugLog）
  const { fallback = null, throwOnParse = false, onError = null } = options;
  // 保护块
  try {
    // 路径为空或文件不存在 → 兜底值（不触发 onError，与两边原实现一致）
    if (!filePath || !fs.existsSync(filePath)) return fallback;
    // 读文件并去空白；空文件 → 兜底值（安装器的空文件契约）
    const raw = fs.readFileSync(filePath, 'utf8').trim();
    // 非空才解析
    return raw ? JSON.parse(raw) : fallback;
  // catch：读取/解析失败
  } catch (err) {
    // 错误回调（如核心的 debugLog，仅 GLM_STATUSLINE_DEBUG=1 时可见）
    if (onError) onError(err);
    // 安装器契约：抛带路径的错误（信息格式与原实现逐字一致）
    if (throwOnParse) throw new Error(`Cannot parse ${filePath}: ${err.message}`);
    // 状态栏契约：静默返回兜底值
    return fallback;
  }
}

// 通用 JSON 写入：2 空格缩进；原子写/末尾换行/吞错都用选项表达（原先 saveCache 与安装器的
// writeSettings/writeConfig 各写了一份 mkdir+writeFile）
function writeJsonFile(filePath, value, options = {}) {
  // 选项解构（atomic：临时文件+rename 原子写；newline：末尾换行；swallowErrors：吞写错误；onError：错误回调）
  const { atomic = false, newline = false, swallowErrors = false, onError = null } = options;
  // 保护块
  try {
    // 确保目录存在（首次运行时；在 try 内 —— 与原 saveCache 一致，目录建不了也走错误路径）
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    // 序列化：2 空格缩进；末尾换行仅安装器要（与 Claude Code 手写 settings 格式一致），缓存不要
    const text = `${JSON.stringify(value, null, 2)}${newline ? '\n' : ''}`;
    // 原子写分支（saveCache 专用，见下方注释）
    if (atomic) {
      // 原子写（临时文件 + rename）：多个 Claude Code 项目共享同一个缓存文件，且每次状态栏渲染都会
      // 重写它。直接 writeFileSync 原地写会与并发写入者交错、留下半个文件；随后 loadCache 的
      // JSON.parse 失败、所有条目清零 —— 包括每会话的速度基线（见 resolveSpeed），而速度的空闲分支
      // 故意不重写缓存，基线一丢 Speed 就一直卡在 '--'。rename 在 POSIX/darwin 上是原子的，读方因此
      // 总能看到完整文件。临时文件名带 PID：并发的多个写者互不覆盖对方的临时文件（关键不变量，防并发写坏缓存）
      const tmp = `${filePath}.tmp.${process.pid}`;
      // 先写完整内容到临时文件
      fs.writeFileSync(tmp, text);
      // 再原子改名到正式路径：POSIX 上 rename 原子，读者永远看到完整文件
      fs.renameSync(tmp, filePath);
    // 普通写分支（安装器的 settings/config：非原子、出错要冒泡）
    } else {
      // 直接写入
      fs.writeFileSync(filePath, text);
    }
  // catch：写失败（磁盘满/权限等）
  } catch (err) {
    // 错误回调（如核心的 debugLog）
    if (onError) onError(err);
    // swallowErrors：仅状态栏缓存用（写失败绝不影响输出）；默认抛出（安装器要让错误冒泡）
    if (!swallowErrors) throw err;
  }
}

// 读行时间戳：行自带时间优先，缺失兜底文件修改时间（供遍历器使用）
function lineTimestamp(obj, fallbackMs) {
  // 按优先级取原始值
  const raw = obj?.timestamp || obj?.created_at || obj?.createdAt || obj?.message?.timestamp;
  // 转毫秒时间戳
  const ms = raw ? new Date(raw).getTime() : NaN;
  // 有限就用，否则用兜底
  return Number.isFinite(ms) ? ms : fallbackMs;
}

// 遍历 transcript JSONL：统一"读文件 → 逐行解析 → 行时间戳 → message.id 去重"的公共骨架
//（原先 readJsonlTokenStats / readJsonlOutputStats 各维护一份逐字重复的脚手架）。
// visit(obj, ts, line) 对每个合法解析行调用 —— 含重复行（readJsonlOutputStats 要对每行刷新 lastLineMs）：
//   line.id        本行 message.id（无则 null）
//   line.duplicate 该 message.id 是否已被计数过（visit 自行决定是否跳过）
//   line.countOnce 登记本行 message.id —— 只在 visit 真正计入本行时调用（与原"add > 0 才登记"语义一致：
//                  一条 add=0 的行不占用去重名额，同消息后续行仍可计入）
// 文件不存在/读失败：静默返回（visit 一次都不调用，调用方累加器保持初始零值）。
function forEachTranscriptLine(filePath, visit) {
  // 保护块：文件级错误（不存在/不可读）整体吞掉
  try {
    // 路径为空或不存在 → 直接返回
    if (!filePath || !fs.existsSync(filePath)) return;
    // 文件状态（mtime 做时间兜底）
    const stat = fs.statSync(filePath);
    // 全文读入
    const content = fs.readFileSync(filePath, 'utf8');
    // message.id 去重集合（Claude Code 每个内容块写一行且都带完整 usage —— 不去重会放大约 N 倍）
    const counted = new Set();
    // 逐行处理
    for (const line of content.split('\n')) {
      // 空行跳过
      if (!line.trim()) continue;
      // 保护块：坏行只跳过不影响全局（visit 的累加逻辑也在保护块内 —— 与原实现一致）
      try {
        // 解析单行 JSON
        const obj = JSON.parse(line);
        // 行时间戳（无自带时间用文件 mtime）
        const ts = lineTimestamp(obj, stat.mtimeMs);
        // 消息 ID（空串等假值视为无 ID，与原实现的真值判断一致）
        const id = obj.message?.id || null;
        // 交给 visit 决定是否计入
        visit(obj, ts, {
          id,
          duplicate: Boolean(id) && counted.has(id),
          countOnce: () => {
            if (id) counted.add(id);
          },
        });
      // catch：跳过坏行
      } catch (_) {
        // 坏行直接忽略
      }
    }
  // catch：文件级错误
  } catch (_) {
    // 不可读的 transcript 文件整体忽略
  }
}

// 遗留配置文件路径：环境变量覆盖 → 默认路径，带 ~ 展开
//（状态栏已不再读取任何配置文件；此路径仅供安装器 uninstall 清理遗留文件，
//  环境变量名与默认路径在此唯一事实化，测试用它重定向清理目标）
function configFilePath(env = process.env) {
  return expandHome(env.GLM_STATUSLINE_CONFIG_FILE || DEFAULT_CONFIG_FILE);
}

// 导出本模块全部公共 API（消费者：glm-statusline.js 与 bin/glm-statusline-install.js）
module.exports = {
  // 调试日志（仅 GLM_STATUSLINE_DEBUG=1 时走 stderr）
  debugLog,
  // "~" 路径展开（核心还用它展开 transcript_path）
  expandHome,
  // 通用 JSON 读取（两种错误契约见函数注释）
  readJsonFile,
  // 通用 JSON 写入（原子写 / 末尾换行 / 吞错均为选项）
  writeJsonFile,
  // transcript JSONL 遍历器（内置 message.id 去重协议）
  forEachTranscriptLine,
  // 遗留配置文件路径解析（env 覆盖 → 默认 + ~ 展开；仅 uninstall 清理用）
  configFilePath,
};
