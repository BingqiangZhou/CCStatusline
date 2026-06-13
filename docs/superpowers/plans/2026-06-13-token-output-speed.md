# Token Output Speed Field — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an opt-in `speed` status-line segment showing GLM/Z.ai output throughput in tokens/sec, derived from transcript `output_tokens` delta over `cost.total_api_duration_ms` delta.

**Architecture:** The status line is a fresh Node process every ~5s, so speed is computed from a per-session cached baseline (`{ out, apiMs, lineMs, ts, shown }` under `speed:<sessionId>` in the existing cache file) — the same read-hold-write pattern as `resolveContextPercent`. A new `readJsonlOutputStats` does one pass over the transcript to sum `output_tokens` and capture the last-line timestamp. `resolveOutputSpeed` returns a number (tok/s) or `null` (→ `Speed -- t/s`); `formatSpeed` renders the number.

**Tech Stack:** Node.js 18+ standard library only (`fs`, `path`, `os`); the existing `scripts/verify.js` `assert`-based harness is the test gate (`npm test`).

**Spec:** `docs/superpowers/specs/2026-06-13-token-output-speed-design.md`

---

## File Structure

- **Modify** `lib/display-fields.js` — register `speed` in `DISPLAY_FIELDS` (after `session`) and `FIELD_LABELS`. Single responsibility: the canonical field set. Not added to `DEFAULT_DISPLAY` (opt-in).
- **Modify** `glm-statusline.js` — add measurement helpers (`readJsonlOutputStats`, `outputTokensFromUsage`, `outputTokensFromObject`, `formatSpeed`, `pruneSpeedCache`), the resolver `resolveOutputSpeed`, and wire the segment into `renderStatusLine`'s `fields` map.
- **Modify** `scripts/verify.js` — add `verifyTokenOutputSpeed` integration scenario + call it from `main()`.
- **Modify** `README.md` — add `speed` to the two field lists (状态栏 field table + 选择字段 list).
- **No change** `bin/glm-statusline-install.js` — the configure selector iterates `DISPLAY_FIELDS`/`FIELD_LABELS` and auto-includes `speed`.

---

## Task 1: Write the failing integration test

**Files:**
- Modify: `scripts/verify.js` (add `verifyTokenOutputSpeed`; call from `main()`)

- [ ] **Step 1: Add the `verifyTokenOutputSpeed` function**

Insert this function immediately **before** `async function main()` in `scripts/verify.js`:

