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

// Category groups for the opt-in grouped layout (config.layout === 'grouped').
// Order of groups = on-screen line order. Within a group, DISPLAY_FIELDS canonical order is used.
// Every DISPLAY_FIELDS key belongs to exactly one group. `id` is an internal label only.
const FIELD_GROUPS = [
  { id: 'row1', fields: ['model', 'effort', 'speed'] },
  { id: 'row2', fields: ['context', 'session', 'day', '30d'] },
  { id: 'row3', fields: ['plan', '5h', 'mcp'] },
];

// Partition a selected field list into per-group field-key arrays (canonical order within group).
// Groups with no selected fields yield an empty array, which the caller skips.
function groupDisplay(display) {
  const selected = new Set(display);
  return FIELD_GROUPS.map((group) => {
    const inGroup = new Set(group.fields);
    return DISPLAY_FIELDS.filter((field) => inGroup.has(field) && selected.has(field));
  });
}

module.exports = {
  DEFAULT_DISPLAY,
  DISPLAY_FIELDS,
  FIELD_GROUPS,
  FIELD_LABELS,
  groupDisplay,
  normalizeDisplayList,
  orderDisplay,
};
