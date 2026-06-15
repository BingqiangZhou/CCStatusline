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
  // Default layout is grouped: the default fields (5h, mcp, session, day) span two rows.
  assert.strictEqual(status.stdout.trim().split('\n').length, 2);
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
    // Default layout is grouped: Session/Day on the conversation row, 5H/MCP on the quota row.
    const apiLines = apiUsage.stdout.trim().split('\n');
    assert.strictEqual(apiLines.length, 2);
    assert.match(apiLines[0], /^Session 2K │ Day 3K$/);
    assert.match(apiLines[1], /^5H .+ 10% @18:30 │ MCP .+ 20% @06-14$/);
    assert.doesNotMatch(apiUsage.stdout, /Context/);
    assert.doesNotMatch(apiUsage.stdout, /Sess:/);
    assert.doesNotMatch(apiUsage.stdout, /30D:/);

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
          layout: 'single',
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
          layout: 'single',
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
  // Default layout is grouped: Session/Day on row 2, 5H/MCP on row 3.
  const launcherLines = launcherStatus.stdout.trim().split('\n');
  assert.strictEqual(launcherLines.length, 2);
  assert.match(launcherLines[0], /^Session 0 │ Day 0$/);
  assert.match(launcherLines[1], /^5H .+ @--:-- │ MCP .+ 0% @--$/);
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

  // 1. First render seeds the baseline. current = --; average = 200 / (10000/1000) = 20 tok/s.
  fs.writeFileSync(speedCache, '{}');
  writeTranscript(200, new Date(Date.now() - 60000).toISOString());
  const first = await runAsync(process.execPath, ['bin/glm-statusline.js'], {
    input: JSON.stringify({ session_id: sessionId, transcript_path: speedTranscript, cost: { total_api_duration_ms: 10000 } }),
    env: baseEnv(speedConfig, speedCache),
  });
  assert.strictEqual(first.status, 0, first.stderr);
  assert.match(first.stdout, /Speed -- t\/s · Avg 20 t\/s/);
  assert.strictEqual(first.stdout.trim().split('\n').length, 1, 'speed-only config renders a single line');
  const seededCache = JSON.parse(fs.readFileSync(speedCache, 'utf8'));
  assert.ok(seededCache[`speed:${sessionId}`], 'first render should seed the speed baseline');
  assert.strictEqual(seededCache[`speed:${sessionId}`].out, 200);

  // 1b. Zero output so far but cost already > 0 -> average is -- (never Avg 0).
  const zeroCache = path.join(tempDir, 'speed-zero-cache.json');
  fs.writeFileSync(zeroCache, '{}');
  const zeroTranscript = path.join(tempDir, 'speed-zero-transcript.jsonl');
  fs.writeFileSync(
    zeroTranscript,
    `${JSON.stringify({ timestamp: new Date().toISOString(), message: { usage: { input_tokens: 1000, output_tokens: 0 } } })}\n`
  );
  const zeroStatus = await runAsync(process.execPath, ['bin/glm-statusline.js'], {
    input: JSON.stringify({ session_id: 'speed-zero-session', transcript_path: zeroTranscript, cost: { total_api_duration_ms: 5000 } }),
    env: baseEnv(speedConfig, zeroCache),
  });
  assert.strictEqual(zeroStatus.status, 0, zeroStatus.stderr);
  assert.match(zeroStatus.stdout, /Speed -- t\/s · Avg -- t\/s/);
  assert.doesNotMatch(zeroStatus.stdout, /Avg 0 t\/s/);

  // 2. Output grew 500 tokens over 5000ms API time -> current 100. Avg is anchored since the
  //    first tick (out0=200, api0=10000), so avg = (700-200)/((15000-10000)/1000) = 500/5 = 100.
  writeTranscript(700, new Date().toISOString());
  const second = await runAsync(process.execPath, ['bin/glm-statusline.js'], {
    input: JSON.stringify({ session_id: sessionId, transcript_path: speedTranscript, cost: { total_api_duration_ms: 15000 } }),
    env: baseEnv(speedConfig, speedCache),
  });
  assert.strictEqual(second.status, 0, second.stderr);
  assert.match(second.stdout, /Speed 100 t\/s · Avg 100 t\/s/);

  // 3. Idle holds the last value even when the baseline ts is long stale (v2: no decay to 0).
  const heldCache = JSON.parse(fs.readFileSync(speedCache, 'utf8'));
  heldCache[`speed:${sessionId}`].ts = Date.now() - 120000;
  fs.writeFileSync(speedCache, JSON.stringify(heldCache));
  const third = await runAsync(process.execPath, ['bin/glm-statusline.js'], {
    input: JSON.stringify({ session_id: sessionId, transcript_path: speedTranscript, cost: { total_api_duration_ms: 15000 } }),
    env: baseEnv(speedConfig, speedCache),
  });
  assert.strictEqual(third.status, 0, third.stderr);
  assert.match(third.stdout, /Speed 100 t\/s/);
  assert.doesNotMatch(third.stdout, /Speed 0 t\/s/);

  // 4. Missing cost.total_api_duration_ms -> average is --, current falls back to transcript span.
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
  assert.match(fallbackSecond.stdout, /Speed \d+ t\/s · Avg -- t\/s/);

  // 5. Speed shares the status line with another field: speed sits on its own trailing line.
  const mixedConfig = path.join(tempDir, 'speed-mixed-config.json');
  fs.writeFileSync(mixedConfig, JSON.stringify({ display: ['session', 'speed'], layout: 'single' }, null, 2));
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
    env: baseEnv(mixedConfig, mixedCache),
  });
  writeMixed(800, new Date().toISOString());
  const mixed = await runAsync(process.execPath, ['bin/glm-statusline.js'], {
    input: JSON.stringify({ session_id: mixedSession, transcript_path: mixedTranscript, cost: { total_api_duration_ms: 8000 } }),
    env: baseEnv(mixedConfig, mixedCache),
  });
  assert.strictEqual(mixed.status, 0, mixed.stderr);
  const mixedLines = mixed.stdout.trim().split('\n');
  assert.strictEqual(mixedLines.length, 2, 'speed sits on its own line below the main fields');
  assert.match(mixedLines[0], /Session/);
  assert.doesNotMatch(mixedLines[0], /Speed/);
  assert.match(mixedLines[1], /^Speed \d+ t\/s · Avg \d+ t\/s$/);

  // 6. /clear-style reset: cumulative output drops below the cached baseline (new session under a
  //    reused/lagging session_id, or a seed tick that captured a stale larger transcript). Without
  //    the guard the baseline stays poisoned and `current` freezes at -- for the rest of the
  //    session; with it, the baseline re-seeds and the next growth tick measures a real delta.
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
  // Seed a poisoned large baseline (simulates a seed tick that read the previous session's transcript).
  writeReset(10000, new Date(Date.now() - 60000).toISOString());
  await runAsync(process.execPath, ['bin/glm-statusline.js'], {
    input: JSON.stringify({ session_id: resetSession, transcript_path: resetTranscript, cost: { total_api_duration_ms: 20000 } }),
    env: baseEnv(speedConfig, resetCache),
  });
  let resetCacheState = JSON.parse(fs.readFileSync(resetCache, 'utf8'));
  assert.strictEqual(resetCacheState[`speed:${resetSession}`].out, 10000);
  // /clear: cumulative output drops to a small new-session value -> re-seed.
  writeReset(50, new Date(Date.now() - 5000).toISOString());
  const resetDrop = await runAsync(process.execPath, ['bin/glm-statusline.js'], {
    input: JSON.stringify({ session_id: resetSession, transcript_path: resetTranscript, cost: { total_api_duration_ms: 2000 } }),
    env: baseEnv(speedConfig, resetCache),
  });
  assert.strictEqual(resetDrop.status, 0, resetDrop.stderr);
  assert.match(resetDrop.stdout, /Speed -- t\/s · Avg 25 t\/s/); // avg = 50 / (2000/1000) = 25
  resetCacheState = JSON.parse(fs.readFileSync(resetCache, 'utf8'));
  assert.strictEqual(resetCacheState[`speed:${resetSession}`].out, 50);
  assert.strictEqual(resetCacheState[`speed:${resetSession}`].shown, null);
  // New session grows: a real current must be measured (not frozen at --).
  writeReset(160, new Date().toISOString());
  const resetGrowth = await runAsync(process.execPath, ['bin/glm-statusline.js'], {
    input: JSON.stringify({ session_id: resetSession, transcript_path: resetTranscript, cost: { total_api_duration_ms: 4000 } }),
    env: baseEnv(speedConfig, resetCache),
  });
  assert.strictEqual(resetGrowth.status, 0, resetGrowth.stderr);
  // dOut = 160-50 = 110 over ΔapiMs (4000-2000)/1000 = 2s -> 55. Avg is anchored since the reset
  // re-seed (out0=50, api0=2000): avg = (160-50)/((4000-2000)/1000) = 110/2 = 55.
  assert.match(resetGrowth.stdout, /Speed 55 t\/s · Avg 55 t\/s/);
  assert.doesNotMatch(resetGrowth.stdout, /Speed -- t\/s/);

  // 7. cost.total_api_duration_ms does NOT reset on /clear — Claude Code carries a process-lifetime
  //    total into the new session, so the absolute average (out / totalApi) is depressed by foreign
  //    API time that has nothing to do with this session's output. Avg must anchor at this session's
  //    first tick (out0/api0) so the carried-over base cancels in both numerator and denominator.
  //    Seed tick already sees api0 = 180000 ms (foreign base); a 1000-token / 5 s real increment
  //    must read Avg ~200 (== current), NOT the depressed ~7 the absolute formula (1300/185) yields.
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
    env: baseEnv(speedConfig, carryCache),
  });
  writeCarry(1300, new Date().toISOString());
  const carrySecond = await runAsync(process.execPath, ['bin/glm-statusline.js'], {
    input: JSON.stringify({ session_id: carrySession, transcript_path: carryTranscript, cost: { total_api_duration_ms: 185000 } }),
    env: baseEnv(speedConfig, carryCache),
  });
  assert.strictEqual(carrySecond.status, 0, carrySecond.stderr);
  assert.match(carrySecond.stdout, /Speed 200 t\/s · Avg 200 t\/s/);
  assert.doesNotMatch(carrySecond.stdout, /Avg [1-9] t\/s/); // not the depressed single-digit absolute

  // 8. Shared-cache loss during idle (e.g. corruption from concurrent projects writing the one
  //    cache file). The seed re-establishes a baseline with shown:null; the following idle tick
  //    must fall back to the session average instead of stranding at '--' (the idle branch never
  //    rewrites, so without the fallback it would stay '--' until the next message).
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
  // Simulate a concurrent garbled write wiping the entry before this session's first render.
  fs.writeFileSync(lossCache, 'this is not json {'); // loadCache -> {} on parse error
  const lossReSeed = await runAsync(process.execPath, ['bin/glm-statusline.js'], {
    input: JSON.stringify({ session_id: lossSession, transcript_path: lossTranscript, cost: { total_api_duration_ms: 30000 } }),
    env: baseEnv(speedConfig, lossCache),
  });
  assert.strictEqual(lossReSeed.status, 0, lossReSeed.stderr);
  assert.match(lossReSeed.stdout, /Speed -- t\/s · Avg 20 t\/s/); // seed tick: honest '--', avg = 600/30
  // Idle tick: shown is null -> falls back to the absolute average (600/30 = 20), NOT '--'.
  const lossIdle = await runAsync(process.execPath, ['bin/glm-statusline.js'], {
    input: JSON.stringify({ session_id: lossSession, transcript_path: lossTranscript, cost: { total_api_duration_ms: 30000 } }),
    env: baseEnv(speedConfig, lossCache),
  });
  assert.strictEqual(lossIdle.status, 0, lossIdle.stderr);
  assert.match(lossIdle.stdout, /Speed 20 t\/s · Avg 20 t\/s/);
  assert.doesNotMatch(lossIdle.stdout, /Speed -- t\/s/);

  // 9. Atomic cache write: no temp file leaks after a write, and the cache is valid JSON.
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
    env: baseEnv(speedConfig, atomicCache),
  });
  assert.strictEqual(atomicRun.status, 0, atomicRun.stderr);
  const leakedTemps = fs.readdirSync(atomicDir).filter((f) => f.startsWith('cache.json.tmp.'));
  assert.strictEqual(leakedTemps.length, 0, `temp file leaked: ${leakedTemps.join(', ')}`);
  JSON.parse(fs.readFileSync(atomicCache, 'utf8')); // throws if the cache isn't valid JSON

  // 10. Dedup: one assistant message spanning 3 content-block lines (thinking/text/tool_use), each
  //     carrying the full message.usage, must count its output_tokens ONCE (1000), not 3x (3000).
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
    env: baseEnv(speedConfig, dedupCache),
  });
  assert.strictEqual(dedupRun.status, 0, dedupRun.stderr);
  // Avg = outputTokens / (apiMs/1000). Deduped outputTokens=1000 -> Avg 100. Over-counted would be 300.
  assert.match(dedupRun.stdout, /Avg 100 t\/s/);
  assert.doesNotMatch(dedupRun.stdout, /Avg 300 t\/s/);
}