```js
async function verifyTokenOutputSpeed({ tempDir }) {
  const speedConfig = path.join(tempDir, 'speed-config.json');
  fs.writeFileSync(speedConfig, JSON.stringify({ display: ['speed'] }, null, 2));
  const speedCache = path.join(tempDir, 'speed-cache.json');
  const speedTranscript = path.join(tempDir, 'speed-transcript.jsonl');
  const sessionId = 'speed-session';

  const writeTranscript = (outTokens, isoTs) => {
    fs.writeFileSync(
      speedTranscript,
      `${JSON.stringify({
        timestamp: isoTs,
        message: { usage: { input_tokens: 1000, output_tokens: outTokens } },
      })}\n`
    );
  };

  // 1. First render seeds the baseline; no speed yet -> Speed -- t/s.
  fs.writeFileSync(speedCache, '{}');
  writeTranscript(200, new Date(Date.now() - 60000).toISOString());
  const first = await runAsync(process.execPath, ['bin/glm-statusline.js'], {
    input: JSON.stringify({ session_id: sessionId, cost: { total_api_duration_ms: 10000 } }),
    env: baseEnv(speedConfig, speedCache),
  });
  assert.strictEqual(first.status, 0, first.stderr);
  assert.match(first.stdout, /Speed -- t\/s/);
  const seededCache = JSON.parse(fs.readFileSync(speedCache, 'utf8'));
  assert.ok(seededCache[`speed:${sessionId}`], 'first render should seed the speed baseline');
  assert.strictEqual(seededCache[`speed:${sessionId}`].out, 200);

  // 2. Output grew 500 tokens over 5000ms of API time -> 100 tok/s.
  writeTranscript(700, new Date().toISOString());
  const second = await runAsync(process.execPath, ['bin/glm-statusline.js'], {
    input: JSON.stringify({ session_id: sessionId, cost: { total_api_duration_ms: 15000 } }),
    env: baseEnv(speedConfig, speedCache),
  });
  assert.strictEqual(second.status, 0, second.stderr);
  assert.match(second.stdout, /Speed 100 t\/s/);

  // 3. Idle (no new output), within decay window -> holds last shown value.
  const heldCache = JSON.parse(fs.readFileSync(speedCache, 'utf8'));
  heldCache[`speed:${sessionId}`].ts = Date.now() - 5000;
  fs.writeFileSync(speedCache, JSON.stringify(heldCache));
  const third = await runAsync(process.execPath, ['bin/glm-statusline.js'], {
    input: JSON.stringify({ session_id: sessionId, cost: { total_api_duration_ms: 15000 } }),
    env: baseEnv(speedConfig, speedCache),
  });
  assert.strictEqual(third.status, 0, third.stderr);
  assert.match(third.stdout, /Speed 100 t\/s/);

  // 4. Idle past decay threshold -> Speed 0 t/s.
  const decayedCache = JSON.parse(fs.readFileSync(speedCache, 'utf8'));
  decayedCache[`speed:${sessionId}`].ts = Date.now() - 60000;
  fs.writeFileSync(speedCache, JSON.stringify(decayedCache));
  const fourth = await runAsync(process.execPath, ['bin/glm-statusline.js'], {
    input: JSON.stringify({ session_id: sessionId, cost: { total_api_duration_ms: 15000 } }),
    env: baseEnv(speedConfig, speedCache),
  });
  assert.strictEqual(fourth.status, 0, fourth.stderr);
  assert.match(fourth.stdout, /Speed 0 t\/s/);

  // 5. Missing cost.total_api_duration_ms -> falls back to transcript-timestamp span.
  const fallbackCache = path.join(tempDir, 'speed-fallback-cache.json');
  fs.writeFileSync(fallbackCache, '{}');
  const fallbackTranscript = path.join(tempDir, 'speed-fallback-transcript.jsonl');
  const fallbackSession = 'speed-fallback-session';
  const writeFallback = (outTokens, isoTs) => {
    fs.writeFileSync(
      fallbackTranscript,
      `${JSON.stringify({
        timestamp: isoTs,
        message: { usage: { input_tokens: 500, output_tokens: outTokens } },
      })}\n`
    );
  };
  writeFallback(100, new Date(Date.now() - 10000).toISOString());
  await runAsync(process.execPath, ['bin/glm-statusline.js'], {
    input: JSON.stringify({ session_id: fallbackSession }),
    env: baseEnv(speedConfig, fallbackCache),
  });
  writeFallback(900, new Date().toISOString());
  const fallbackSecond = await runAsync(process.execPath, ['bin/glm-statusline.js'], {
    input: JSON.stringify({ session_id: fallbackSession }),
    env: baseEnv(speedConfig, fallbackCache),
  });
  assert.strictEqual(fallbackSecond.status, 0, fallbackSecond.stderr);
  // dOut=800 over ~10s span -> ~80 tok/s (formatSpeed rounds 80 -> "80").
  assert.match(fallbackSecond.stdout, /Speed \d+ t\/s/);
}
```

- [ ] **Step 2: Wire it into `main()`**

In `main()` of `scripts/verify.js`, add the call after `await verifyEffortAndContextFix(context);`:

```js
  await verifyTokenOutputSpeed(context);
```

- [ ] **Step 3: Run the test and confirm it FAILS (red)**

