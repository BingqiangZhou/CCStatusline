'use strict';

const BAR_WIDTH = 8;

// Partial block characters: 0/8 through 8/8 fill levels
// ░=empty ▏=1/8 ▎=2/8 ▍=3/8 ▌=4/8 ▋=5/8 ▊=6/8 ▉=7/8 █=full
// With BAR_WIDTH=8 and 8 sub-levels per cell → 64 total steps, ~1.56% per step
const BLOCK_LEVELS = ['░', '▏', '▎', '▍', '▌', '▋', '▊', '▉', '█'];
const BLOCK_CHAR_SET = new Set(BLOCK_LEVELS);

function displayLength(value) {
  let width = 0;
  for (const char of Array.from(String(value || ''))) {
    if (BLOCK_CHAR_SET.has(char)) {
      width += 2;
    } else if (/[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︐-︙︰-﹯＀-｠￠-￦]/u.test(char)) {
      width += 2;
    } else {
      width += 1;
    }
  }
  return width;
}

function wrapSegments(segments, maxWidth) {
  if (!Number.isFinite(maxWidth) || maxWidth <= 0) return segments.join(' │ ');

  const lines = [];
  let current = '';
  for (const segment of segments) {
    const next = current ? `${current} │ ${segment}` : segment;
    if (current && displayLength(next) > maxWidth) {
      lines.push(current);
      current = segment;
    } else {
      current = next;
    }
  }
  if (current) lines.push(current);
  return lines.join('\n');
}

function parseResetTime(value) {
  if (value instanceof Date && Number.isFinite(value.getTime())) return value.getTime();

  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return value < 10_000_000_000 ? value * 1000 : value;
  }

  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return null;
    const numeric = Number(trimmed);
    if (Number.isFinite(numeric) && numeric > 0) {
      return numeric < 10_000_000_000 ? numeric * 1000 : numeric;
    }
    const normalized = trimmed.includes('T') ? trimmed : trimmed.replace(' ', 'T');
    const parsed = Date.parse(normalized);
    if (Number.isFinite(parsed)) return parsed;
  }

  return null;
}

function clampPercent(value) {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, Math.round(value)));
}

function renderBar(percent, width = BAR_WIDTH) {
  const p = clampPercent(percent);
  // 8 sub-levels per cell gives totalSteps = width * 8
  // With BAR_WIDTH=8 that's 64 steps, ~1.56% per step
  const totalSteps = width * 8;
  const filledSteps = Math.max(0, Math.min(totalSteps, Math.ceil((p / 100) * totalSteps)));

  const fullBlocks = Math.floor(filledSteps / 8);
  const remainder = filledSteps % 8;

  let bar = '';
  for (let i = 0; i < width; i++) {
    if (i < fullBlocks) {
      bar += '█'; // full block
    } else if (i === fullBlocks && remainder > 0) {
      bar += BLOCK_LEVELS[remainder]; // partial fill
    } else {
      bar += '░'; // empty
    }
  }

  return `${bar} ${p}%`;
}

function formatTokens(value) {
  const n = Number(value) || 0;
  if (n >= 1_000_000_000) return `${trimLargeNumber(n / 1_000_000_000)}B`;
  if (n >= 1_000_000) return `${trimNumber(n / 1_000_000)}M`;
  if (n >= 1_000) return `${trimNumber(n / 1_000)}K`;
  return String(Math.round(n));
}

function trimLargeNumber(value) {
  const rounded = value < 10 ? value.toFixed(2) : value < 100 ? value.toFixed(1) : value.toFixed(0);
  return rounded.replace(/\.0+$/, '').replace(/(\.\d*[1-9])0+$/, '$1');
}

function trimNumber(value) {
  const rounded = value >= 100 ? value.toFixed(0) : value.toFixed(1);
  return rounded.replace(/\.0$/, '');
}

function formatLocalDateTime(ms) {
  if (!Number.isFinite(ms)) return '--';
  const date = new Date(ms);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(
    date.getDate()
  ).padStart(2, '0')} ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(
    2,
    '0'
  )}`;
}

function formatTimeHHmm(ms) {
  const value = ms instanceof Date ? ms.getTime() : Number(ms);
  if (!Number.isFinite(value)) return '--:--';
  const date = new Date(value);
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

function formatResetHHmm(timestamp) {
  const ms = parseResetTime(timestamp);
  if (ms === null) return '--:--';
  return formatTimeHHmm(ms);
}

function formatAge(ms) {
  if (!Number.isFinite(ms) || ms < 0) return 'unknown';
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  return `${hours}h ago`;
}

module.exports = {
  clampPercent,
  displayLength,
  formatAge,
  formatLocalDateTime,
  formatResetHHmm,
  formatTimeHHmm,
  formatTokens,
  parseResetTime,
  renderBar,
  wrapSegments,
};