async function verifyGroupedLayout({ tempDir }) {
  // 1. All fields + grouped layout -> exactly 3 category lines (model / session / quota).
  const groupedConfigFile = path.join(tempDir, 'grouped-layout-config.json');
  fs.writeFileSync(
    groupedConfigFile,
    JSON.stringify(
      {
        display: ['plan', '5h', 'mcp', 'context', 'effort', 'session', 'model', 'day', '30d', 'speed'],
        layout: 'grouped',
      },
      null,
      2
    )
  );
  const groupedCache = path.join(tempDir, 'grouped-layout-cache.json');
  fs.writeFileSync(groupedCache, '{}');
  const grouped = await runAsync(process.execPath, ['bin/glm-statusline.js'], {
    input: JSON.stringify({
      model: { display_name: 'Sonnet' },
      effort: { level: 'high' },
      context_window: { used_percentage: 12, context_window_size: 200000 },
    }),
    env: baseEnv(groupedConfigFile, groupedCache),
  });
  assert.strictEqual(grouped.status, 0, grouped.stderr);
  const groupedLines = grouped.stdout.trim().split('\n');
  assert.strictEqual(groupedLines.length, 3, `expected 3 grouped lines, got:\n${grouped.stdout}`);
  assert.match(groupedLines[0], /^Model .+ │ Effort high │ Speed/);
  assert.match(groupedLines[1], /^Context .+ │ Session 0 │ Day 0 │ 30D 0$/);
  assert.match(groupedLines[2], /^GLM │ 5H .+ @--:-- │ MCP .+ @--$/);

  // 2. In grouped mode, speed shares its row (model / effort / speed), no dedicated trailing line.
  const speedConfig = path.join(tempDir, 'grouped-speed-config.json');
  fs.writeFileSync(speedConfig, JSON.stringify({ display: ['model', 'speed'], layout: 'grouped' }, null, 2));
  const speedCache = path.join(tempDir, 'grouped-speed-cache.json');
  fs.writeFileSync(speedCache, '{}');
  const speedTranscript = path.join(tempDir, 'grouped-speed-transcript.jsonl');
  const speedSession = 'grouped-speed-session';
  const writeSpeed = (outTokens, isoTs) => {
    fs.writeFileSync(
      speedTranscript,
      `${JSON.stringify({
        timestamp: isoTs,
        message: { usage: { input_tokens: 1000, output_tokens: outTokens } },
      })}\n`
    );
  };
  writeSpeed(400, new Date().toISOString());
  await runAsync(process.execPath, ['bin/glm-statusline.js'], {
    input: JSON.stringify({
      model: { display_name: 'Sonnet' },
      session_id: speedSession,
      transcript_path: speedTranscript,
      cost: { total_api_duration_ms: 4000 },
    }),
    env: baseEnv(speedConfig, speedCache),
  });
  writeSpeed(800, new Date().toISOString());
  const speedStatus = await runAsync(process.execPath, ['bin/glm-statusline.js'], {
    input: JSON.stringify({
      model: { display_name: 'Sonnet' },
      session_id: speedSession,
      transcript_path: speedTranscript,
      cost: { total_api_duration_ms: 8000 },
    }),
    env: baseEnv(speedConfig, speedCache),
  });
  assert.strictEqual(speedStatus.status, 0, speedStatus.stderr);
  const speedLines = speedStatus.stdout.trim().split('\n');
  assert.strictEqual(
    speedLines.length,
    1,
    `speed should share the model row in grouped mode, got:\n${speedStatus.stdout}`
  );
  assert.match(speedLines[0], /^Model .*Speed \d+ t\/s · Avg/);
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
  await verifyGroupedLayout(context);
  console.log('All plugin verification checks passed.');
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