Run: `npm test`
Expected: FAIL. Because `speed` is not yet in `DISPLAY_FIELDS`, `normalizeDisplayList(['speed'])` returns `[]` → config falls back to `DEFAULT_DISPLAY` → no `Speed` segment renders → the `/Speed -- t\/s/` assertion throws. This is the expected red state.

Do not commit yet.

---

## Task 2: Register the `speed` field

**Files:**
- Modify: `lib/display-fields.js:3-4` and `:5-15`

- [ ] **Step 1: Add `speed` to `DISPLAY_FIELDS` (after `session`)**

In `lib/display-fields.js`, change:

```js
const DISPLAY_FIELDS = ['plan', '5h', 'mcp', 'context', 'model', 'effort', 'session', 'day', '30d'];
```

to:

```js
const DISPLAY_FIELDS = ['plan', '5h', 'mcp', 'context', 'model', 'effort', 'session', 'speed', 'day', '30d'];
```

- [ ] **Step 2: Add the label**

In the `FIELD_LABELS` object, after the `session: 'session tokens',` line, add:

```js
  speed: 'output speed',
```

So the object becomes:

```js
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
```

`DEFAULT_DISPLAY` stays `['5h', 'mcp', 'session', 'day']` (opt-in).

- [ ] **Step 3: Sanity-check normalization keeps `speed`**

Run:
```bash
node -e "const {DISPLAY_FIELDS,normalizeDisplayList}=require('./lib/display-fields'); console.log(DISPLAY_FIELDS.includes('speed'), normalizeDisplayList(['speed','session']))"
```
Expected: `true [ 'speed', 'session' ]`

Do not commit yet.

---

## Task 3: Add the measurement helpers to the orchestrator

**Files:**
- Modify: `glm-statusline.js`

- [ ] **Step 1: Add the tuning constants**

Find the `CONTEXT_CACHE_TTL_MS` constant block (near line 60) and add immediately after it:

```js
// Output-speed tuning. The status line is a fresh process each render, so speed is derived from a
// per-session cached baseline (see resolveOutputSpeed). SPEED_IDLE_DECAY_MS is how long the last
// measured speed is held before the segment decays to 0 when the session is idle.
const SPEED_IDLE_DECAY_MS = Number(process.env.GLM_STATUSLINE_SPEED_IDLE_DECAY_MS || 30_000);
// Floor for the speed denominator so a tiny ΔapiMs can't produce a multimillion tok/s spike.
const SPEED_MIN_DENOM_S = 0.1;
// How long a per-session speed baseline is held in the cache.
const SPEED_CACHE_TTL_MS = Number(
  process.env.GLM_STATUSLINE_SPEED_CACHE_TTL_MS || 24 * 60 * 60 * 1000
);
```

- [ ] **Step 2: Add `outputTokensFromUsage` and `outputTokensFromObject`**

Find `tokenTotalFromObject` (near line 686) and add these two functions immediately **after** `tokenTotalFromObject`:

```js
function outputTokensFromUsage(usage) {
  if (!usage || typeof usage !== 'object') return 0;
  const keys = ['output_tokens', 'outputTokens', 'completion_tokens', 'completionTokens'];
  let total = 0;
  for (const key of keys) {
    const value = Number(usage[key]);
    if (Number.isFinite(value) && value > 0) total += value;
  }
  return total;
}

function outputTokensFromObject(obj) {
  if (!obj || typeof obj !== 'object') return 0;
  let total = 0;
  if (obj.usage && typeof obj.usage === 'object') total += outputTokensFromUsage(obj.usage);
  if (obj.message?.usage && typeof obj.message.usage === 'object') {
    total += outputTokensFromUsage(obj.message.usage);
  }
  if (obj.response?.usage && typeof obj.response.usage === 'object') {
    total += outputTokensFromUsage(obj.response.usage);
  }
  return total;
}
```

- [ ] **Step 3: Add `readJsonlOutputStats`**

Find `readJsonlTokenStats` (near line 701) and add this function immediately **after** it:

