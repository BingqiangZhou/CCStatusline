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
  assert.strictEqual(plugin.version, '1.2.0');

  const marketplace = readJson('.claude-plugin/marketplace.json');
  assert.strictEqual(marketplace.name, 'bingqiangzhou-tools');
  assert.ok(marketplace.plugins.some((entry) => entry.name === 'glm-statusline' && entry.source === './'));
  assert.strictEqual(marketplace.version, '1.2.0');
  assert.ok(marketplace.plugins.some((entry) => entry.name === 'glm-statusline' && entry.version === '1.2.0'));

  const packageJson = readJson('package.json');
  assert.strictEqual(packageJson.version, '1.2.0');

  assertFile('bin/glm-statusline.js');
  assertFile('bin/glm-statusline-install.js');
  assertFile('skills/configure/SKILL.md');
  assertFile('skills/install/SKILL.md');
  assertFile('skills/plan-details/SKILL.md');
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
  assert.match(status.stdout, /5H/);
  assert.match(status.stdout, /Context/);
  assert.match(status.stdout, /Session 0/);
  assert.doesNotMatch(status.stdout, /Sess:/);
  assert.doesNotMatch(status.stdout, /Day:/);
  assert.doesNotMatch(status.stdout, /30D:/);
  assert.strictEqual(status.stdout.trim().split('\n').length, 1);

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'glm-statusline-plugin-'));
  const transcriptFile = path.join(tempDir, 'transcript.jsonl');
  const cacheFile = path.join(tempDir, 'glm-statusline-cache.json');
  const configFile = path.join(tempDir, 'glm-statusline-config.json');
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
              {
                type: 'TOKENS_LIMIT',
                percentage: 10,
                currentValue: 2_000,
                usage: 20_000,
                nextResetTime: new Date(2026, 5, 4, 18, 30, 0).getTime(),
              },
              { type: 'TIME_LIMIT', percentage: 20, currentValue: 3, usage: 30 },
              {
                type: 'WEEKLY_LIMIT',
                percentage: 30,
                currentValue: 300_000,
                usage: 1_000_000,
                nextResetTime: new Date(2026, 5, 8, 9, 0, 0).getTime(),
              },
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
        GLM_STATUSLINE_CACHE_TTL_MS: '60000',
      },
    });
    assert.strictEqual(apiUsage.status, 0, apiUsage.stderr);
    assert.match(apiUsage.stdout, /^5H .+ 10% @18:30 │ Context .+ 1% │ Session 2K\s*$/);
    assert.doesNotMatch(apiUsage.stdout, /Sess:/);
    assert.doesNotMatch(apiUsage.stdout, /Day:/);
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
    assert.match(details.stdout, /MCP: 20% · 3 \/ 30/);
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
          layout: 'full',
          barWidth: 4,
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
      },
    });
    assert.strictEqual(configuredStatus.status, 0, configuredStatus.stderr);
    assert.match(configuredStatus.stdout, /^GLM Test │ 5H .+ 10% @18:30 │ MCP .+ 20% │ Day 3K │ 30D 5\.98B\s*$/);
    assert.doesNotMatch(configuredStatus.stdout, /Context/);
    assert.doesNotMatch(configuredStatus.stdout, /Session/);

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
      },
    });
    assert.strictEqual(preview.status, 0, preview.stderr);
    assert.match(preview.stdout, /^Preview:\nGLM Test │ 5H .+ 10% @18:30 │ MCP .+ 20% │ Day 3K │ 30D 5\.98B\s*$/);
  } finally {
    await close(server);
  }

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

  const configure = run(
    process.execPath,
    [
      'bin/glm-statusline-install.js',
      'configure',
      '--show=plan,5h,mcp,context',
      '--bar-width=4',
      '--layout=full',
    ],
    {
      env: {
        GLM_STATUSLINE_CONFIG_FILE: installConfigFile,
        GLM_STATUSLINE_CACHE_FILE: path.join(tempDir, 'configure-cache.json'),
        ANTHROPIC_AUTH_TOKEN: '',
        ANTHROPIC_BASE_URL: '',
        GLM_STATUSLINE_PLAN: 'GLM Lite',
      },
    }
  );
  assert.strictEqual(configure.status, 0, configure.stderr);
  assert.match(configure.stdout, /GLM StatusLine config written/);
  assert.match(configure.stdout, /Preview:\nGLM Lite │ 5H/);
  assert.match(configure.stdout, /MCP/);
  assert.match(configure.stdout, /Context/);
  const savedConfig = JSON.parse(fs.readFileSync(installConfigFile, 'utf8'));
  assert.deepStrictEqual(savedConfig.display, ['plan', '5h', 'mcp', 'context']);
  assert.strictEqual(savedConfig.barWidth, 4);
  assert.strictEqual(savedConfig.layout, 'full');

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
  assert.match(launcherStatus.stdout, /^5H .+ @--:-- │ Context .+ 12% │ Session 0\s*$/);

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
