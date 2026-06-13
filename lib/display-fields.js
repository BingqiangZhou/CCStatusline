'use strict';

const DEFAULT_DISPLAY = ['5h', 'mcp', 'session', 'day'];
const DISPLAY_FIELDS = ['plan', '5h', 'mcp', 'context', 'model', 'effort', 'session', 'speed', 'day', '30d'];
const FIELD_LABELS = {
  plan: 'plan',
  '5h': '5h quota',
  mcp: 'mcp/tools',
  context: 'context',
  model: 'model',
  effort: 'effort level',
  session: 'session tokens',
  speed: 'output speed',
  day: 'day tokens',
  '30d': '30d tokens',
};

function normalizeDisplayList(value) {
  const raw = Array.isArray(value) ? value : [];
  const seen = new Set();
  const display = [];
  for (const item of raw) {
    const normalized = DISPLAY_FIELDS.includes(item) ? item : '';
    if (normalized && !seen.has(normalized)) {
      seen.add(normalized);
      display.push(normalized);
    }
  }
  return display;
}

function orderDisplay(display) {
  const selected = new Set(display);
  return DISPLAY_FIELDS.filter((field) => selected.has(field));
}

module.exports = {
  DEFAULT_DISPLAY,
  DISPLAY_FIELDS,
  FIELD_LABELS,
  normalizeDisplayList,
  orderDisplay,
};