```js
// One pass over the transcript JSONL: sum output tokens and capture the most-recent line
// timestamp. Mirrors readJsonlTokenStats but isolates output_tokens (for speed) and returns the
// last-line timestamp (a fallback denominator source when cost.total_api_duration_ms is absent).
function readJsonlOutputStats(filePath) {
  try {
    if (!filePath || !fs.existsSync(filePath)) return { outputTokens: 0, lastLineMs: null };
    const stat = fs.statSync(filePath);
    const content = fs.readFileSync(filePath, 'utf8');
    let outputTokens = 0;
    let lastLineMs = null;
    for (const line of content.split('\n')) {
      if (!line.trim()) continue;
      try {
        const obj = JSON.parse(line);
        const ts = lineTimestamp(obj, stat.mtimeMs);
        outputTokens += outputTokensFromObject(obj);
        if (lastLineMs === null || ts > lastLineMs) lastLineMs = ts;
      } catch (_) {
        // Ignore malformed jsonl lines.
      }
    }
    return { outputTokens, lastLineMs };
  } catch (_) {
    return { outputTokens: 0, lastLineMs: null };
  }
}
```

- [ ] **Step 4: Add `formatSpeed`**

Find `formatLimitLine` (near line 842) and add this function immediately **before** it:

```js
function formatSpeed(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return '--';
  if (n < 1000) return String(Math.round(n));
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}K`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}
```

- [ ] **Step 5: Add `pruneSpeedCache`**

Find `pruneContextCache` (near line 225) and add this function immediately **after** it:

```js
// Drop stale per-session speed baselines so the cache file can't grow unbounded.
function pruneSpeedCache(cache) {
  const now = Date.now();
  for (const key of Object.keys(cache)) {
    if (key.startsWith('speed:') && now - (cache[key]?.ts || 0) > SPEED_CACHE_TTL_MS) {
      delete cache[key];
    }
  }
}
```

- [ ] **Step 6: Add `resolveOutputSpeed`**

Find `resolveContextPercent` (near line 636) and add this function immediately **after** it:

```js
// Resolve the output speed (tokens/sec) to display. Derives speed from the delta of cumulative
// transcript output_tokens over the delta of cost.total_api_duration_ms (real API time, which
// excludes idle between renders — idle can't inflate the denominator). Falls back to the
// transcript-timestamp span, then wall-clock. The per-session baseline persists in the cache
// (same read-hold-write pattern as resolveContextPercent). Only runs when 'speed' is displayed.
// Returns a number (tok/s) or null (rendered as 'Speed -- t/s'). Never coerces unknown to 0.
function resolveOutputSpeed(sessionContext, transcriptPath, config) {
  if (!config?.display?.includes('speed')) return null;

  const sessionId = String(sessionContext?.session_id || sessionContext?.sessionId || '');
  const { outputTokens, lastLineMs } = readJsonlOutputStats(transcriptPath);
  const apiMsRaw = Number(sessionContext?.cost?.total_api_duration_ms);
  const apiMs = Number.isFinite(apiMsRaw) ? apiMsRaw : null;
  const now = Date.now();

  const cache = loadCache();
  const key = `speed:${sessionId}`;
  const prev = cache[key];

  // First tick for this session: seed the baseline, no speed yet -> Speed -- t/s.
  if (!prev || typeof prev.out !== 'number') {
    cache[key] = { out: outputTokens, apiMs, lineMs: lastLineMs, ts: now, shown: null };
    pruneSpeedCache(cache);
    saveCache(cache);
    return null;
  }

  const dOut = outputTokens - prev.out;
  if (dOut > 0) {
    let denomSeconds;
    if (apiMs !== null && typeof prev.apiMs === 'number' && apiMs > prev.apiMs) {
      denomSeconds = (apiMs - prev.apiMs) / 1000;
    } else if (lastLineMs !== null && typeof prev.lineMs === 'number' && lastLineMs > prev.lineMs) {
      denomSeconds = (lastLineMs - prev.lineMs) / 1000;
    } else {
      denomSeconds = (now - prev.ts) / 1000;
    }
    denomSeconds = Math.max(denomSeconds, SPEED_MIN_DENOM_S);
    const speed = dOut / denomSeconds;
    cache[key] = { out: outputTokens, apiMs, lineMs: lastLineMs, ts: now, shown: speed };
    pruneSpeedCache(cache);
    saveCache(cache);
    return speed;
  }

  // Idle (no new output). Seeded-but-never-measured stays honest at Speed -- t/s. Once we have a
  // real reading, hold it, then decay to 0 past the idle threshold. Do NOT rewrite the cache —
  // the baseline (out/apiMs/lineMs/ts) must stay intact so the next active tick computes from it,
  // and `now - prev.ts` must keep measuring time since the last real activity.
  if (typeof prev.shown !== 'number') return null;
  if (now - prev.ts <= SPEED_IDLE_DECAY_MS) return prev.shown;
  return 0;
}
```

Do not commit yet.

---

## Task 4: Wire the segment into rendering

**Files:**
- Modify: `glm-statusline.js` (`renderStatusLine`)

- [ ] **Step 1: Compute the speed in `renderStatusLine`**

In `renderStatusLine`, find:

```js
  const sessionTokens = readJsonlTokenStats(transcriptPath);
