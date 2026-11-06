#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const root = path.resolve(__dirname, '..');

function readJson(relativePath) {
  const fullPath = path.join(root, relativePath);
  assert.ok(fs.existsSync(fullPath), `${relativePath} should exist`);
  return JSON.parse(fs.readFileSync(fullPath, 'utf8'));
}

function assertFile(relativePath) {
  assert.ok(fs.existsSync(path.join(root, relativePath)), `${relativePath} should exist`);
}

// 同步跑子进程（cwd 固定仓库根；env 为 process.env + 各场景覆盖项）
function run(command, args, options = {}) {
  return spawnSync(command, args, {
    cwd: root,
    input: options.input,
    env: { ...process.env, ...(options.env || {}) },
    encoding: 'utf8',
  });
}

// 异步跑子进程（收集 stdout/stderr，退出时 resolve { status, stdout, stderr }）
function runAsync(command, args, options = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: root,
      env: { ...process.env, ...(options.env || {}) },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    // stdout 累积器
    let stdout = '';
    // stderr 累积器
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('close', (status) => resolve({ status, stdout, stderr }));
    if (options.input) child.stdin.end(options.input);
    else child.stdin.end();
  });
}

// 监听 127.0.0.1 随机端口，返回端口号
function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

// 不需要真实 GLM API 的状态栏运行共享 env（空 token/url → fetchQuota 立即走回退值）。
// 每次调用指向各自的缓存文件。
function baseEnv(cacheFile) {
  return {
    ANTHROPIC_AUTH_TOKEN: '',
    ANTHROPIC_BASE_URL: '',
    GLM_STATUSLINE_CACHE_FILE: cacheFile,
    GLM_STATUSLINE_CACHE_TTL_MS: '1',
    COLUMNS: '120',
  };
}

