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

function run(command, args, options = {}) {
  return spawnSync(command, args, {
    cwd: root,
    input: options.input,
    env: { ...process.env, ...(options.env || {}) },
    encoding: 'utf8',
  });
}

function runAsync(command, args, options = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: root,
      env: { ...process.env, ...(options.env || {}) },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
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

function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

// Shared env for statusline runs that don't need the live GLM API (empty token/url → fetchQuota
// returns its fallback immediately). Each call points at its own config/cache files.
function baseEnv(configFile, cacheFile) {
  return {
    ANTHROPIC_AUTH_TOKEN: '',
    ANTHROPIC_BASE_URL: '',
    GLM_STATUSLINE_CONFIG_FILE: configFile,
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
  const packageJson = readJson('package.json');
  assert.match(packageJson.version, /^\d+\.\d+\.\d+$/);
  const expectedVersion = packageJson.version;

  const plugin = readJson('.claude-plugin/plugin.json');
  assert.strictEqual(plugin.name, 'glm-statusline');
  assert.match(plugin.description, /GLM/i);
  assert.strictEqual(plugin.version, expectedVersion);

  const marketplace = readJson('.claude-plugin/marketplace.json');
  assert.strictEqual(marketplace.name, 'bingqiangzhou-tools');
  assert.ok(marketplace.plugins.some((entry) => entry.name === 'glm-statusline' && entry.source === './'));
  assert.strictEqual(marketplace.version, expectedVersion);
  assert.ok(marketplace.plugins.some((entry) => entry.name === 'glm-statusline' && entry.version === expectedVersion));

  const verifySource = fs.readFileSync(__filename, 'utf8');
  assert.doesNotMatch(
    verifySource,
    /assert\.strictEqual\([^,\n]+\.version,\s*['"][0-9]+\.[0-9]+\.[0-9]+['"]\)/,
    'version checks should compare manifests to package.json instead of hardcoding a release number'
  );

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

  assertFile('bin/glm-statusline.js');
  assertFile('bin/glm-statusline-install.js');
  assertFile('skills/configure/SKILL.md');
  assertFile('skills/install/SKILL.md');
  assertFile('skills/plan-details/SKILL.md');
  assertFile('skills/uninstall/SKILL.md');
  assertFile('docs/claude-code-plugin-build-guide.md');
  assertFile('docs/claude-code-skills-and-extensions-guide.md');
  assertFile('test/fixtures/quota-limit.json');
  assertFile('test/fixtures/model-usage-day.json');
  assertFile('test/fixtures/model-usage-month.json');

  const configureSkill = fs.readFileSync(path.join(root, 'skills/configure/SKILL.md'), 'utf8');
  const installSkill = fs.readFileSync(path.join(root, 'skills/install/SKILL.md'), 'utf8');
  assert.doesNotMatch(configureSkill, /--show|--layout|--bar-width|argument-hint/);
  assert.doesNotMatch(installSkill, /--show|--layout|--bar-width|argument-hint/);

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

function verifyDefaultStatusLine(isolatedDefaultConfigFile) {
  const status = run(process.execPath, ['bin/glm-statusline.js'], {
    input: JSON.stringify({
      model: { display_name: 'Sonnet' },
      context_window: { used_percentage: 12, context_window_size: 200000 },
      transcript_path: path.join(os.tmpdir(), 'missing-glm-statusline-transcript.jsonl'),
    }),
    env: {
      ANTHROPIC_AUTH_TOKEN: '',
      ANTHROPIC_BASE_URL: '',
      GLM_STATUSLINE_CONFIG_FILE: isolatedDefaultConfigFile,
      GLM_STATUSLINE_CACHE_TTL_MS: '1',
      COLUMNS: '120',
    },
  });
  assert.strictEqual(status.status, 0, status.stderr);
  assert.match(status.stdout, /5H/);
  assert.match(status.stdout, /MCP/);
  assert.match(status.stdout, /Session 0/);
  assert.match(status.stdout, /Day 0/);
  assert.doesNotMatch(status.stdout, /Context/);
  assert.doesNotMatch(status.stdout, /Effort/);
  assert.doesNotMatch(status.stdout, /Sess:/);
  assert.doesNotMatch(status.stdout, /Day:/);
  assert.doesNotMatch(status.stdout, /30D:/);
  assert.strictEqual(status.stdout.trim().split('\n').length, 1);
}

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

function createFixtureApiServer(requests) {
  const quotaFixture = readJson('test/fixtures/quota-limit.json');
  const dayUsageFixture = readJson('test/fixtures/model-usage-day.json');
  const monthUsageFixture = readJson('test/fixtures/model-usage-month.json');

  return http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    requests.push(url);
    res.setHeader('Content-Type', 'application/json');

    if (url.pathname === '/api/monitor/usage/quota/limit') {
      res.end(JSON.stringify(quotaFixture));
      return;
    }

    if (url.pathname === '/api/monitor/usage/model-usage') {
      const startTime = url.searchParams.get('startTime') || '';
      res.end(JSON.stringify(/\d{4}-\d{2}-\d{2} 00:00:00/.test(startTime) ? dayUsageFixture : monthUsageFixture));
      return;
    }

    res.statusCode = 404;
    res.end(JSON.stringify({ error: 'not found' }));
  });
}

async function verifyApiBackedStatusLine({ cacheFile, configFile, isolatedDefaultConfigFile, tempDir, transcriptFile }) {
  const requests = [];
  const server = createFixtureApiServer(requests);
  const port = await listen(server);
  try {
    const apiUsage = await runAsync(process.execPath, ['bin/glm-statusline.js'], {
      input: JSON.stringify({
        model: { display_name: 'Sonnet' },
        context_window: { used_percentage: 1, context_window_size: 200000 },
        transcript_path: transcriptFile,
      }),
      env: {
        ANTHROPIC_AUTH_TOKEN: 'test-token',
        ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}/api/anthropic`,
        GLM_STATUSLINE_CACHE_FILE: cacheFile,
        GLM_STATUSLINE_CONFIG_FILE: isolatedDefaultConfigFile,
        GLM_STATUSLINE_CACHE_TTL_MS: '60000',
        COLUMNS: '120',
      },
    });
    assert.strictEqual(apiUsage.status, 0, apiUsage.stderr);
    assert.match(apiUsage.stdout, /^5H .+ 10% @18:30 │ MCP .+ 20% @06-14 │ Session 2K │ Day 3K\s*$/);
    assert.doesNotMatch(apiUsage.stdout, /Context/);
    assert.doesNotMatch(apiUsage.stdout, /Sess:/);
    assert.doesNotMatch(apiUsage.stdout, /30D:/);
    assert.strictEqual(apiUsage.stdout.trim().split('\n').length, 1);

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
    assert.strictEqual(requests.filter((url) => url.pathname === '/api/monitor/usage/model-usage').length, 2);
    for (const url of requests.filter((item) => item.pathname === '/api/monitor/usage/model-usage')) {
      assert.match(url.searchParams.get('startTime') || '', /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
      assert.match(url.searchParams.get('endTime') || '', /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    }
    const testCache = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
    assert.ok(Object.keys(testCache).every((key) => key.includes(`http://127.0.0.1:${port}`)));

    fs.writeFileSync(
      configFile,
      JSON.stringify(
        {
          display: ['plan', '5h', 'mcp', 'day', '30d'],
        },
        null,
        2
      )
    );
    const configuredStatus = await runAsync(process.execPath, ['bin/glm-statusline.js'], {
      input: JSON.stringify({
        model: { display_name: 'Sonnet' },
        context_window: { used_percentage: 1, context_window_size: 200000 },
        transcript_path: transcriptFile,
      }),
      env: {
        ANTHROPIC_AUTH_TOKEN: 'test-token',
        ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}/api/anthropic`,
        GLM_STATUSLINE_CACHE_FILE: cacheFile,
        GLM_STATUSLINE_CONFIG_FILE: configFile,
        GLM_STATUSLINE_CACHE_TTL_MS: '60000',
        COLUMNS: '120',
      },
    });
    assert.strictEqual(configuredStatus.status, 0, configuredStatus.stderr);
    assert.match(configuredStatus.stdout, /^GLM Test │ 5H .+ 10% @18:30 │ MCP .+ 20% @06-14 │ Day 3K │ 30D 5\.98B\s*$/);
    assert.doesNotMatch(configuredStatus.stdout, /Context/);
    assert.doesNotMatch(configuredStatus.stdout, /Session/);

    const wrappedStatus = await runAsync(process.execPath, ['bin/glm-statusline.js'], {
      input: JSON.stringify({
        model: { display_name: 'Sonnet' },
        context_window: { used_percentage: 1, context_window_size: 200000 },
        transcript_path: transcriptFile,
      }),
      env: {
        ANTHROPIC_AUTH_TOKEN: 'test-token',
        ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}/api/anthropic`,
        GLM_STATUSLINE_CACHE_FILE: cacheFile,
        GLM_STATUSLINE_CONFIG_FILE: configFile,
        GLM_STATUSLINE_CACHE_TTL_MS: '60000',
        COLUMNS: '52',
      },
    });
    assert.strictEqual(wrappedStatus.status, 0, wrappedStatus.stderr);
    const wrappedLines = wrappedStatus.stdout.trim().split('\n');
    assert.strictEqual(wrappedLines.length, 2);
    assert.match(wrappedLines[0], /^GLM Test │ 5H .+ 10% @18:30$/);
    assert.match(wrappedLines[1], /^MCP .+ 20% @06-14 │ Day 3K │ 30D 5\.98B$/);
    assert.ok(wrappedLines.every((line) => line.length <= 52), wrappedStatus.stdout);

    const contextConfigFile = path.join(tempDir, 'context-wrap-config.json');
    fs.writeFileSync(
      contextConfigFile,
      JSON.stringify(
        {
          display: ['plan', '5h', 'mcp', 'context', 'model', 'session', 'day', '30d'],
        },
        null,
        2
      )
    );
    const contextWrappedStatus = await runAsync(process.execPath, ['bin/glm-statusline.js'], {
      input: JSON.stringify({
        model: { display_name: 'Sonnet' },
        context_window: { used_percentage: 12, context_window_size: 200000 },
        transcript_path: transcriptFile,
      }),
      env: {
        ANTHROPIC_AUTH_TOKEN: 'test-token',
        ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}/api/anthropic`,
        GLM_STATUSLINE_CACHE_FILE: cacheFile,
        GLM_STATUSLINE_CONFIG_FILE: contextConfigFile,
        GLM_STATUSLINE_CACHE_TTL_MS: '60000',
        COLUMNS: '80',
      },
    });
    assert.strictEqual(contextWrappedStatus.status, 0, contextWrappedStatus.stderr);
    const contextLines = contextWrappedStatus.stdout.trim().split('\n');
    assert.ok(contextLines.length >= 2, contextWrappedStatus.stdout);
    assert.match(contextLines.join('\n'), /Context .+ 12%/);
    assert.doesNotMatch(contextLines[0], /Context .+$/);

    const preview = await runAsync(process.execPath, ['bin/glm-statusline.js', '--preview'], {
      input: JSON.stringify({
        model: { display_name: 'Sonnet' },
        context_window: { used_percentage: 1, context_window_size: 200000 },
        transcript_path: transcriptFile,
      }),
      env: {
        ANTHROPIC_AUTH_TOKEN: 'test-token',
        ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}/api/anthropic`,
        GLM_STATUSLINE_CACHE_FILE: cacheFile,
        GLM_STATUSLINE_CONFIG_FILE: configFile,
        GLM_STATUSLINE_CACHE_TTL_MS: '60000',
        COLUMNS: '120',
      },
    });
    assert.strictEqual(preview.status, 0, preview.stderr);
    assert.match(preview.stdout, /^Preview:\nGLM Test │ 5H .+ 10% @18:30 │ MCP .+ 20% @06-14 │ Day 3K │ 30D 5\.98B\s*$/);
  } finally {
    await close(server);
  }
}

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

async function verifyDebugLogging({ configFile, tempDir, transcriptFile }) {
  const debugServer = createFailingApiServer();
  const debugPort = await listen(debugServer);
  try {
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
        GLM_STATUSLINE_CONFIG_FILE: configFile,
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

function verifyInstallerWorkflow({ isolatedDefaultConfigFile, tempDir }) {
  const settingsFile = path.join(tempDir, 'settings.json');
  const launcherFile = path.join(tempDir, 'glm-statusline-launcher.js');
  const installConfigFile = path.join(tempDir, 'install-config.json');
  fs.writeFileSync(settingsFile, JSON.stringify({ env: { GLM_STATUSLINE_PLAN: 'GLM Lite' } }, null, 2));

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
  assert.strictEqual(installedSettings.statusLine.refreshInterval, 5);
  assert.strictEqual(installedSettings.statusLine.padding, 0);
  assert.strictEqual(installedSettings.env.GLM_STATUSLINE_PLAN, 'GLM Lite');
  assert.match(install.stdout, /\/glm-statusline:configure/);
  assert.match(install.stdout, /choose which fields are shown/i);

  const unsupportedConfigureArgs = run(process.execPath, ['bin/glm-statusline-install.js', 'configure', '--show=plan,5h'], {
    env: {
      GLM_STATUSLINE_CONFIG_FILE: installConfigFile,
      GLM_STATUSLINE_CACHE_FILE: path.join(tempDir, 'configure-cache.json'),
      ANTHROPIC_AUTH_TOKEN: '',
      ANTHROPIC_BASE_URL: '',
      GLM_STATUSLINE_PLAN: 'GLM Lite',
    },
  });
  assert.notStrictEqual(unsupportedConfigureArgs.status, 0);
  assert.match(unsupportedConfigureArgs.stderr, /interactive selector/i);

  const interactiveConfigFile = path.join(tempDir, 'interactive-config.json');
  const interactive = run(process.execPath, ['bin/glm-statusline-install.js', 'configure'], {
    input: '1\nq\n',
    env: {
      GLM_STATUSLINE_CONFIG_FILE: interactiveConfigFile,
      GLM_STATUSLINE_CACHE_FILE: path.join(tempDir, 'interactive-cache.json'),
      ANTHROPIC_AUTH_TOKEN: '',
      ANTHROPIC_BASE_URL: '',
      GLM_STATUSLINE_PLAN: 'GLM Lite',
    },
  });
  assert.strictEqual(interactive.status, 0, interactive.stderr);
  assert.match(interactive.stdout, /Select fields to show/);
  assert.ok((interactive.stdout.match(/Preview:/g) || []).length >= 2);
  assert.match(interactive.stdout, /1\. \[x\] plan/);
  assert.match(interactive.stdout, /3\. \[x\] mcp/);
  const interactiveConfig = JSON.parse(fs.readFileSync(interactiveConfigFile, 'utf8'));
  assert.deepStrictEqual(interactiveConfig.display, ['plan', '5h', 'mcp', 'session', 'day']);

  const launcherStatus = run(process.execPath, [launcherFile], {
    input: JSON.stringify({
      model: { display_name: 'Sonnet' },
      context_window: { used_percentage: 12, context_window_size: 200000 },
      transcript_path: path.join(os.tmpdir(), 'missing-glm-statusline-transcript.jsonl'),
    }),
    env: {
      ANTHROPIC_AUTH_TOKEN: '',
      ANTHROPIC_BASE_URL: '',
      GLM_STATUSLINE_CONFIG_FILE: isolatedDefaultConfigFile,
      GLM_STATUSLINE_CACHE_TTL_MS: '1',
      COLUMNS: '120',
    },
  });
  assert.strictEqual(launcherStatus.status, 0, launcherStatus.stderr);
  assert.match(launcherStatus.stdout, /^5H .+ @--:-- │ MCP .+ 0% @-- │ Session 0 │ Day 0\s*$/);
  assert.doesNotMatch(launcherStatus.stdout, /Context/);

  const uninstall = run(process.execPath, ['bin/glm-statusline-install.js', 'uninstall'], {
    env: {
      GLM_STATUSLINE_SETTINGS_FILE: settingsFile,
      GLM_STATUSLINE_LAUNCHER_FILE: launcherFile,
    },
  });
  assert.strictEqual(uninstall.status, 0, uninstall.stderr);
  const uninstalledSettings = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
  assert.strictEqual(uninstalledSettings.statusLine, undefined);
  assert.ok(!fs.existsSync(launcherFile), 'uninstall should remove the stable launcher file');
}

async function verifyEffortAndContextFix({ tempDir }) {
  // Effort segment: level present renders it (Claude Code v2.1.119+ sends effort.level).
  const effortConfig = path.join(tempDir, 'effort-config.json');
  fs.writeFileSync(effortConfig, JSON.stringify({ display: ['model', 'effort'] }, null, 2));
  const effortStatus = await runAsync(process.execPath, ['bin/glm-statusline.js'], {
    input: JSON.stringify({ model: { display_name: 'Sonnet' }, effort: { level: 'high' } }),
    env: baseEnv(effortConfig, path.join(tempDir, 'effort-cache.json')),
  });
  assert.strictEqual(effortStatus.status, 0, effortStatus.stderr);
  assert.match(effortStatus.stdout, /Effort high/);

  // Effort absent (model doesn't support effort) -> honest placeholder, not blank.
  const effortUnknownConfig = path.join(tempDir, 'effort-unknown-config.json');
  fs.writeFileSync(effortUnknownConfig, JSON.stringify({ display: ['effort'] }, null, 2));
  const effortUnknown = await runAsync(process.execPath, ['bin/glm-statusline.js'], {
    input: JSON.stringify({ model: { display_name: 'Sonnet' } }),
    env: baseEnv(effortUnknownConfig, path.join(tempDir, 'effort-unknown-cache.json')),
  });
  assert.strictEqual(effortUnknown.status, 0, effortUnknown.stderr);
  assert.match(effortUnknown.stdout, /Effort --/);

  const sessionId = 'ctx-fix-session';
  const ctxConfig = path.join(tempDir, 'context-fix-config.json');
  fs.writeFileSync(ctxConfig, JSON.stringify({ display: ['context'] }, null, 2));

  // Context null (early session / after /compact) -> --%, never 0%, with a fresh cache.
  const ctxFreshCache = path.join(tempDir, 'context-fresh-cache.json');
  fs.writeFileSync(ctxFreshCache, '{}');
  const ctxNullStatus = await runAsync(process.execPath, ['bin/glm-statusline.js'], {
    input: JSON.stringify({
      context_window: { used_percentage: null, context_window_size: 200000 },
      session_id: sessionId,
    }),
    env: baseEnv(ctxConfig, ctxFreshCache),
  });
  assert.strictEqual(ctxNullStatus.status, 0, ctxNullStatus.stderr);
  assert.match(ctxNullStatus.stdout, /Context .+ --%/);
  assert.doesNotMatch(ctxNullStatus.stdout, /Context .+ 0%/);

  // Context holds the last known value across a null tick (no flicker to 0%).
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
    env: baseEnv(ctxConfig, ctxHoldCache),
  });
  assert.strictEqual(ctxHoldStatus.status, 0, ctxHoldStatus.stderr);
  assert.match(ctxHoldStatus.stdout, /Context .+ 37%/);
  assert.doesNotMatch(ctxHoldStatus.stdout, /Context .+ --%/);

  // Context caches a real value so a subsequent null tick can hold it.
  const ctxWriteCache = path.join(tempDir, 'context-write-cache.json');
  fs.writeFileSync(ctxWriteCache, '{}');
  const ctxRealStatus = await runAsync(process.execPath, ['bin/glm-statusline.js'], {
    input: JSON.stringify({
      context_window: { used_percentage: 42, context_window_size: 200000 },
      session_id: sessionId,
    }),
    env: baseEnv(ctxConfig, ctxWriteCache),
  });
  assert.strictEqual(ctxRealStatus.status, 0, ctxRealStatus.stderr);
  assert.match(ctxRealStatus.stdout, /Context .+ 42%/);
  const writtenCache = JSON.parse(fs.readFileSync(ctxWriteCache, 'utf8'));
  assert.strictEqual(writtenCache[`context:${sessionId}`]?.percent, 42);

  // Context holds the last known value across a reported 0 tick. Claude Code sometimes
  // emits a literal `used_percentage: 0` during session transitions (between turns, model
  // switch); a real 0 is not "null", so the hold logic must treat it as transient when we
  // already have a real value, or the bar flashes 12% -> 0% -> 18%.
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
    env: baseEnv(ctxConfig, ctxZeroHoldCache),
  });
  assert.strictEqual(ctxZeroHoldStatus.status, 0, ctxZeroHoldStatus.stderr);
  assert.match(ctxZeroHoldStatus.stdout, /Context .+ 37%/);
  assert.doesNotMatch(ctxZeroHoldStatus.stdout, /Context .+ 0%/);
}

async function verifyTokenOutputSpeed({ tempDir }) {
  const speedConfig = path.join(tempDir, 'speed-config.json');
  fs.writeFileSync(speedConfig, JSON.stringify({ display: ['speed'] }, null, 2));
  const speedCache = path.join(tempDir, 'speed-cache.json');
  const speedTranscript = path.join(tempDir, 'speed-transcript.jsonl');
  const sessionId = 'speed-session';

  const writeTranscript = (outTokens, isoTs) => {
    fs.writeFileSync(
      speedTranscript,
      `${JSON.stringify({
        timestamp: isoTs,
        message: { usage: { input_tokens: 1000, output_tokens: outTokens } },
      })}\n`
    );
  };

  // 1. First render seeds the baseline; no speed yet -> Speed -- t/s.
  fs.writeFileSync(speedCache, '{}');
  writeTranscript(200, new Date(Date.now() - 60000).toISOString());
  const first = await runAsync(process.execPath, ['bin/glm-statusline.js'], {
    input: JSON.stringify({ session_id: sessionId, transcript_path: speedTranscript, cost: { total_api_duration_ms: 10000 } }),
    env: baseEnv(speedConfig, speedCache),
  });
  assert.strictEqual(first.status, 0, first.stderr);
  assert.match(first.stdout, /Speed -- t\/s/);
  const seededCache = JSON.parse(fs.readFileSync(speedCache, 'utf8'));
  assert.ok(seededCache[`speed:${sessionId}`], 'first render should seed the speed baseline');
  assert.strictEqual(seededCache[`speed:${sessionId}`].out, 200);

  // 2. Output grew 500 tokens over 5000ms of API time -> 100 tok/s.
  writeTranscript(700, new Date().toISOString());
  const second = await runAsync(process.execPath, ['bin/glm-statusline.js'], {
    input: JSON.stringify({ session_id: sessionId, transcript_path: speedTranscript, cost: { total_api_duration_ms: 15000 } }),
    env: baseEnv(speedConfig, speedCache),
  });
  assert.strictEqual(second.status, 0, second.stderr);
  assert.match(second.stdout, /Speed 100 t\/s/);

  // 3. Idle (no new output), within decay window -> holds last shown value.
  const heldCache = JSON.parse(fs.readFileSync(speedCache, 'utf8'));
  heldCache[`speed:${sessionId}`].ts = Date.now() - 5000;
  fs.writeFileSync(speedCache, JSON.stringify(heldCache));
  const third = await runAsync(process.execPath, ['bin/glm-statusline.js'], {
    input: JSON.stringify({ session_id: sessionId, transcript_path: speedTranscript, cost: { total_api_duration_ms: 15000 } }),
    env: baseEnv(speedConfig, speedCache),
  });
  assert.strictEqual(third.status, 0, third.stderr);
  assert.match(third.stdout, /Speed 100 t\/s/);

  // 4. Idle past decay threshold -> Speed 0 t/s.
  const decayedCache = JSON.parse(fs.readFileSync(speedCache, 'utf8'));
  decayedCache[`speed:${sessionId}`].ts = Date.now() - 60000;
  fs.writeFileSync(speedCache, JSON.stringify(decayedCache));
  const fourth = await runAsync(process.execPath, ['bin/glm-statusline.js'], {
    input: JSON.stringify({ session_id: sessionId, transcript_path: speedTranscript, cost: { total_api_duration_ms: 15000 } }),
    env: baseEnv(speedConfig, speedCache),
  });
  assert.strictEqual(fourth.status, 0, fourth.stderr);
  assert.match(fourth.stdout, /Speed 0 t\/s/);

  // 5. Missing cost.total_api_duration_ms -> falls back to transcript-timestamp span.
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
    env: baseEnv(speedConfig, fallbackCache),
  });
  writeFallback(900, new Date().toISOString());
  const fallbackSecond = await runAsync(process.execPath, ['bin/glm-statusline.js'], {
    input: JSON.stringify({ session_id: fallbackSession, transcript_path: fallbackTranscript }),
    env: baseEnv(speedConfig, fallbackCache),
  });
  assert.strictEqual(fallbackSecond.status, 0, fallbackSecond.stderr);
  // dOut=800 over ~10s span -> ~80 tok/s (formatSpeed rounds 80 -> "80").
  assert.match(fallbackSecond.stdout, /Speed \d+ t\/s/);
}

async function main() {
  verifyProjectMetadata();

  const isolatedDefaultConfigFile = path.join(os.tmpdir(), `missing-glm-statusline-config-${process.pid}.json`);
  verifyDefaultStatusLine(isolatedDefaultConfigFile);

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'glm-statusline-plugin-'));
  const transcriptFile = path.join(tempDir, 'transcript.jsonl');
  const cacheFile = path.join(tempDir, 'glm-statusline-cache.json');
  const configFile = path.join(tempDir, 'glm-statusline-config.json');
  writeTranscriptFixture(transcriptFile);
  const context = { cacheFile, configFile, isolatedDefaultConfigFile, tempDir, transcriptFile };

  await verifyApiBackedStatusLine(context);
  await verifyDebugLogging(context);
  verifyInstallerWorkflow(context);
  await verifyEffortAndContextFix(context);
  await verifyTokenOutputSpeed(context);
  console.log('All plugin verification checks passed.');
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