```

and add immediately after it:

```js
  const speed = resolveOutputSpeed(sessionContext, transcriptPath, config);
```

- [ ] **Step 2: Add the `speed` segment to the `fields` map**

In the `fields` object inside `renderStatusLine`, find:

```js
    session: `Session ${formatTokens(sessionTokens)}`,
    day: `Day ${formatTokens(dayTokens ?? 0)}`,
```

and insert the `speed` entry between them:

```js
    session: `Session ${formatTokens(sessionTokens)}`,
    speed: `Speed ${formatSpeed(speed)} t/s`,
    day: `Day ${formatTokens(dayTokens ?? 0)}`,
```

- [ ] **Step 3: Run the full suite and confirm it PASSES (green)**

Run: `npm test`
Expected: `All plugin verification checks passed.` (including the new `verifyTokenOutputSpeed`).

- [ ] **Step 4: Commit**

```bash
git add lib/display-fields.js glm-statusline.js scripts/verify.js
git commit -m "$(cat <<'EOF'
feat: add opt-in token output speed status line field

New `speed` segment shows GLM/Z.ai output throughput (tokens/sec),
derived from transcript output_tokens delta over a
cost.total_api_duration_ms delta (real API time, excludes idle),
persisted per-session in the cache like the context-flicker fix.
Falls back to transcript-timestamp span then wall-clock when cost is
absent. First tick shows `Speed --`, idle decays to `Speed 0` after 30s.

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: Document the field in the README

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Add `speed` to the status-bar field table**

In `README.md`, find:

```markdown
| `session` | 当前会话累计 token 数 |
| `day` | 当天 GLM / Z.ai token 用量 |
```

and insert a row between them:

```markdown
| `session` | 当前会话累计 token 数 |
| `speed` | 当前输出速度（tokens/sec，输出 token 增量 ÷ API 耗时增量；首次显示 `--`，空闲 30s 后归零） |
| `day` | 当天 GLM / Z.ai token 用量 |
```

- [ ] **Step 2: Add `speed` to the configure field list**

In `README.md`, find:

```markdown
- `session`：当前会话 token。
- `day`：当天 token。
```

and insert a bullet between them:

```markdown
- `session`：当前会话 token。
- `speed`：当前输出速度（tokens/sec）。
- `day`：当天 token。
```

- [ ] **Step 3: Run the full suite (README content is asserted) and confirm PASS**

Run: `npm test`
Expected: `All plugin verification checks passed.`

- [ ] **Step 4: Commit**

