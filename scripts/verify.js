#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

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

const plugin = readJson('.claude-plugin/plugin.json');
assert.strictEqual(plugin.name, 'glm-statusline');
assert.match(plugin.description, /GLM/i);
assert.match(plugin.version, /^\d+\.\d+\.\d+$/);

const marketplace = readJson('.claude-plugin/marketplace.json');
assert.strictEqual(marketplace.name, 'glm-statusline-marketplace');
assert.ok(marketplace.plugins.some((entry) => entry.name === 'glm-statusline' && entry.source === './'));

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
    GLM_STATUSLINE_USAGE_SOURCE: 'local',
    GLM_STATUSLINE_CACHE_TTL_MS: '1',
  },
});
assert.strictEqual(status.status, 0, status.stderr);
assert.match(status.stdout, /GLM/);
assert.match(status.stdout, /5H/);
assert.match(status.stdout, /Context/);
assert.match(status.stdout, /Sess:/);

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'glm-statusline-plugin-'));
const settingsFile = path.join(tempDir, 'settings.json');
fs.writeFileSync(settingsFile, JSON.stringify({ env: { GLM_STATUSLINE_PLAN: 'GLM Lite' } }, null, 2));

const install = run(process.execPath, ['bin/glm-statusline-install.js', 'install'], {
  env: { GLM_STATUSLINE_SETTINGS_FILE: settingsFile },
});
assert.strictEqual(install.status, 0, install.stderr);
const installedSettings = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
assert.strictEqual(installedSettings.statusLine.type, 'command');
assert.match(installedSettings.statusLine.command, /glm-statusline\.js/);
assert.strictEqual(installedSettings.statusLine.refreshInterval, 5);
assert.strictEqual(installedSettings.statusLine.padding, 0);
assert.strictEqual(installedSettings.env.GLM_STATUSLINE_PLAN, 'GLM Lite');

const uninstall = run(process.execPath, ['bin/glm-statusline-install.js', 'uninstall'], {
  env: { GLM_STATUSLINE_SETTINGS_FILE: settingsFile },
});
assert.strictEqual(uninstall.status, 0, uninstall.stderr);
const uninstalledSettings = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
assert.strictEqual(uninstalledSettings.statusLine, undefined);

console.log('All plugin verification checks passed.');
