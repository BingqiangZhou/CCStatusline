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

function close(server) {
  return new Promise((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
}

async function main() {
  const plugin = readJson('.claude-plugin/plugin.json');
  assert.strictEqual(plugin.name, 'glm-statusline');
  assert.match(plugin.description, /GLM/i);
  assert.strictEqual(plugin.version, '1.1.2');

  const marketplace = readJson('.claude-plugin/marketplace.json');
  assert.strictEqual(marketplace.name, 'bingqiangzhou-tools');
  assert.ok(marketplace.plugins.some((entry) => entry.name === 'glm-statusline' && entry.source === './'));
  assert.strictEqual(marketplace.version, '1.1.2');
  assert.ok(marketplace.plugins.some((entry) => entry.name === 'glm-statusline' && entry.version === '1.1.2'));

  const packageJson = readJson('package.json');
  assert.strictEqual(packageJson.version, '1.1.2');

  assertFile('bin/glm-statusline.js');
  assertFile('bin/glm-statusline-install.js');
  assertFile('skills/install/SKILL.md');
  assertFile('skills/uninstall/SKILL.md');
  assertFile('docs/claude-code-plugin-build-guide.md');
  assertFile('docs/claude-code-skills-and-extensions-guide.md');

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

  const status = run(process.execPath, ['bin/glm-statusline.js'], {
    input: JSON.stringify({
      model: { display_name: 'Sonnet' },
      context_window: { used_percentage: 12, context_window_size: 200000 },
      transcript_path: path.join(os.tmpdir(), 'missing-glm-statusline-transcript.jsonl'),
    }),
    env: {
      ANTHROPIC_AUTH_TOKEN: '',
      ANTHROPIC_BASE_URL: '',
      GLM_STATUSLINE_CACHE_TTL_MS: '1',
    },
  });
  assert.strictEqual(status.status, 0, status.stderr);
  assert.match(status.stdout, /GLM/);
  assert.match(status.stdout, /5H/);
  assert.match(status.stdout, /Context/);
  assert.match(status.stdout, /Sess:/);

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'glm-statusline-plugin-'));
  const transcriptFile = path.join(tempDir, 'transcript.jsonl');
  const cacheFile = path.join(tempDir, 'glm-statusline-cache.json');
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

  const requests = [];
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    requests.push(url);
    res.setHeader('Content-Type', 'application/json');

    if (url.pathname === '/api/monitor/usage/quota/limit') {
      res.end(
        JSON.stringify({
          data: {
            planName: 'GLM Test',
            limits: [
              { type: 'TOKENS_LIMIT', percentage: 10, nextResetTime: new Date(2026, 5, 4, 18, 30, 0).getTime() },
              { type: 'TIME_LIMIT', percentage: 20 },
            ],
          },
        })
      );
      return;
    }

    if (url.pathname === '/api/monitor/usage/model-usage') {
      const startTime = url.searchParams.get('startTime') || '';
      const value = /\d{4}-\d{2}-\d{2} 00:00:00/.test(startTime) ? 3000 : 5_983_083_962;
      res.end(
        JSON.stringify({
          data: {
            tokensUsage: [value],
            totalUsage: {
              totalTokensUsage: value,
            },
          },
        })
      );
      return;
    }

    res.statusCode = 404;
    res.end(JSON.stringify({ error: 'not found' }));
  });

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
        GLM_STATUSLINE_CACHE_TTL_MS: '1',
      },
    });
    assert.strictEqual(apiUsage.status, 0, apiUsage.stderr);
    assert.match(apiUsage.stdout, /5H@18:30 ｜ Sess:2K/);
    assert.match(apiUsage.stdout, /Sess:2K/);
    assert.match(apiUsage.stdout, /Day:3K/);
    assert.match(apiUsage.stdout, /30D:5\.98B/);
    assert.strictEqual(requests.filter((url) => url.pathname === '/api/monitor/usage/model-usage').length, 2);
    for (const url of requests.filter((item) => item.pathname === '/api/monitor/usage/model-usage')) {
      assert.match(url.searchParams.get('startTime') || '', /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
      assert.match(url.searchParams.get('endTime') || '', /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    }
    const testCache = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
    assert.ok(Object.keys(testCache).every((key) => key.includes(`http://127.0.0.1:${port}`)));
  } finally {
    await close(server);
  }

  const settingsFile = path.join(tempDir, 'settings.json');
  const launcherFile = path.join(tempDir, 'glm-statusline-launcher.js');
  fs.writeFileSync(settingsFile, JSON.stringify({ env: { GLM_STATUSLINE_PLAN: 'GLM Lite' } }, null, 2));

  const install = run(process.execPath, ['bin/glm-statusline-install.js', 'install'], {
    env: {
      GLM_STATUSLINE_SETTINGS_FILE: settingsFile,
      GLM_STATUSLINE_LAUNCHER_FILE: launcherFile,
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

  const launcherStatus = run(process.execPath, [launcherFile], {
    input: JSON.stringify({
      model: { display_name: 'Sonnet' },
      context_window: { used_percentage: 12, context_window_size: 200000 },
      transcript_path: path.join(os.tmpdir(), 'missing-glm-statusline-transcript.jsonl'),
    }),
    env: {
      ANTHROPIC_AUTH_TOKEN: '',
      ANTHROPIC_BASE_URL: '',
      GLM_STATUSLINE_CACHE_TTL_MS: '1',
    },
  });
  assert.strictEqual(launcherStatus.status, 0, launcherStatus.stderr);
  assert.match(launcherStatus.stdout, /5H@/);

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

  console.log('All plugin verification checks passed.');
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