```bash
git add README.md
git commit -m "$(cat <<'EOF'
docs: document the speed status line field

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: Manual smoke verification

**Files:** none (verification only)

- [ ] **Step 1: Confirm the segment renders end-to-end**

Run:
```bash
tmp=$(mktemp -d)
echo "{\"timestamp\":\"$(date -u -v-1M +%Y-%m-%dT%H:%M:%SZ)\",\"message\":{\"usage\":{\"input_tokens\":1000,\"output_tokens\":300}}}" > "$tmp/t.jsonl"
cfg="$tmp/cfg.json"; echo '{"display":["speed","session"]}' > "$cfg"
echo '{"session_id":"smoke","cost":{"total_api_duration_ms":4000},"transcript_path":"'"$tmp/t.jsonl"'"}' \
  | GLM_STATUSLINE_CONFIG_FILE="$cfg" GLM_STATUSLINE_CACHE_FILE="$tmp/c.json" ANTHROPIC_AUTH_TOKEN='' ANTHROPIC_BASE_URL='' node bin/glm-statusline.js
# Second render after growth (dOut=400, dApiMs=4000 -> 100 tok/s):
echo "{\"timestamp\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\",\"message\":{\"usage\":{\"input_tokens\":1000,\"output_tokens\":700}}}" > "$tmp/t.jsonl"
echo '{"session_id":"smoke","cost":{"total_api_duration_ms":8000},"transcript_path":"'"$tmp/t.jsonl"'"}' \
  | GLM_STATUSLINE_CONFIG_FILE="$cfg" GLM_STATUSLINE_CACHE_FILE="$tmp/c.json" ANTHROPIC_AUTH_TOKEN='' ANTHROPIC_BASE_URL='' node bin/glm-statusline.js
```
Expected: first render prints a line containing `Speed -- t/s`; second render prints a line containing `Speed 100 t/s`.

- [ ] **Step 2: Confirm the configure selector lists the new field**

Run:
```bash
echo 'q' | GLM_STATUSLINE_CONFIG_FILE="$(mktemp)" node bin/glm-statusline-install.js configure 2>&1 | grep -i 'output speed'
```
Expected: one matching line (e.g. `N. [ ] output speed`), proving the selector auto-includes `speed`.

---

## Self-Review (completed during authoring)

- **Spec coverage:** field registration (Task 2) ✓; `readJsonlOutputStats` (Task 3.3) ✓; `cost.total_api_duration_ms` primary denominator + transcript-span + wall-clock fallbacks (Task 3.6) ✓; denominator clamp ≥0.1s (Task 3.6) ✓; idle decay 30s without poisoning baseline (Task 3.6) ✓; first-tick `--` (Task 3.6) ✓; cache prune (Task 3.5) ✓; render wiring + `formatSpeed` (Task 4) ✓; README (Task 5) ✓; tests (Task 1) ✓; cost gate (`resolveOutputSpeed` early-returns when `speed` not displayed, so no extra transcript pass beyond `session`) ✓.
- **Placeholder scan:** none — every code step contains complete code.
- **Type/name consistency:** `readJsonlOutputStats`, `outputTokensFromUsage`, `outputTokensFromObject`, `formatSpeed`, `pruneSpeedCache`, `resolveOutputSpeed`, and constants `SPEED_IDLE_DECAY_MS`/`SPEED_MIN_DENOM_S`/`SPEED_CACHE_TTL_MS` are used identically across tasks. The cache entry shape `{ out, apiMs, lineMs, ts, shown }` is consistent between `resolveOutputSpeed` and the test.
- **Existing tests unaffected:** adding `speed` to `DISPLAY_FIELDS` (not `DEFAULT_DISPLAY`) leaves default output and the `interactiveConfigure` numbering assertions intact (`1. [x] plan`, `3. [x] mcp` still hold; the deep-equal `['plan','5h','mcp','session','day']` is unchanged because `speed` is never toggled in that test).
