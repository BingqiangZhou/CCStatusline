#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const PLUGIN_ROOT = path.resolve(__dirname, '..');
const LAUNCHER = path.join(PLUGIN_ROOT, 'bin', 'glm-statusline.js');
const SETTINGS_FILE =
  process.env.GLM_STATUSLINE_SETTINGS_FILE || path.join(os.homedir(), '.claude', 'settings.json');
const STABLE_LAUNCHER_FILE =
  process.env.GLM_STATUSLINE_LAUNCHER_FILE || path.join(os.homedir(), '.claude', 'glm-statusline-launcher.js');
const CONFIG_FILE =
  process.env.GLM_STATUSLINE_CONFIG_FILE || path.join(os.homedir(), '.claude', 'glm-statusline-config.json');
const MANAGED_MARKER = 'glm-statusline.js';
const LAUNCHER_MARKER = 'glm-statusline-launcher.js';
const MARKETPLACE_NAME = 'bingqiangzhou-tools';
const PLUGIN_NAME = 'glm-statusline';
const PLUGIN_CACHE_ROOT =
  process.env.GLM_STATUSLINE_PLUGIN_CACHE_ROOT ||
  path.join(os.homedir(), '.claude', 'plugins', 'cache', MARKETPLACE_NAME, PLUGIN_NAME);
const DISPLAY_ALIASES = {
  plan: 'plan',
  package: 'plan',
  quota: '5h',
  '5h': '5h',
  fivehour: '5h',
  five_hour: '5h',
  mcp: 'mcp',
  tool: 'mcp',
  tools: 'mcp',
  context: 'context',
  ctx: 'context',
  model: 'model',
  session: 'session',
  sess: 'session',
  day: 'day',
  today: 'day',
  '30d': '30d',
  month: '30d',
  monthly: '30d',
};

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

function readJsonFile(filePath) {
  try {
    if (!filePath || !fs.existsSync(filePath)) return {};
    const raw = fs.readFileSync(filePath, 'utf8').trim();
    return raw ? JSON.parse(raw) : {};
  } catch (err) {
    throw new Error(`Cannot parse ${filePath}: ${err.message}`);
  }
}

function normalizeDisplayItem(item) {
  const key = String(item || '').trim().toLowerCase().replace(/[\s-]+/g, '_');
  return DISPLAY_ALIASES[key] || '';
}

function normalizeDisplayList(value) {
  const raw = Array.isArray(value) ? value : typeof value === 'string' ? value.split(',') : [];
  const display = [];
  const seen = new Set();
  for (const item of raw) {
    const normalized = normalizeDisplayItem(item);
    if (normalized && !seen.has(normalized)) {
      seen.add(normalized);
      display.push(normalized);
    }
  }
  return display;
}

function parseConfigureArgs(args) {
  const options = {};
  for (const arg of args) {
    if (arg.startsWith('--show=')) options.display = normalizeDisplayList(arg.slice('--show='.length));
    else if (arg.startsWith('--display=')) options.display = normalizeDisplayList(arg.slice('--display='.length));
    else if (arg.startsWith('--layout=')) options.layout = arg.slice('--layout='.length).trim().toLowerCase();
    else if (arg.startsWith('--bar-width=')) options.barWidth = Number(arg.slice('--bar-width='.length));
    else if (arg.startsWith('--barWidth=')) options.barWidth = Number(arg.slice('--barWidth='.length));
  }
  if (options.display && !options.display.length) {
    throw new Error('No valid fields in --show. Use any of: plan,5h,mcp,context,model,session,day,30d');
  }
  if (options.layout && !['compact', 'full'].includes(options.layout)) {
    throw new Error('Invalid --layout. Use compact or full.');
  }
  if (options.barWidth !== undefined && (!Number.isFinite(options.barWidth) || options.barWidth < 1 || options.barWidth > 20)) {
    throw new Error('Invalid --bar-width. Use a number from 1 to 20.');
  }
  return options;
}

function writeConfig(config) {
  fs.mkdirSync(path.dirname(CONFIG_FILE), { recursive: true });
  fs.writeFileSync(CONFIG_FILE, `${JSON.stringify(config, null, 2)}\n`);
}

function backupSettings() {
  if (!fs.existsSync(SETTINGS_FILE)) return '';
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupPath = `${SETTINGS_FILE}.glm-statusline-plugin.bak.${stamp}`;
  fs.copyFileSync(SETTINGS_FILE, backupPath);
  return backupPath;
}

function writeStableLauncher() {
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

  fs.mkdirSync(path.dirname(STABLE_LAUNCHER_FILE), { recursive: true });
  fs.writeFileSync(STABLE_LAUNCHER_FILE, script, { mode: 0o755 });
}

function renderPreview() {
  const result = spawnSync(process.execPath, [LAUNCHER, '--preview'], {
    cwd: PLUGIN_ROOT,
    input: JSON.stringify({
      model: { display_name: 'Sonnet' },
      context_window: { used_percentage: 0, context_window_size: 200000 },
      transcript_path: '',
    }),
    env: { ...process.env, GLM_STATUSLINE_CONFIG_FILE: CONFIG_FILE },
    encoding: 'utf8',
  });
  if (result.error) return `Preview unavailable: ${result.error.message}`;
  if (result.status !== 0 && result.stderr) return `Preview unavailable: ${result.stderr.trim()}`;
  return result.stdout.trim();
}

function configure(args = []) {
  const options = parseConfigureArgs(args);
  const previous = readJsonFile(CONFIG_FILE);
  const next = { ...previous };
  if (options.display) next.display = options.display;
  if (options.layout) next.layout = options.layout;
  if (options.barWidth !== undefined) next.barWidth = Math.round(options.barWidth);
  if (!next.display) next.display = ['5h', 'context', 'session'];
  if (!next.layout) next.layout = 'compact';
  if (!next.barWidth) next.barWidth = 8;

  writeConfig(next);
  console.log(`GLM StatusLine config written to ${CONFIG_FILE}`);
  console.log(renderPreview());
}

function install(args = []) {
  if (!fs.existsSync(LAUNCHER)) {
    throw new Error(`Status line launcher not found: ${LAUNCHER}`);
  }
  if (args.some((arg) => /^--(show|display|layout|bar-width|barWidth)=/.test(arg))) {
    configure(args);
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
  if (!args.some((arg) => /^--(show|display|layout|bar-width|barWidth)=/.test(arg))) {
    console.log(renderPreview());
  }
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
  glm-statusline-install.js install --show=5h,context,session --layout=compact --bar-width=8
  glm-statusline-install.js configure --show=plan,5h,mcp,context,session,day,30d
  glm-statusline-install.js uninstall [--force]
  glm-statusline-install.js print-command

Environment:
  GLM_STATUSLINE_SETTINGS_FILE  Override the settings file for tests or project-local installs.
  GLM_STATUSLINE_LAUNCHER_FILE  Override the stable launcher file for tests.
  GLM_STATUSLINE_CONFIG_FILE    Override the display config file.
`);
}

function main() {
  const [command = 'install', ...args] = process.argv.slice(2);
  if (command === 'install' || command === 'enable') {
    install(args);
    return;
  }
  if (command === 'configure' || command === 'config') {
    configure(args);
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