function close(server) {
  return new Promise((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
}

function verifyProjectMetadata() {
  // package.json 版本号必须是纯 semver
  const packageJson = readJson('package.json');
  assert.match(packageJson.version, /^\d+\.\d+\.\d+$/);
  const expectedVersion = packageJson.version;

  // 插件清单：名称 / 描述 / 版本与 package.json 一致
  const plugin = readJson('.claude-plugin/plugin.json');
  assert.strictEqual(plugin.name, 'glm-statusline');
  assert.match(plugin.description, /GLM/i);
  assert.strictEqual(plugin.version, expectedVersion);

  // marketplace 清单：名称 / source / 双处版本与 package.json 一致
  const marketplace = readJson('.claude-plugin/marketplace.json');
  assert.strictEqual(marketplace.name, 'bingqiangzhou-tools');
  assert.ok(marketplace.plugins.some((entry) => entry.name === 'glm-statusline' && entry.source === './'));
  assert.strictEqual(marketplace.version, expectedVersion);
  assert.ok(marketplace.plugins.some((entry) => entry.name === 'glm-statusline' && entry.version === expectedVersion));

  // 校验器自身不许硬编码版本号（版本比较必须以 package.json 为基准）
  const verifySource = fs.readFileSync(__filename, 'utf8');
  assert.doesNotMatch(
    verifySource,
    /assert\.strictEqual\([^,\n]+\.version,\s*['"][0-9]+\.[0-9]+\.[0-9]+['"]\)/,
    'version checks should compare manifests to package.json instead of hardcoding a release number'
  );

  // README 与构建指南：不许出现机器特定的绝对路径；README 必须包含钉住的关键内容
  const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8');
  const buildGuide = fs.readFileSync(path.join(root, 'docs/claude-code-plugin-build-guide.md'), 'utf8');
  assert.doesNotMatch(
    `${readme}\n${buildGuide}`,
    /\/Users\/[^`\s]+\/CCStatusline/,
    'learner-facing docs should not contain a machine-specific absolute path'
  );
  assert.match(readme, /pwd/, 'README should tell learners how to get their local marketplace path');
  assert.match(readme, /资料可靠性说明/, 'README should separate documented facts from API compatibility assumptions');
  assert.match(readme, /兼容式解析/, 'README should describe the GLM monitor API parser as compatibility parsing');
  assert.match(readme, /test\/fixtures/, 'README file tree should include API fixtures for learners');
  assert.match(readme, /lib\//, 'README file tree should include shared library modules');

  // 钉住全部必要文件的存在（防搬移笔误）
  assertFile('bin/glm-statusline.js');
  assertFile('bin/glm-statusline-install.js');
  // lib/ 随插件包分发（marketplace source: "./"），钉住全部模块文件防搬移笔误
  assertFile('lib/display-fields.js');
  assertFile('lib/file-io.js');
  assertFile('lib/model-mapping.js');
  assertFile('lib/monitor-api.js');
  assertFile('lib/quota-parsing.js');
  assertFile('lib/session-metrics.js');
  assertFile('lib/status-cache.js');
  assertFile('lib/statusline-format.js');
  assertFile('lib/transcript-stats.js');
  assertFile('test/test.js');
  assertFile('skills/install/SKILL.md');
  assertFile('skills/plan-details/SKILL.md');
  assertFile('skills/uninstall/SKILL.md');
  assertFile('docs/claude-code-plugin-build-guide.md');
  assertFile('docs/claude-code-skills-and-extensions-guide.md');
  assertFile('test/fixtures/quota-limit.json');
  assertFile('test/fixtures/model-usage-day.json');
  assertFile('test/fixtures/model-usage-month.json');

  // 安装 skill 文案不许出现已移除的参数式配置提示
  const installSkill = fs.readFileSync(path.join(root, 'skills/install/SKILL.md'), 'utf8');
  assert.doesNotMatch(installSkill, /--show|--layout|--bar-width|argument-hint/);

  // 行合并已移除：布局模块的注释不许再描述它（含英文措辞）
  const displayFieldsSource = fs.readFileSync(path.join(root, 'lib/display-fields.js'), 'utf8');
  assert.doesNotMatch(displayFieldsSource, /auto-merge|mergeRows|segmentsWidth/);
  // mergeRows/segmentsWidth 当年实现于 statusline-format.js —— 同一正则也盯住真正实现过的文件
  const statuslineFormatSource = fs.readFileSync(path.join(root, 'lib/statusline-format.js'), 'utf8');
  assert.doesNotMatch(statuslineFormatSource, /auto-merge|mergeRows|segmentsWidth/);

  // skills 指南必须保留的小节标题
  const skillsGuide = fs.readFileSync(
    path.join(root, 'docs/claude-code-skills-and-extensions-guide.md'),
    'utf8'
  );
  for (const heading of [
    '## 资料来源',
    '## Skill 的基本结构',
    '## SKILL.md 写法',
    '## Claude Code 还能扩展什么',
    '## 给本项目的后续扩展想法',
  ]) {
    assert.ok(skillsGuide.includes(heading), `skills guide should include ${heading}`);
  }
}

function verifyDefaultStatusLine(tempDir) {
  // 全部字段无条件渲染为固定分组行；不读任何配置文件。
  const status = run(process.execPath, ['bin/glm-statusline.js'], {
    input: JSON.stringify({
      model: { display_name: 'Sonnet' },
      context_window: { used_percentage: 12, context_window_size: 200000 },
      transcript_path: path.join(os.tmpdir(), 'missing-glm-statusline-transcript.jsonl'),
    }),
    env: {
      ANTHROPIC_AUTH_TOKEN: '',
      ANTHROPIC_BASE_URL: '',
      ANTHROPIC_DEFAULT_SONNET_MODEL: 'glm-test',
      GLM_STATUSLINE_PLAN: '',
      GLM_STATUSLINE_CACHE_TTL_MS: '1',
      COLUMNS: '120',
      CLAUDE_CODE_EFFORT_LEVEL: '',
    },
  });
  assert.strictEqual(status.status, 0, status.stderr);
  assert.match(status.stdout, /5H/);
  assert.match(status.stdout, /MCP/);
  assert.match(status.stdout, /Session 0/);
  assert.match(status.stdout, /Day 0/);
  assert.match(status.stdout, /30D 0/);
  assert.doesNotMatch(status.stdout, /Sess:/);
  assert.doesNotMatch(status.stdout, /Day:/);
  // 全部字段按固定分组行渲染、任何宽度下都不合并：恒为 3 个类别行
  //（model/effort/plan 用 env 覆盖钉死，保证确定性）
  const defaultLines = status.stdout.trim().split('\n');
  assert.strictEqual(defaultLines.length, 3, status.stdout);
  assert.match(defaultLines[0], /^Model GLM-test │ Effort -- │ Speed -- t\/s · Avg -- t\/s$/);
  assert.match(defaultLines[1], /^Context .+ 12% │ Session 0 │ Day 0 │ 30D 0$/);
  // 精确进度条钉住文档化的 ?? 0 不变量：5h/mcp 读数缺失必须渲染成空条 + 0%，绝不显示 --%
  assert.match(defaultLines[2], /^GLM │ 5H ░░░░░░░░ 0% @--:-- │ MCP ░░░░░░░░ 0% @--$/);

  // 遗留的 display 配置文件必须被完全忽略：所有字段照常渲染。
  const legacyConfigFile = path.join(tempDir, 'legacy-display-config.json');
  fs.writeFileSync(legacyConfigFile, JSON.stringify({ display: ['plan'] }, null, 2));
  const legacyStatus = run(process.execPath, ['bin/glm-statusline.js'], {
    input: JSON.stringify({
      model: { display_name: 'Sonnet' },
      context_window: { used_percentage: 12, context_window_size: 200000 },
      transcript_path: path.join(os.tmpdir(), 'missing-glm-statusline-transcript.jsonl'),
    }),
    env: {
      ANTHROPIC_AUTH_TOKEN: '',
      ANTHROPIC_BASE_URL: '',
      ANTHROPIC_DEFAULT_SONNET_MODEL: 'glm-test',
      GLM_STATUSLINE_PLAN: '',
      GLM_STATUSLINE_CONFIG_FILE: legacyConfigFile,
      GLM_STATUSLINE_CACHE_TTL_MS: '1',
      COLUMNS: '120',
      CLAUDE_CODE_EFFORT_LEVEL: '',
    },
  });
  assert.strictEqual(legacyStatus.status, 0, legacyStatus.stderr);
  const legacyLines = legacyStatus.stdout.trim().split('\n');
  assert.strictEqual(legacyLines.length, 3, legacyStatus.stdout);
  assert.match(legacyLines[0], /^Model GLM-test │ Effort -- │ Speed -- t\/s · Avg -- t\/s$/);
  assert.match(legacyLines[1], /^Context .+ 12% │ Session 0 │ Day 0 │ 30D 0$/);
  assert.match(legacyLines[2], /^GLM │ 5H ░░░░░░░░ 0% @--:-- │ MCP ░░░░░░░░ 0% @--$/);
}

// 写一份单行 transcript fixture（总 token 2000：1200 输入 + 300 输出 + 50 缓存写 + 450 缓存读）
function writeTranscriptFixture(transcriptFile) {
  fs.writeFileSync(
    transcriptFile,
    `${JSON.stringify({
      timestamp: new Date().toISOString(),
      message: {
        usage: {
          input_tokens: 1200,
          output_tokens: 300,
          cache_creation_input_tokens: 50,
          cache_read_input_tokens: 450,
        },
      },
    })}\n`
  );
}

// 本地 fixture API 服务器：按端点返回样例响应（quota / day / month），并记录全部请求 URL
function createFixtureApiServer(requests) {
  const quotaFixture = readJson('test/fixtures/quota-limit.json');
  const dayUsageFixture = readJson('test/fixtures/model-usage-day.json');
  const monthUsageFixture = readJson('test/fixtures/model-usage-month.json');

  return http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    requests.push(url);
    res.setHeader('Content-Type', 'application/json');

    // 配额端点
    if (url.pathname === '/api/monitor/usage/quota/limit') {
      res.end(JSON.stringify(quotaFixture));
      return;
    }

    // 用量端点：按 startTime 是否为当天 0 点区分 day / month 两个 fixture
    if (url.pathname === '/api/monitor/usage/model-usage') {
      const startTime = url.searchParams.get('startTime') || '';
      res.end(JSON.stringify(/\d{4}-\d{2}-\d{2} 00:00:00/.test(startTime) ? dayUsageFixture : monthUsageFixture));
      return;
    }

    res.statusCode = 404;
    res.end(JSON.stringify({ error: 'not found' }));
  });
}

async function verifyApiBackedStatusLine({ cacheFile, tempDir, transcriptFile }) {
  const requests = [];
  const server = createFixtureApiServer(requests);
  const port = await listen(server);
  try {
    // 带 fixture API 的首帧渲染
    const apiUsage = await runAsync(process.execPath, ['bin/glm-statusline.js'], {
      input: JSON.stringify({
        model: { display_name: 'Sonnet' },
        context_window: { used_percentage: 1, context_window_size: 200000 },
        transcript_path: transcriptFile,
      }),
      env: {
        ANTHROPIC_AUTH_TOKEN: 'test-token',
        ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}/api/anthropic`,
        ANTHROPIC_DEFAULT_SONNET_MODEL: 'glm-test',
        GLM_STATUSLINE_CACHE_FILE: cacheFile,
        GLM_STATUSLINE_CACHE_TTL_MS: '60000',
        COLUMNS: '100',
        CLAUDE_CODE_EFFORT_LEVEL: '',
      },
    });
    assert.strictEqual(apiUsage.status, 0, apiUsage.stderr);
    // 全部字段、固定分组行（无论宽度都不合并）。模型名用 env 覆盖钉死；套餐名来自 fixture API。
    const apiLines = apiUsage.stdout.trim().split('\n');
    assert.strictEqual(apiLines.length, 3, apiUsage.stdout);
    assert.match(apiLines[0], /^Model GLM-test │ Effort -- │ Speed -- t\/s · Avg -- t\/s$/);
    assert.match(apiLines[1], /^Context .+ 1% │ Session 2K │ Day 3K │ 30D 5\.98B$/);
    assert.match(apiLines[2], /^GLM Test │ 5H .+ 10% @18:30 │ MCP .+ 20% @06-14$/);
    assert.doesNotMatch(apiUsage.stdout, /Sess:/);
    assert.doesNotMatch(apiUsage.stdout, /30D:/);

    // --plan-details 详情视图
    const details = await runAsync(process.execPath, ['bin/glm-statusline.js', '--plan-details'], {
      env: {
        ANTHROPIC_AUTH_TOKEN: 'test-token',
        ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}/api/anthropic`,
        GLM_STATUSLINE_CACHE_FILE: cacheFile,
        GLM_STATUSLINE_CACHE_TTL_MS: '60000',
      },
    });
    assert.strictEqual(details.status, 0, details.stderr);
    assert.match(details.stdout, /GLM Coding Plan/);
    assert.match(details.stdout, /Plan: GLM Test/);
    assert.match(details.stdout, /5H: 10% · 2K \/ 20K · resets 18:30/);
    assert.match(details.stdout, /MCP: 20% · 3 \/ 30 · resets 2026-06-14 18:26/);
    assert.match(details.stdout, /Weekly: 30% · 300K \/ 1M · resets 2026-06-08 09:00/);
    assert.match(details.stdout, /Day: 3K tokens/);
    assert.match(details.stdout, /30D: 5\.98B tokens/);
    assert.match(details.stdout, /API: 127\.0\.0\.1:\d+ · key configured/);
    assert.doesNotMatch(details.stdout, /Model:/);
    assert.doesNotMatch(details.stdout, /Context:/);
    assert.doesNotMatch(details.stdout, /Session tokens:/);
    // model-usage 恰好请求 2 次（day + month；plan-details 与 preview 走 60s 缓存不再请求）
    assert.strictEqual(requests.filter((url) => url.pathname === '/api/monitor/usage/model-usage').length, 2);
    // 请求参数必须是 "yyyy-MM-dd HH:mm:ss" 格式
    for (const url of requests.filter((item) => item.pathname === '/api/monitor/usage/model-usage')) {
      assert.match(url.searchParams.get('startTime') || '', /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
      assert.match(url.searchParams.get('endTime') || '', /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    }
    // 缓存键按端点（base URL）区分；按会话的条目（speed:/context:）设计上按 session_id 存，不在此检查
    const testCache = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
    const endpointKeys = Object.keys(testCache).filter((key) => key.startsWith('quota:') || key.startsWith('model:'));
    assert.ok(endpointKeys.length >= 3, Object.keys(testCache).join(', '));
    assert.ok(endpointKeys.every((key) => key.includes(`http://127.0.0.1:${port}`)));

    // --preview：同样的固定三行渲染加上 "Preview:" 前缀（共 4 行）
    const preview = await runAsync(process.execPath, ['bin/glm-statusline.js', '--preview'], {
      input: JSON.stringify({
        model: { display_name: 'Sonnet' },
        context_window: { used_percentage: 1, context_window_size: 200000 },
        transcript_path: transcriptFile,
      }),
      env: {
        ANTHROPIC_AUTH_TOKEN: 'test-token',
        ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}/api/anthropic`,
        ANTHROPIC_DEFAULT_SONNET_MODEL: 'glm-test',
        GLM_STATUSLINE_CACHE_FILE: cacheFile,
        GLM_STATUSLINE_CACHE_TTL_MS: '60000',
        COLUMNS: '120',
        CLAUDE_CODE_EFFORT_LEVEL: '',
      },
    });
    assert.strictEqual(preview.status, 0, preview.stderr);
    const previewLines = preview.stdout.trim().split('\n');
    assert.strictEqual(previewLines.length, 4, preview.stdout);
    assert.strictEqual(previewLines[0], 'Preview:');
    assert.match(previewLines[1], /^Model GLM-test │ Effort -- │ Speed -- t\/s · Avg -- t\/s$/);
    assert.match(previewLines[2], /^Context .+ 1% │ Session 2K │ Day 3K │ 30D 5\.98B$/);
    assert.match(previewLines[3], /^GLM Test │ 5H .+ 10% @18:30 │ MCP .+ 20% @06-14$/);
  } finally {
    await close(server);
  }
}

// 全端点 500 的失败 API 服务器（调试日志场景用）
function createFailingApiServer() {
  return http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (url.pathname === '/api/monitor/usage/quota/limit') {
      res.statusCode = 500;
      res.end('quota exploded');
      return;
    }
    if (url.pathname === '/api/monitor/usage/model-usage') {
      res.statusCode = 500;
      res.end('usage exploded');
      return;
    }
    res.statusCode = 404;
    res.end('not found');
  });
}

async function verifyDebugLogging({ tempDir, transcriptFile }) {
  const debugServer = createFailingApiServer();
  const debugPort = await listen(debugServer);
  try {
    // GLM_STATUSLINE_DEBUG=1 时，API 失败必须向 stderr 输出错误来源；默认模式保持安静
    const debugStatus = await runAsync(process.execPath, ['bin/glm-statusline.js'], {
      input: JSON.stringify({
        model: { display_name: 'Sonnet' },
        context_window: { used_percentage: 1, context_window_size: 200000 },
        transcript_path: transcriptFile,
      }),
      env: {
        ANTHROPIC_AUTH_TOKEN: 'test-token',
        ANTHROPIC_BASE_URL: `http://127.0.0.1:${debugPort}/api/anthropic`,
        GLM_STATUSLINE_CACHE_FILE: path.join(tempDir, 'debug-cache.json'),
        GLM_STATUSLINE_CACHE_TTL_MS: '1',
        GLM_STATUSLINE_DEBUG: '1',
        COLUMNS: '120',
      },
    });
    assert.strictEqual(debugStatus.status, 0, debugStatus.stderr);
    assert.match(debugStatus.stderr, /quota API error/i);
    assert.match(debugStatus.stderr, /model usage API error/i);
  } finally {
    await close(debugServer);
  }
}

function verifyInstallerWorkflow({ tempDir }) {
  const settingsFile = path.join(tempDir, 'settings.json');
  const launcherFile = path.join(tempDir, 'glm-statusline-launcher.js');
  fs.writeFileSync(settingsFile, JSON.stringify({ env: { GLM_STATUSLINE_PLAN: 'GLM Lite' } }, null, 2));

  // 安装：写稳定启动器 + 接管 settings 的 statusLine
  const install = run(process.execPath, ['bin/glm-statusline-install.js', 'install'], {
    env: {
      GLM_STATUSLINE_SETTINGS_FILE: settingsFile,
      GLM_STATUSLINE_LAUNCHER_FILE: launcherFile,
      GLM_STATUSLINE_PLUGIN_CACHE_ROOT: path.join(tempDir, 'missing-plugin-cache'),
    },
  });
  assert.strictEqual(install.status, 0, install.stderr);
  const installedSettings = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
  assert.strictEqual(installedSettings.statusLine.type, 'command');
  assert.ok(fs.existsSync(launcherFile), 'install should write a stable launcher file');
  assert.match(installedSettings.statusLine.command, /glm-statusline-launcher\.js/);
  assert.doesNotMatch(installedSettings.statusLine.command, /plugins\/cache\/.*\/\d+\.\d+\.\d+\/bin\/glm-statusline\.js/);
  assert.strictEqual(installedSettings.statusLine.refreshInterval, 30);
  assert.strictEqual(installedSettings.statusLine.padding, 0);
  assert.strictEqual(installedSettings.env.GLM_STATUSLINE_PLAN, 'GLM Lite');
  // 安装输出打印固定全字段渲染的预览，并说明没有可配置项
  assert.match(install.stdout, /Preview:/);
  assert.match(install.stdout, /nothing to configure/i);

  // configure 子命令已随字段选择器移除 → 未知命令
  const configureGone = run(process.execPath, ['bin/glm-statusline-install.js', 'configure'], {
    env: {
      GLM_STATUSLINE_SETTINGS_FILE: settingsFile,
      GLM_STATUSLINE_LAUNCHER_FILE: launcherFile,
      GLM_STATUSLINE_CONFIG_FILE: path.join(tempDir, 'gone-config.json'),
      ANTHROPIC_AUTH_TOKEN: '',
      ANTHROPIC_BASE_URL: '',
    },
  });
  assert.notStrictEqual(configureGone.status, 0);
  assert.match(configureGone.stderr, /Unknown command: configure/);

  // 稳定启动器独立可跑：固定分组行不合并，COLUMNS=120 下 3 行（model/effort/plan 用 env 钉死）
  const launcherStatus = run(process.execPath, [launcherFile], {
    input: JSON.stringify({
      model: { display_name: 'Sonnet' },
      context_window: { used_percentage: 12, context_window_size: 200000 },
      transcript_path: path.join(os.tmpdir(), 'missing-glm-statusline-transcript.jsonl'),
    }),
    env: {
      ANTHROPIC_AUTH_TOKEN: '',
      ANTHROPIC_BASE_URL: '',
      ANTHROPIC_DEFAULT_SONNET_MODEL: 'glm-test',
      GLM_STATUSLINE_PLAN: '',
      GLM_STATUSLINE_CACHE_TTL_MS: '1',
      COLUMNS: '120',
      CLAUDE_CODE_EFFORT_LEVEL: '',
    },
  });
  assert.strictEqual(launcherStatus.status, 0, launcherStatus.stderr);
  const launcherLines = launcherStatus.stdout.trim().split('\n');
  assert.strictEqual(launcherLines.length, 3, launcherStatus.stdout);
  assert.match(launcherLines[0], /^Model GLM-test │ Effort -- │ Speed -- t\/s · Avg -- t\/s$/);
  assert.match(launcherLines[1], /^Context .+ 12% │ Session 0 │ Day 0 │ 30D 0$/);
  assert.match(launcherLines[2], /^GLM │ 5H ░░░░░░░░ 0% @--:-- │ MCP ░░░░░░░░ 0% @--$/);

  // 卸载：还原 settings、删启动器，并清理它过去管理的遗留 display 配置文件
  const uninstallConfigFile = path.join(tempDir, 'legacy-uninstall-config.json');
  fs.writeFileSync(uninstallConfigFile, JSON.stringify({ display: ['plan'] }, null, 2));
  const uninstall = run(process.execPath, ['bin/glm-statusline-install.js', 'uninstall'], {
    env: {
      GLM_STATUSLINE_SETTINGS_FILE: settingsFile,
      GLM_STATUSLINE_LAUNCHER_FILE: launcherFile,
      GLM_STATUSLINE_CONFIG_FILE: uninstallConfigFile,
    },
  });
  assert.strictEqual(uninstall.status, 0, uninstall.stderr);
  const uninstalledSettings = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
  assert.strictEqual(uninstalledSettings.statusLine, undefined);
  assert.ok(!fs.existsSync(launcherFile), 'uninstall should remove the stable launcher file');
  assert.ok(!fs.existsSync(uninstallConfigFile), 'uninstall should clean up the legacy config file');

  // 非本插件管理的 statusLine 且未加 --force → 什么都不动，遗留配置文件也包括在内
  const unmanagedSettingsFile = path.join(tempDir, 'unmanaged-settings.json');
  fs.writeFileSync(unmanagedSettingsFile, JSON.stringify({ statusLine: { type: 'command', command: 'other-tool' } }, null, 2));
  const unmanagedConfigFile = path.join(tempDir, 'unmanaged-legacy-config.json');
  fs.writeFileSync(unmanagedConfigFile, JSON.stringify({ display: ['plan'] }, null, 2));
  const unmanagedUninstall = run(process.execPath, ['bin/glm-statusline-install.js', 'uninstall'], {
    env: {
      GLM_STATUSLINE_SETTINGS_FILE: unmanagedSettingsFile,
      GLM_STATUSLINE_LAUNCHER_FILE: path.join(tempDir, 'unmanaged-launcher.js'),
      GLM_STATUSLINE_CONFIG_FILE: unmanagedConfigFile,
    },
  });
  assert.strictEqual(unmanagedUninstall.status, 0, unmanagedUninstall.stderr);
  assert.match(unmanagedUninstall.stdout, /Nothing changed/);
  assert.ok(fs.existsSync(unmanagedConfigFile), 'unmanaged uninstall must not delete the legacy config file');

  // --force 覆盖拒绝并执行清理
  const forcedUninstall = run(process.execPath, ['bin/glm-statusline-install.js', 'uninstall', '--force'], {
    env: {
      GLM_STATUSLINE_SETTINGS_FILE: unmanagedSettingsFile,
      GLM_STATUSLINE_LAUNCHER_FILE: path.join(tempDir, 'unmanaged-launcher.js'),
      GLM_STATUSLINE_CONFIG_FILE: unmanagedConfigFile,
    },
  });
  assert.strictEqual(forcedUninstall.status, 0, forcedUninstall.stderr);
  assert.ok(!fs.existsSync(unmanagedConfigFile), '--force uninstall should clean up the legacy config file');
}

// 坏文件钉住 lib/file-io.js readJsonFile 为安装器携带的刻意读取契约：必须响亮地失败
//（用户需要看到自己坏掉的 settings），绝不静默忽略。这是既有代码的行为 pin，
// 任何对读取器的重构都必须保持它为绿。
function verifyCorruptFilesAreHandled({ tempDir }) {
  // 坏 settings → install 响亮报错，而不是静默忽略用户的文件
  const corruptSettingsFile = path.join(tempDir, 'corrupt-settings.json');
  fs.writeFileSync(corruptSettingsFile, 'this is not json {');
  const installFailure = run(process.execPath, ['bin/glm-statusline-install.js', 'install'], {
    env: {
      GLM_STATUSLINE_SETTINGS_FILE: corruptSettingsFile,
      GLM_STATUSLINE_LAUNCHER_FILE: path.join(tempDir, 'corrupt-launcher.js'),
      GLM_STATUSLINE_PLUGIN_CACHE_ROOT: path.join(tempDir, 'missing-plugin-cache'),
    },
  });
  assert.notStrictEqual(installFailure.status, 0);
  assert.match(installFailure.stderr, /Cannot parse/);
}

async function verifyEffortAndContextFix({ tempDir }) {
  // effort 段：带 level 时渲染档位（Claude Code v2.1.119+ 会发 effort.level）
  const effortStatus = await runAsync(process.execPath, ['bin/glm-statusline.js'], {
    input: JSON.stringify({ model: { display_name: 'Sonnet' }, effort: { level: 'high' } }),
    env: baseEnv(path.join(tempDir, 'effort-cache.json')),
  });
  assert.strictEqual(effortStatus.status, 0, effortStatus.stderr);
  assert.match(effortStatus.stdout, /Effort high/);

  // effort 缺失（模型不支持）→ 诚实的占位符 --，不是空白
  const effortUnknown = await runAsync(process.execPath, ['bin/glm-statusline.js'], {
    input: JSON.stringify({ model: { display_name: 'Sonnet' } }),
    env: baseEnv(path.join(tempDir, 'effort-unknown-cache.json')),
  });
  assert.strictEqual(effortUnknown.status, 0, effortUnknown.stderr);
  assert.match(effortUnknown.stdout, /Effort --/);

  const sessionId = 'ctx-fix-session';

  // context 为 null（会话早期 / /compact 后）→ --%，绝不是 0%（全新缓存）
  const ctxFreshCache = path.join(tempDir, 'context-fresh-cache.json');
  fs.writeFileSync(ctxFreshCache, '{}');
  const ctxNullStatus = await runAsync(process.execPath, ['bin/glm-statusline.js'], {
    input: JSON.stringify({
      context_window: { used_percentage: null, context_window_size: 200000 },
      session_id: sessionId,
    }),
    env: baseEnv(ctxFreshCache),
  });
  assert.strictEqual(ctxNullStatus.status, 0, ctxNullStatus.stderr);
  assert.match(ctxNullStatus.stdout, /Context .+ --%/);
  assert.doesNotMatch(ctxNullStatus.stdout, /Context .+ 0%/);

  // null tick 沿用上次已知值（不闪 0%）
  const ctxHoldCache = path.join(tempDir, 'context-hold-cache.json');
  fs.writeFileSync(
    ctxHoldCache,
    JSON.stringify({ [`context:${sessionId}`]: { percent: 37, ts: Date.now() } }, null, 2)
  );
  const ctxHoldStatus = await runAsync(process.execPath, ['bin/glm-statusline.js'], {
    input: JSON.stringify({
      context_window: { used_percentage: null, context_window_size: 200000 },
      session_id: sessionId,
    }),
    env: baseEnv(ctxHoldCache),
  });
  assert.strictEqual(ctxHoldStatus.status, 0, ctxHoldStatus.stderr);
  assert.match(ctxHoldStatus.stdout, /Context .+ 37%/);
  assert.doesNotMatch(ctxHoldStatus.stdout, /Context .+ --%/);

  // 真实读数会被写入缓存，供之后的 null tick 保持
  const ctxWriteCache = path.join(tempDir, 'context-write-cache.json');
  fs.writeFileSync(ctxWriteCache, '{}');
  const ctxRealStatus = await runAsync(process.execPath, ['bin/glm-statusline.js'], {
    input: JSON.stringify({
      context_window: { used_percentage: 42, context_window_size: 200000 },
      session_id: sessionId,
    }),
    env: baseEnv(ctxWriteCache),
  });
  assert.strictEqual(ctxRealStatus.status, 0, ctxRealStatus.stderr);
  assert.match(ctxRealStatus.stdout, /Context .+ 42%/);
  const writtenCache = JSON.parse(fs.readFileSync(ctxWriteCache, 'utf8'));
  assert.strictEqual(writtenCache[`context:${sessionId}`]?.percent, 42);

  // 字面 0 tick 也沿用上次已知值。Claude Code 有时在会话切换（回合之间、切换模型）时发出
  // 字面 used_percentage: 0；真实的 0 不是 "null"，因此当已持有真值时保持逻辑必须把它当作
  // 瞬时值，否则进度条会闪 12% → 0% → 18%。
  const ctxZeroHoldCache = path.join(tempDir, 'context-zero-hold-cache.json');
  fs.writeFileSync(
    ctxZeroHoldCache,
    JSON.stringify({ [`context:${sessionId}`]: { percent: 37, ts: Date.now() } }, null, 2)
  );
  const ctxZeroHoldStatus = await runAsync(process.execPath, ['bin/glm-statusline.js'], {
    input: JSON.stringify({
      context_window: { used_percentage: 0, context_window_size: 200000 },
      session_id: sessionId,
    }),
    env: baseEnv(ctxZeroHoldCache),
  });
  assert.strictEqual(ctxZeroHoldStatus.status, 0, ctxZeroHoldStatus.stderr);
  assert.match(ctxZeroHoldStatus.stdout, /Context .+ 37%/);
  assert.doesNotMatch(ctxZeroHoldStatus.stdout, /Context .+ 0%/);
}

async function verifyTokenOutputSpeed({ tempDir }) {
  const speedCache = path.join(tempDir, 'speed-cache.json');
  const speedTranscript = path.join(tempDir, 'speed-transcript.jsonl');
  const sessionId = 'speed-session';

  // 写一行 transcript（可指定累计输出 token 与时间戳）
  const writeTranscript = (outTokens, isoTs) => {
    fs.writeFileSync(
      speedTranscript,
      `${JSON.stringify({
        timestamp: isoTs,
        message: { usage: { input_tokens: 1000, output_tokens: outTokens } },
      })}\n`
    );
  };

  // 1. 首帧播种基线：current = --；average = 200 / (10000/1000) = 20 tok/s
  fs.writeFileSync(speedCache, '{}');
  writeTranscript(200, new Date(Date.now() - 60000).toISOString());
  const first = await runAsync(process.execPath, ['bin/glm-statusline.js'], {
    input: JSON.stringify({ session_id: sessionId, transcript_path: speedTranscript, cost: { total_api_duration_ms: 10000 } }),
    env: baseEnv(speedCache),
  });
  assert.strictEqual(first.status, 0, first.stderr);
  assert.match(first.stdout, /Speed -- t\/s · Avg 20 t\/s/);
  const seededCache = JSON.parse(fs.readFileSync(speedCache, 'utf8'));
  assert.ok(seededCache[`speed:${sessionId}`], 'first render should seed the speed baseline');
  assert.strictEqual(seededCache[`speed:${sessionId}`].out, 200);

  // 1b. 输出为 0 但 cost 已 > 0 → average 是 --（绝不显示 Avg 0）
  const zeroCache = path.join(tempDir, 'speed-zero-cache.json');
  fs.writeFileSync(zeroCache, '{}');
  const zeroTranscript = path.join(tempDir, 'speed-zero-transcript.jsonl');
  fs.writeFileSync(
    zeroTranscript,
    `${JSON.stringify({ timestamp: new Date().toISOString(), message: { usage: { input_tokens: 1000, output_tokens: 0 } } })}\n`
  );
  const zeroStatus = await runAsync(process.execPath, ['bin/glm-statusline.js'], {
    input: JSON.stringify({ session_id: 'speed-zero-session', transcript_path: zeroTranscript, cost: { total_api_duration_ms: 5000 } }),
    env: baseEnv(zeroCache),
  });
  assert.strictEqual(zeroStatus.status, 0, zeroStatus.stderr);
  assert.match(zeroStatus.stdout, /Speed -- t\/s · Avg -- t\/s/);
  assert.doesNotMatch(zeroStatus.stdout, /Avg 0 t\/s/);

  // 2. 输出增长 500 token / 5000ms API 时间 → current 100。Avg 自首 tick 锚定
  //   （out0=200, api0=10000），avg = (700-200)/((15000-10000)/1000) = 500/5 = 100。
  writeTranscript(700, new Date().toISOString());
  const second = await runAsync(process.execPath, ['bin/glm-statusline.js'], {
    input: JSON.stringify({ session_id: sessionId, transcript_path: speedTranscript, cost: { total_api_duration_ms: 15000 } }),
    env: baseEnv(speedCache),
  });
  assert.strictEqual(second.status, 0, second.stderr);
  assert.match(second.stdout, /Speed 100 t\/s · Avg 100 t\/s/);

  // 3. 空闲保持上次值，即使基线 ts 早已过期（v2：不衰减到 0）
  const heldCache = JSON.parse(fs.readFileSync(speedCache, 'utf8'));
  heldCache[`speed:${sessionId}`].ts = Date.now() - 120000;
  fs.writeFileSync(speedCache, JSON.stringify(heldCache));
  const third = await runAsync(process.execPath, ['bin/glm-statusline.js'], {
    input: JSON.stringify({ session_id: sessionId, transcript_path: speedTranscript, cost: { total_api_duration_ms: 15000 } }),
    env: baseEnv(speedCache),
  });
  assert.strictEqual(third.status, 0, third.stderr);
  assert.match(third.stdout, /Speed 100 t\/s/);
  assert.doesNotMatch(third.stdout, /Speed 0 t\/s/);

  // 4. 缺 cost.total_api_duration_ms → average 是 --，current 回退到 transcript 时间跨度
  const fallbackCache = path.join(tempDir, 'speed-fallback-cache.json');
  fs.writeFileSync(fallbackCache, '{}');
  const fallbackTranscript = path.join(tempDir, 'speed-fallback-transcript.jsonl');
  const fallbackSession = 'speed-fallback-session';
  const writeFallback = (outTokens, isoTs) => {
    fs.writeFileSync(
      fallbackTranscript,
      `${JSON.stringify({
        timestamp: isoTs,
        message: { usage: { input_tokens: 500, output_tokens: outTokens } },
      })}\n`
    );
  };
  writeFallback(100, new Date(Date.now() - 10000).toISOString());
  await runAsync(process.execPath, ['bin/glm-statusline.js'], {
    input: JSON.stringify({ session_id: fallbackSession, transcript_path: fallbackTranscript }),
    env: baseEnv(fallbackCache),
  });
  writeFallback(900, new Date().toISOString());
  const fallbackSecond = await runAsync(process.execPath, ['bin/glm-statusline.js'], {
    input: JSON.stringify({ session_id: fallbackSession, transcript_path: fallbackTranscript }),
    env: baseEnv(fallbackCache),
  });
  assert.strictEqual(fallbackSecond.status, 0, fallbackSecond.stderr);
  assert.match(fallbackSecond.stdout, /Speed \d+ t\/s · Avg -- t\/s/);

  // 5. 固定分组布局下 speed 与其它全部字段同屏渲染
  const mixedCache = path.join(tempDir, 'speed-mixed-cache.json');
  fs.writeFileSync(mixedCache, '{}');
  const mixedTranscript = path.join(tempDir, 'speed-mixed-transcript.jsonl');
  const mixedSession = 'speed-mixed-session';
  const writeMixed = (outTokens, isoTs) => {
    fs.writeFileSync(
      mixedTranscript,
      `${JSON.stringify({
        timestamp: isoTs,
        message: { usage: { input_tokens: 1000, output_tokens: outTokens } },
      })}\n`
    );
  };
  writeMixed(400, new Date().toISOString());
  await runAsync(process.execPath, ['bin/glm-statusline.js'], {
    input: JSON.stringify({ session_id: mixedSession, transcript_path: mixedTranscript, cost: { total_api_duration_ms: 4000 } }),
    env: baseEnv(mixedCache),
  });
  writeMixed(800, new Date().toISOString());
  const mixed = await runAsync(process.execPath, ['bin/glm-statusline.js'], {
    input: JSON.stringify({ session_id: mixedSession, transcript_path: mixedTranscript, cost: { total_api_duration_ms: 8000 } }),
    env: baseEnv(mixedCache),
  });
  assert.strictEqual(mixed.status, 0, mixed.stderr);
  assert.match(mixed.stdout, /Speed \d+ t\/s · Avg \d+ t\/s/);
  assert.match(mixed.stdout, /Session \d/);

  // 6. /clear 式重置：累计输出跌到缓存基线之下（复用/滞后的 session_id 下开新会话，或播种
  //    tick 读到了陈旧的更大 transcript）。没有守卫时基线被毒化、current 整个会话冻在 --；
  //    有守卫时基线重新播种，下一个增长 tick 测到真实增量。
  const resetCache = path.join(tempDir, 'speed-reset-cache.json');
  fs.writeFileSync(resetCache, '{}');
  const resetTranscript = path.join(tempDir, 'speed-reset-transcript.jsonl');
  const resetSession = 'speed-reset-session';
  const writeReset = (outTokens, isoTs) => {
    fs.writeFileSync(
      resetTranscript,
      `${JSON.stringify({ timestamp: isoTs, message: { usage: { input_tokens: 1000, output_tokens: outTokens } } })}\n`
    );
  };
  // 先播种一个被毒化的大基线（模拟播种 tick 读到了上一会话的 transcript）
  writeReset(10000, new Date(Date.now() - 60000).toISOString());
  await runAsync(process.execPath, ['bin/glm-statusline.js'], {
    input: JSON.stringify({ session_id: resetSession, transcript_path: resetTranscript, cost: { total_api_duration_ms: 20000 } }),
    env: baseEnv(resetCache),
  });
  let resetCacheState = JSON.parse(fs.readFileSync(resetCache, 'utf8'));
  assert.strictEqual(resetCacheState[`speed:${resetSession}`].out, 10000);
  // /clear：累计输出跌到新会话的小值 → 重新播种
  writeReset(50, new Date(Date.now() - 5000).toISOString());
  const resetDrop = await runAsync(process.execPath, ['bin/glm-statusline.js'], {
    input: JSON.stringify({ session_id: resetSession, transcript_path: resetTranscript, cost: { total_api_duration_ms: 2000 } }),
    env: baseEnv(resetCache),
  });
  assert.strictEqual(resetDrop.status, 0, resetDrop.stderr);
  assert.match(resetDrop.stdout, /Speed -- t\/s · Avg 25 t\/s/); // avg = 50 / (2000/1000) = 25
  resetCacheState = JSON.parse(fs.readFileSync(resetCache, 'utf8'));
  assert.strictEqual(resetCacheState[`speed:${resetSession}`].out, 50);
  assert.strictEqual(resetCacheState[`speed:${resetSession}`].shown, null);
  // 新会话增长：必须测出真实的 current（而不是冻在 --）
  writeReset(160, new Date().toISOString());
  const resetGrowth = await runAsync(process.execPath, ['bin/glm-statusline.js'], {
    input: JSON.stringify({ session_id: resetSession, transcript_path: resetTranscript, cost: { total_api_duration_ms: 4000 } }),
    env: baseEnv(resetCache),
  });
  assert.strictEqual(resetGrowth.status, 0, resetGrowth.stderr);
  // dOut = 160-50 = 110，ΔapiMs = (4000-2000)/1000 = 2s → 55。Avg 自重置播种起锚定
  //（out0=50, api0=2000）：avg = (160-50)/((4000-2000)/1000) = 110/2 = 55。
  assert.match(resetGrowth.stdout, /Speed 55 t\/s · Avg 55 t\/s/);
  assert.doesNotMatch(resetGrowth.stdout, /Speed -- t\/s/);

  // 7. cost.total_api_duration_ms 在 /clear 后不归零 —— Claude Code 把进程级累计总量带进新会话，
  //    绝对平均（out / 总 API 耗时）会被与本会话输出无关的"外来"API 时间压低。Avg 必须锚定在
  //    本会话首个 tick（out0/api0），让带过来的基线在分子分母同时抵消。播种 tick 已见 api0 =
  //    180000 ms（外来基线）；此后 1000 token / 5 秒的真实增量必须读出 Avg ≈ 200（== current），
  //    而不是绝对公式（1300/185）算出的被压低的 ≈ 7。
  const carryCache = path.join(tempDir, 'speed-carry-cache.json');
  fs.writeFileSync(carryCache, '{}');
  const carryTranscript = path.join(tempDir, 'speed-carry-transcript.jsonl');
  const carrySession = 'speed-carry-session';
  const writeCarry = (outTokens, isoTs) => {
    fs.writeFileSync(
      carryTranscript,
      `${JSON.stringify({ timestamp: isoTs, message: { usage: { input_tokens: 1000, output_tokens: outTokens } } })}\n`
    );
  };
  writeCarry(300, new Date(Date.now() - 60000).toISOString());
  await runAsync(process.execPath, ['bin/glm-statusline.js'], {
    input: JSON.stringify({ session_id: carrySession, transcript_path: carryTranscript, cost: { total_api_duration_ms: 180000 } }),
    env: baseEnv(carryCache),
  });
  writeCarry(1300, new Date().toISOString());
  const carrySecond = await runAsync(process.execPath, ['bin/glm-statusline.js'], {
    input: JSON.stringify({ session_id: carrySession, transcript_path: carryTranscript, cost: { total_api_duration_ms: 185000 } }),
    env: baseEnv(carryCache),
  });
  assert.strictEqual(carrySecond.status, 0, carrySecond.stderr);
  assert.match(carrySecond.stdout, /Speed 200 t\/s · Avg 200 t\/s/);
  assert.doesNotMatch(carrySecond.stdout, /Avg [1-9] t\/s/); // 不许是被压低的个位数绝对值

  // 8. 空闲期间共享缓存丢失（如多项目并发写同一个缓存文件导致损坏）。播种会重建 shown:null
  //    的基线；随后的空闲 tick 必须回退到会话平均，而不是卡死在 '--'（空闲分支刻意不重写，
  //    没有回退就会一直 '--' 到下一条消息）。
  const lossCache = path.join(tempDir, 'speed-loss-cache.json');
  const lossTranscript = path.join(tempDir, 'speed-loss-transcript.jsonl');
  const lossSession = 'speed-loss-session';
  const writeLoss = (outTokens, isoTs) => {
    fs.writeFileSync(
      lossTranscript,
      `${JSON.stringify({ timestamp: isoTs, message: { usage: { input_tokens: 1000, output_tokens: outTokens } } })}\n`
    );
  };
  writeLoss(600, new Date().toISOString());
  // 模拟并发乱写在本会话首帧前清掉了条目
  fs.writeFileSync(lossCache, 'this is not json {'); // 解析失败时 loadCache → {}
  const lossReSeed = await runAsync(process.execPath, ['bin/glm-statusline.js'], {
    input: JSON.stringify({ session_id: lossSession, transcript_path: lossTranscript, cost: { total_api_duration_ms: 30000 } }),
    env: baseEnv(lossCache),
  });
  assert.strictEqual(lossReSeed.status, 0, lossReSeed.stderr);
  assert.match(lossReSeed.stdout, /Speed -- t\/s · Avg 20 t\/s/); // 播种 tick：诚实的 '--'，avg = 600/30
  // 空闲 tick：shown 为 null → 回退到绝对平均（600/30 = 20），不是 '--'
  const lossIdle = await runAsync(process.execPath, ['bin/glm-statusline.js'], {
    input: JSON.stringify({ session_id: lossSession, transcript_path: lossTranscript, cost: { total_api_duration_ms: 30000 } }),
    env: baseEnv(lossCache),
  });
  assert.strictEqual(lossIdle.status, 0, lossIdle.stderr);
  assert.match(lossIdle.stdout, /Speed 20 t\/s · Avg 20 t\/s/);
  assert.doesNotMatch(lossIdle.stdout, /Speed -- t\/s/);

  // 9. 原子写缓存：写后不残留临时文件，且缓存是合法 JSON
  const atomicDir = path.join(tempDir, 'speed-atomic');
  fs.mkdirSync(atomicDir, { recursive: true });
  const atomicCache = path.join(atomicDir, 'cache.json');
  fs.writeFileSync(atomicCache, '{}');
  const atomicTranscript = path.join(tempDir, 'speed-atomic-transcript.jsonl');
  fs.writeFileSync(
    atomicTranscript,
    `${JSON.stringify({ timestamp: new Date().toISOString(), message: { usage: { input_tokens: 1, output_tokens: 10 } } })}\n`
  );
  const atomicRun = await runAsync(process.execPath, ['bin/glm-statusline.js'], {
    input: JSON.stringify({ session_id: 'speed-atomic-session', transcript_path: atomicTranscript, cost: { total_api_duration_ms: 1000 } }),
    env: baseEnv(atomicCache),
  });
  assert.strictEqual(atomicRun.status, 0, atomicRun.stderr);
  const leakedTemps = fs.readdirSync(atomicDir).filter((f) => f.startsWith('cache.json.tmp.'));
  assert.strictEqual(leakedTemps.length, 0, `temp file leaked: ${leakedTemps.join(', ')}`);
  JSON.parse(fs.readFileSync(atomicCache, 'utf8')); // 缓存不是合法 JSON 时会抛错

  // 10. 去重：一条助手消息拆成 3 个内容块行（thinking/text/tool_use），每行都带完整
  //     message.usage，其 output_tokens 只能计一次（1000），而不是 3 倍（3000）。
  const dedupCache = path.join(tempDir, 'speed-dedup-cache.json');
  fs.writeFileSync(dedupCache, '{}');
  const dedupTranscript = path.join(tempDir, 'speed-dedup-transcript.jsonl');
  const dedupMsgId = 'msg_dedup_test_001';
  const dedupLine = (contentType) =>
    `${JSON.stringify({
      timestamp: new Date().toISOString(),
      message: { id: dedupMsgId, role: 'assistant', content: [{ type: contentType }], usage: { input_tokens: 1000, output_tokens: 1000 } },
    })}`;
  fs.writeFileSync(dedupTranscript, `${dedupLine('thinking')}\n${dedupLine('text')}\n${dedupLine('tool_use')}\n`);
  const dedupRun = await runAsync(process.execPath, ['bin/glm-statusline.js'], {
    input: JSON.stringify({ session_id: 'speed-dedup-session', transcript_path: dedupTranscript, cost: { total_api_duration_ms: 10000 } }),
    env: baseEnv(dedupCache),
  });
  assert.strictEqual(dedupRun.status, 0, dedupRun.stderr);
  // Avg = outputTokens / (apiMs/1000)。去重后 outputTokens=1000 → Avg 100；多算就是 300。
  assert.match(dedupRun.stdout, /Avg 100 t\/s/);
  assert.doesNotMatch(dedupRun.stdout, /Avg 300 t\/s/);
}

async function verifyGroupedLayout({ tempDir }) {
  // 1. 固定分组布局：任何宽度下都恰好 3 个类别行（model / session / quota）—— 行永不合并。
  //    model/plan 用 env 覆盖钉死。
  const groupedCache = path.join(tempDir, 'grouped-layout-cache.json');
  fs.writeFileSync(groupedCache, '{}');
  const groupedInput = JSON.stringify({
    model: { display_name: 'Sonnet' },
    effort: { level: 'high' },
    context_window: { used_percentage: 12, context_window_size: 200000 },
  });
  const groupedEnv = (columns) => ({
    ...baseEnv(groupedCache),
    COLUMNS: columns,
    ANTHROPIC_DEFAULT_SONNET_MODEL: 'glm-test',
    GLM_STATUSLINE_PLAN: '',
  });
  const grouped = await runAsync(process.execPath, ['bin/glm-statusline.js'], {
    input: groupedInput,
    env: groupedEnv('80'),
  });
  assert.strictEqual(grouped.status, 0, grouped.stderr);
  const groupedLines = grouped.stdout.trim().split('\n');
  assert.strictEqual(groupedLines.length, 3, `expected 3 grouped lines, got:\n${grouped.stdout}`);
  assert.match(groupedLines[0], /^Model GLM-test │ Effort high │ Speed -- t\/s · Avg -- t\/s$/);
  assert.match(groupedLines[1], /^Context .+ │ Session 0 │ Day 0 │ 30D 0$/);
  assert.match(groupedLines[2], /^GLM │ 5H ░░░░░░░░ 0% @--:-- │ MCP ░░░░░░░░ 0% @--$/);

  // 1b. 反合并回归 pin：COLUMNS=130 本可容纳 row1+row2（115）—— 行必须仍然渲染成 3 条独立行。
  const groupedWide = await runAsync(process.execPath, ['bin/glm-statusline.js'], {
    input: groupedInput,
    env: groupedEnv('130'),
  });
  assert.strictEqual(groupedWide.status, 0, groupedWide.stderr);
  const wideLines = groupedWide.stdout.trim().split('\n');
  assert.strictEqual(wideLines.length, 3, `expected 3 fixed rows, got:\n${groupedWide.stdout}`);
  assert.match(wideLines[0], /^Model GLM-test │ Effort high │ Speed -- t\/s · Avg -- t\/s$/);
  assert.match(wideLines[1], /^Context .+ │ Session 0 │ Day 0 │ 30D 0$/);
  assert.match(wideLines[2], /^GLM │ 5H ░░░░░░░░ 0% @--:-- │ MCP ░░░░░░░░ 0% @--$/);

  // 1c. 反合并回归 pin：COLUMNS=200 本可容纳全部三行（183）—— 仍然恰好 3 行。
  const groupedUltra = await runAsync(process.execPath, ['bin/glm-statusline.js'], {
    input: groupedInput,
    env: groupedEnv('200'),
  });
  assert.strictEqual(groupedUltra.status, 0, groupedUltra.stderr);
  const ultraLines = groupedUltra.stdout.trim().split('\n');
  assert.strictEqual(ultraLines.length, 3, `expected 3 fixed rows, got:\n${groupedUltra.stdout}`);
  assert.match(ultraLines[0], /^Model GLM-test │ Effort high │ Speed -- t\/s · Avg -- t\/s$/);
  assert.match(ultraLines[1], /^Context .+ │ Session 0 │ Day 0 │ 30D 0$/);
  assert.match(ultraLines[2], /^GLM │ 5H ░░░░░░░░ 0% @--:-- │ MCP ░░░░░░░░ 0% @--$/);
}

async function main() {
  verifyProjectMetadata();

  // 每次运行用独立的临时目录与缓存文件，互不污染
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'glm-statusline-plugin-'));
  verifyDefaultStatusLine(tempDir);

  const transcriptFile = path.join(tempDir, 'transcript.jsonl');
  const cacheFile = path.join(tempDir, 'glm-statusline-cache.json');
  writeTranscriptFixture(transcriptFile);
  const context = { cacheFile, tempDir, transcriptFile };

  await verifyApiBackedStatusLine(context);
  await verifyDebugLogging(context);
  verifyInstallerWorkflow(context);
  verifyCorruptFilesAreHandled(context);
  await verifyEffortAndContextFix(context);
  await verifyTokenOutputSpeed(context);
  await verifyGroupedLayout(context);
  console.log('All plugin verification checks passed.');
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
