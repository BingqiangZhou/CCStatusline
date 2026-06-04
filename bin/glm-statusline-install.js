#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const PLUGIN_ROOT = path.resolve(__dirname, '..');
const LAUNCHER = path.join(PLUGIN_ROOT, 'bin', 'glm-statusline.js');
const SETTINGS_FILE =
  process.env.GLM_STATUSLINE_SETTINGS_FILE || path.join(os.homedir(), '.claude', 'settings.json');
const STABLE_LAUNCHER_FILE =
  process.env.GLM_STATUSLINE_LAUNCHER_FILE || path.join(os.homedir(), '.claude', 'glm-statusline-launcher.js');
const MANAGED_MARKER = 'glm-statusline.js';
const LAUNCHER_MARKER = 'glm-statusline-launcher.js';
const MARKETPLACE_NAME = 'bingqiangzhou-tools';
const PLUGIN_NAME = 'glm-statusline';

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function statusLineCommand() {
  return `${shellQuote(process.execPath)} ${shellQuote(STABLE_LAUNCHER_FILE)}`;
}

function readSettings() {
  if (!fs.existsSync(SETTINGS_FILE)) return {};
  try {
    const raw = fs.readFileSync(SETTINGS_FILE, 'utf8').trim();
    return raw ? JSON.parse(raw) : {};
  } catch (err) {
    throw new Error(`Cannot parse ${SETTINGS_FILE}: ${err.message}`);
  }
}

function writeSettings(settings) {
  fs.mkdirSync(path.dirname(SETTINGS_FILE), { recursive: true });
  fs.writeFileSync(SETTINGS_FILE, `${JSON.stringify(settings, null, 2)}\n`);
}

function backupSettings() {
  if (!fs.existsSync(SETTINGS_FILE)) return '';
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupPath = `${SETTINGS_FILE}.glm-statusline-plugin.bak.${stamp}`;
  fs.copyFileSync(SETTINGS_FILE, backupPath);
  return backupPath;
}

function writeStableLauncher() {
  const cacheRoot = path.join(os.homedir(), '.claude', 'plugins', 'cache', MARKETPLACE_NAME, PLUGIN_NAME);
  const script = `#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const CACHE_ROOT = ${JSON.stringify(cacheRoot)};
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

  fs.mkdirSync(path.dirname(STABLE_LAUNCHER_FILE), { recursive: true });
  fs.writeFileSync(STABLE_LAUNCHER_FILE, script, { mode: 0o755 });
}

function install() {
  if (!fs.existsSync(LAUNCHER)) {
    throw new Error(`Status line launcher not found: ${LAUNCHER}`);
  }
  writeStableLauncher();

  const settings = readSettings();
  const previous = settings.statusLine;
  const alreadyInstalled =
    previous &&
    previous.type === 'command' &&
    typeof previous.command === 'string' &&
    (previous.command.includes(MANAGED_MARKER) || previous.command.includes(LAUNCHER_MARKER));

  const backupPath = alreadyInstalled ? '' : backupSettings();
  settings.statusLine = {
    type: 'command',
    command: statusLineCommand(),
    refreshInterval: 5,
    padding: 0,
  };
  writeSettings(settings);

  console.log(`GLM StatusLine enabled in ${SETTINGS_FILE}`);
  if (backupPath) console.log(`Backup written to ${backupPath}`);
  console.log(`Command: ${settings.statusLine.command}`);
  console.log(`Launcher: ${STABLE_LAUNCHER_FILE}`);
}

function uninstall(force = false) {
  const settings = readSettings();
  const current = settings.statusLine;
  const isManaged =
    current &&
    current.type === 'command' &&
    typeof current.command === 'string' &&
    (current.command.includes(MANAGED_MARKER) || current.command.includes(LAUNCHER_MARKER));

  if (!isManaged && !force) {
    console.log('GLM StatusLine is not the active statusLine. Nothing changed.');
    return;
  }

  const backupPath = backupSettings();
  delete settings.statusLine;
  writeSettings(settings);
  try {
    fs.unlinkSync(STABLE_LAUNCHER_FILE);
  } catch (_) {
    // Ignore missing launcher.
  }
  console.log(`GLM StatusLine disabled in ${SETTINGS_FILE}`);
  if (backupPath) console.log(`Backup written to ${backupPath}`);
}

function printUsage() {
  console.log(`Usage:
  glm-statusline-install.js install
  glm-statusline-install.js uninstall [--force]
  glm-statusline-install.js print-command

Environment:
  GLM_STATUSLINE_SETTINGS_FILE  Override the settings file for tests or project-local installs.
  GLM_STATUSLINE_LAUNCHER_FILE  Override the stable launcher file for tests.
`);
}

function main() {
  const [command = 'install', ...args] = process.argv.slice(2);
  if (command === 'install' || command === 'enable') {
    install();
    return;
  }
  if (command === 'uninstall' || command === 'disable' || command === 'remove') {
    uninstall(args.includes('--force'));
    return;
  }
  if (command === 'print-command') {
    console.log(statusLineCommand());
    return;
  }
  if (command === '--help' || command === '-h' || command === 'help') {
    printUsage();
    return;
  }
  throw new Error(`Unknown command: ${command}`);
}

try {
  main();
} catch (err) {
  console.error(err.message || String(err));
  process.exitCode = 1;
}
