#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const PLUGIN_ROOT = path.resolve(__dirname, '..');
const LAUNCHER = path.join(PLUGIN_ROOT, 'bin', 'glm-statusline.js');
const SETTINGS_FILE =
  process.env.GLM_STATUSLINE_SETTINGS_FILE || path.join(os.homedir(), '.claude', 'settings.json');
const MANAGED_MARKER = 'glm-statusline.js';

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function statusLineCommand() {
  return `${shellQuote(process.execPath)} ${shellQuote(LAUNCHER)}`;
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

function install() {
  if (!fs.existsSync(LAUNCHER)) {
    throw new Error(`Status line launcher not found: ${LAUNCHER}`);
  }

  const settings = readSettings();
  const previous = settings.statusLine;
  const alreadyInstalled =
    previous &&
    previous.type === 'command' &&
    typeof previous.command === 'string' &&
    previous.command.includes(MANAGED_MARKER);

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
}

function uninstall(force = false) {
  const settings = readSettings();
  const current = settings.statusLine;
  const isManaged =
    current &&
    current.type === 'command' &&
    typeof current.command === 'string' &&
    current.command.includes(MANAGED_MARKER);

  if (!isManaged && !force) {
    console.log('GLM StatusLine is not the active statusLine. Nothing changed.');
    return;
  }

  const backupPath = backupSettings();
  delete settings.statusLine;
  writeSettings(settings);
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
