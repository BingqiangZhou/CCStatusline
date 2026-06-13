#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const readline = require('readline');
const { spawnSync } = require('child_process');
const {
  DEFAULT_DISPLAY,
  DISPLAY_FIELDS: FIELD_ORDER,
  FIELD_LABELS,
  normalizeDisplayList,
  orderDisplay,
} = require('../lib/display-fields');

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

function writeConfig(config) {
  fs.mkdirSync(path.dirname(CONFIG_FILE), { recursive: true });
  fs.writeFileSync(CONFIG_FILE, `${JSON.stringify(config, null, 2)}\n`);
}

function baseConfigFromFile() {
  const previous = readJsonFile(CONFIG_FILE);
  const display = normalizeDisplayList(previous.display);
  return {
    display: display.length ? display : [...DEFAULT_DISPLAY],
    layout: previous.layout === 'grouped' ? 'grouped' : 'single',
  };
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
      effort: { level: 'high' },
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

function printInteractiveState(config) {
  const selected = new Set(config.display);
  const isGrouped = config.layout === 'grouped';
  console.log('');
  console.log('Select fields to show. Type a number to toggle it, q to finish.');
  FIELD_ORDER.forEach((field, index) => {
    console.log(`${index + 1}. [${selected.has(field) ? 'x' : ' '}] ${FIELD_LABELS[field]}`);
  });
  console.log('');
  console.log(`Layout — press 'l' to switch to ${isGrouped ? 'single' : 'grouped'}:`);
  console.log(`  [${isGrouped ? ' ' : 'x'}] single   all fields on one line (wraps to terminal width)`);
  console.log(
    `  [${isGrouped ? 'x' : ' '}] grouped  split into 3 rows: plan, 5h, mcp  /  context, session, day, 30d  /  model, effort, speed`
  );
  console.log(renderPreview());
}

function saveInteractiveConfig(config) {
  writeConfig(config);
  console.log(`GLM StatusLine config written to ${CONFIG_FILE}`);
  console.log(renderPreview());
}

function printInstallNextSteps() {
  console.log('');
  console.log('Next step: run /glm-statusline:configure to choose which fields are shown.');
  console.log('Each selection saves immediately and prints a fresh preview.');
}

function toggleField(config, input) {
  const index = Number(String(input).trim()) - 1;
  if (!Number.isInteger(index) || index < 0 || index >= FIELD_ORDER.length) {
    console.log(`Ignored input: ${input}`);
    return config;
  }

  const field = FIELD_ORDER[index];
  const display = [...config.display];
  const existingIndex = display.indexOf(field);
  if (existingIndex >= 0) {
    if (display.length === 1) {
      console.log('At least one field must stay selected.');
      return config;
    }
    display.splice(existingIndex, 1);
  } else {
    display.push(field);
  }
  return { ...config, display: orderDisplay(display) };
}

async function interactiveConfigure() {
  let config = baseConfigFromFile();
  writeConfig(config);
  printInteractiveState(config);

  const handleInput = (line) => {
    const value = String(line || '').trim().toLowerCase();
    if (!value || value === 'q' || value === 'quit' || value === 'done') return false;
    if (value === 'l') {
      config = { ...config, layout: config.layout === 'grouped' ? 'single' : 'grouped' };
      writeConfig(config);
      printInteractiveState(config);
      return true;
    }
    config = toggleField(config, value);
    writeConfig(config);
    printInteractiveState(config);
    return true;
  };

  if (!process.stdin.isTTY) {
    const input = fs.readFileSync(0, 'utf8');
    for (const line of input.split(/\r?\n/)) {
      if (!handleInput(line)) break;
    }
    return;
  }

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: 'Choose field number, l = layout, q to finish: ',
  });
  rl.prompt();
  for await (const line of rl) {
    if (!handleInput(line)) break;
    rl.prompt();
  }
  rl.close();
}

async function configure(args = []) {
  if (args.length) {
    throw new Error('Use the interactive selector: glm-statusline-install.js configure');
  }
  await interactiveConfigure();
}

async function install(args = []) {
  if (!fs.existsSync(LAUNCHER)) {
    throw new Error(`Status line launcher not found: ${LAUNCHER}`);
  }
  if (args.length) {
    throw new Error('Install does not take display arguments. Run /glm-statusline:configure after install.');
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
  console.log(renderPreview());
  printInstallNextSteps();
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
  glm-statusline-install.js configure
  glm-statusline-install.js uninstall [--force]
  glm-statusline-install.js print-command

Environment:
  GLM_STATUSLINE_SETTINGS_FILE  Override the settings file for tests or project-local installs.
  GLM_STATUSLINE_LAUNCHER_FILE  Override the stable launcher file for tests.
  GLM_STATUSLINE_CONFIG_FILE    Override the display config file.
`);
}

async function main() {
  const [command = 'install', ...args] = process.argv.slice(2);
  if (command === 'install' || command === 'enable') {
    await install(args);
    return;
  }
  if (command === 'configure' || command === 'config') {
    await configure(args);
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
  main().catch((err) => {
    console.error(err.message || String(err));
    process.exitCode = 1;
  });
} catch (err) {
  console.error(err.message || String(err));
  process.exitCode = 1;
}
