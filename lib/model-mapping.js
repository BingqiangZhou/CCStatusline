// 严格模式：强制变量声明、把静默错误转为显式抛错，文件顶层统一开启
'use strict';

// 模型名映射库：Claude 模型名（Opus/Sonnet/Haiku）→ GLM 模型名 + 推理努力档位读取。
// 全部纯函数（env 经参数传入，不读 process.env、不碰 fs）。

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

// 导出本模块全部公共 API（消费者：bin/glm-statusline.js）
module.exports = {
  // 提取 Claude 模型原始名
  getClaudeModelRaw,
  // 读取推理努力档位（high/medium/low）
  getEffortLevel,
  // Claude 模型名 → GLM 模型名映射
  mapClaudeModelToGlm,
  // 模型名美化（去前缀 + 大小写规范）
  beautifyModelName,
};
