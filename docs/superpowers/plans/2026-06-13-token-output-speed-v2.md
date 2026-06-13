# Token Output Speed v2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Upgrade the `speed` segment to show current **and** session-average throughput on a dedicated line, and stop the value from dropping to 0 when idle (hold the last reading instead).

**Architecture:** Replace `resolveOutputSpeed` (returns `number|null`) with `resolveSpeed` (returns `{ current, average }`) that reads the transcript + `cost` once and computes both values. `average = outputTokens / (apiMs/1000)` is pure total÷total (no cache). `current` drops the 30s decay — idle now holds `prev.shown` indefinitely (`0` never appears). `renderStatusLine` splits `speed` out of the normal `│ `-joined segments and appends `Speed <cur> t/s · Avg <avg> t/s` on its own trailing line.

**Tech Stack:** Node.js 18+ standard library only; `scripts/verify.js` (`assert`-based, spawns real `bin/`) is the gate (`npm test`).

**Spec:** `docs/superpowers/specs/2026-06-13-token-output-speed-v2-design.md`

---

## File Structure

- **Modify** `glm-statusline.js` — drop `SPEED_IDLE_DECAY_MS`; replace `resolveOutputSpeed` with `resolveSpeed`; rewire `renderStatusLine` (drop `speed` from the `fields` map, build non-speed segments, append the speed line).
- **Modify** `scripts/verify.js` — rewrite `verifyTokenOutputSpeed` for the new behavior (average, hold-on-idle, separate line).
- **Modify** `README.md` — update the `speed` field-table row and the section-5 bullet.
- **No change** `lib/display-fields.js` (`speed` stays registered; selector unchanged).

---

## Task 1: Rewrite the failing integration test

**Files:**
- Modify: `scripts/verify.js` (replace the whole `verifyTokenOutputSpeed` function)

- [ ] **Step 1: Replace `verifyTokenOutputSpeed` with the v2 version**

Find the entire existing `verifyTokenOutputSpeed` function (from `async function verifyTokenOutputSpeed({ tempDir }) {` through its closing `}`) and replace it with:

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

  // 1. First render seeds the baseline. current = --; average = 200 / (10000/1000) = 20 tok/s.
  fs.writeFileSync(speedCache, '{}');
  writeTranscript(200, new Date(Date.now() - 60000).toISOString());
  const first = await runAsync(process.execPath, ['bin/glm-statusline.js'], {
    input: JSON.stringify({ session_id: sessionId, transcript_path: speedTranscript, cost: { total_api_duration_ms: 10000 } }),
    env: baseEnv(speedConfig, speedCache),
  });
  assert.strictEqual(first.status, 0, first.stderr);
  assert.match(first.stdout, /Speed -- t\/s · Avg 20 t\/s/);
  assert.strictEqual(first.stdout.trim().split('\n').length, 1, 'speed-only config renders a single line');
  const seededCache = JSON.parse(fs.readFileSync(speedCache, 'utf8'));
  assert.ok(seededCache[`speed:${sessionId}`], 'first render should seed the speed baseline');
  assert.strictEqual(seededCache[`speed:${sessionId}`].out, 200);

  // 2. Output grew 500 tokens over 5000ms API time -> current 100; avg = 700/15 ~ 47 tok/s.
  writeTranscript(700, new Date().toISOString());
  const second = await runAsync(process.execPath, ['bin/glm-statusline.js'], {
    input: JSON.stringify({ session_id: sessionId, transcript_path: speedTranscript, cost: { total_api_duration_ms: 15000 } }),
    env: baseEnv(speedConfig, speedCache),
  });
  assert.strictEqual(second.status, 0, second.stderr);
  assert.match(second.stdout, /Speed 100 t\/s · Avg 47 t\/s/);

  // 3. Idle holds the last value even when the baseline ts is long stale (v2: no decay to 0).
  const heldCache = JSON.parse(fs.readFileSync(speedCache, 'utf8'));
  heldCache[`speed:${sessionId}`].ts = Date.now() - 120000;
  fs.writeFileSync(speedCache, JSON.stringify(heldCache));
  const third = await runAsync(process.execPath, ['bin/glm-statusline.js'], {
    input: JSON.stringify({ session_id: sessionId, transcript_path: speedTranscript, cost: { total_api_duration_ms: 15000 } }),
    env: baseEnv(speedConfig, speedCache),
  });
  assert.strictEqual(third.status, 0, third.stderr);
  assert.match(third.stdout, /Speed 100 t\/s/);
  assert.doesNotMatch(third.stdout, /Speed 0 t\/s/);

  // 4. Missing cost.total_api_duration_ms -> average is --, current falls back to transcript span.
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
    input: JSON.stringify({ session_id: fallbackSession, transcript_path: fallbackTranscript }),
    env: baseEnv(speedConfig, fallbackCache),
  });
  writeFallback(900, new Date().toISOString());
  const fallbackSecond = await runAsync(process.execPath, ['bin/glm-statusline.js'], {
    input: JSON.stringify({ session_id: fallbackSession, transcript_path: fallbackTranscript }),
    env: baseEnv(speedConfig, fallbackCache),
  });
  assert.strictEqual(fallbackSecond.status, 0, fallbackSecond.stderr);
  assert.match(fallbackSecond.stdout, /Speed \d+ t\/s · Avg -- t\/s/);

  // 5. Speed shares the status line with another field: speed sits on its own trailing line.
  const mixedConfig = path.join(tempDir, 'speed-mixed-config.json');
  fs.writeFileSync(mixedConfig, JSON.stringify({ display: ['session', 'speed'] }, null, 2));
  const mixedCache = path.join(tempDir, 'speed-mixed-cache.json');
  fs.writeFileSync(mixedCache, '{}');
  const mixedTranscript = path.join(tempDir, 'speed-mixed-transcript.jsonl');
  const mixedSession = 'speed-mixed-session';
  const writeMixed = (outTokens, isoTs) => {
    fs.writeFileSync(
      mixedTranscript,
      `${JSON.stringify({
        timestamp: isoTs,
        message: { usage: { input_tokens: 1000, output_tokens: outTokens } },
      })}\n`
    );
  };
  writeMixed(400, new Date().toISOString());
  await runAsync(process.execPath, ['bin/glm-statusline.js'], {
    input: JSON.stringify({ session_id: mixedSession, transcript_path: mixedTranscript, cost: { total_api_duration_ms: 4000 } }),
    env: baseEnv(mixedConfig, mixedCache),
  });
  writeMixed(800, new Date().toISOString());
  const mixed = await runAsync(process.execPath, ['bin/glm-statusline.js'], {
    input: JSON.stringify({ session_id: mixedSession, transcript_path: mixedTranscript, cost: { total_api_duration_ms: 8000 } }),
    env: baseEnv(mixedConfig, mixedCache),
  });
  assert.strictEqual(mixed.status, 0, mixed.stderr);
  const mixedLines = mixed.stdout.trim().split('\n');
  assert.strictEqual(mixedLines.length, 2, 'speed sits on its own line below the main fields');
  assert.match(mixedLines[0], /Session/);
  assert.doesNotMatch(mixedLines[0], /Speed/);
  assert.match(mixedLines[1], /^Speed \d+ t\/s · Avg \d+ t\/s$/);
}
```

The existing `await verifyTokenOutputSpeed(context);` call in `main()` stays — do not touch `main()`.

- [ ] **Step 2: Run the test and confirm it FAILS (red)**

Run: `npm test`
Expected: FAIL. The shipped v1 code renders `Speed -- t/s` (no `· Avg …`), so the `/Speed -- t\/s · Avg 20 t\/s/` assertion throws. This is the expected red state. Do not commit yet.

---

## Task 2: Implement speed v2

**Files:**
- Modify: `glm-statusline.js`

- [ ] **Step 1: Drop the `SPEED_IDLE_DECAY_MS` constant**

Find this block:
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
Replace with:
```js
// Output-speed tuning. The status line is a fresh process each render, so speed is derived from a
// per-session cached baseline (see resolveSpeed). When idle the last measured value is held (it
// never decays to 0); SPEED_MIN_DENOM_S floors the denominator so a tiny ΔapiMs can't produce a
// multimillion tok/s spike.
const SPEED_MIN_DENOM_S = 0.1;
// How long a per-session speed baseline is held in the cache.
const SPEED_CACHE_TTL_MS = Number(
  process.env.GLM_STATUSLINE_SPEED_CACHE_TTL_MS || 24 * 60 * 60 * 1000
);
```

- [ ] **Step 2: Replace `resolveOutputSpeed` with `resolveSpeed`**

Find the entire `function resolveOutputSpeed(sessionContext, transcriptPath, config) { … }` (it ends with the idle branch returning `0`) and replace it with:

```js
// Resolve the output speed for the session: { current, average } in tokens/sec (null each ->
// rendered as '--'). Only runs when 'speed' is displayed (cost gate). Never coerces unknown to 0.
//
// current: derived from the delta of cumulative transcript output_tokens over the delta of
//   cost.total_api_duration_ms (real API time, which excludes idle between renders — idle can't
//   inflate the denominator). Falls back to the transcript-timestamp span, then wall-clock. The
//   per-session baseline persists in the cache (same read-hold-write pattern as
//   resolveContextPercent). On idle the last measured value is HELD (never decays to 0); it is
//   null only before the first real measurement.
//
// average: cumulative output_tokens ÷ cumulative cost.total_api_duration_ms (session throughput).
//   Computed fresh each render, no caching. null when cost is absent/0.
function resolveSpeed(sessionContext, transcriptPath, config) {
  if (!config?.display?.includes('speed')) return { current: null, average: null };

  const sessionId = String(sessionContext?.session_id || sessionContext?.sessionId || '');
  const { outputTokens, lastLineMs } = readJsonlOutputStats(transcriptPath);
  const apiMsRaw = Number(sessionContext?.cost?.total_api_duration_ms);
  const apiMs = Number.isFinite(apiMsRaw) ? apiMsRaw : null;
  const now = Date.now();

  const average = apiMs !== null && apiMs > 0 ? outputTokens / (apiMs / 1000) : null;

  const cache = loadCache();
  const key = `speed:${sessionId}`;
  const prev = cache[key];

  // First tick for this session: seed the baseline, no current yet -> Speed -- t/s.
  if (!prev || typeof prev.out !== 'number') {
    cache[key] = { out: outputTokens, apiMs, lineMs: lastLineMs, ts: now, shown: null };
    pruneSpeedCache(cache);
    saveCache(cache);
    return { current: null, average };
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
    const current = dOut / denomSeconds;
    cache[key] = { out: outputTokens, apiMs, lineMs: lastLineMs, ts: now, shown: current };
    pruneSpeedCache(cache);
    saveCache(cache);
    return { current, average };
  }

  // Idle (no new output). Hold the last measured value; seeded-but-never-measured stays at --.
  // Do NOT rewrite the cache — the baseline must stay intact so the next active tick computes
  // from it. `0` is never returned.
  const current = typeof prev.shown === 'number' ? prev.shown : null;
  return { current, average };
}
```

- [ ] **Step 3: Call `resolveSpeed` instead of `resolveOutputSpeed`**

In `renderStatusLine`, find:
```js
  const speed = resolveOutputSpeed(sessionContext, transcriptPath, config);
```
Replace with:
```js
  const speedStats = resolveSpeed(sessionContext, transcriptPath, config);
```

- [ ] **Step 4: Remove `speed` from the `fields` map**

In the `fields` object inside `renderStatusLine`, find and delete this line:
```js
    speed: `Speed ${formatSpeed(speed)} t/s`,
```
(The `speed` segment is no longer a normal `│ `-joined field — it is rendered as its own line in Step 5.)

- [ ] **Step 5: Render speed on its own trailing line**

In `renderStatusLine`, find:
```js
  const segments = config.display.map((item) => fields[item]).filter(Boolean);
  return wrapSegments(segments.length ? segments : DEFAULT_DISPLAY.map((item) => fields[item]), config.maxWidth);
```
Replace with:
```js
  const showSpeed = config.display.includes('speed');
  const mainSegments = config.display
    .filter((item) => item !== 'speed')
    .map((item) => fields[item])
    .filter(Boolean);
  // Fall back to DEFAULT_DISPLAY only when there's truly nothing else to show AND speed is off.
  // (A user who selected only 'speed' gets just the speed line — no forced default fields.)
  const effectiveMain =
    mainSegments.length || showSpeed ? mainSegments : DEFAULT_DISPLAY.map((item) => fields[item]);
  const mainLines = wrapSegments(effectiveMain, config.maxWidth);
  if (!showSpeed) return mainLines;

  const speedLine = `Speed ${formatSpeed(speedStats.current)} t/s · Avg ${formatSpeed(speedStats.average)} t/s`;
  return mainLines ? `${mainLines}\n${speedLine}` : speedLine;
```

- [ ] **Step 6: Run the full suite and confirm PASS (green)**

Run: `npm test`
Expected: `All plugin verification checks passed.` If anything fails, fix YOUR implementation (do not weaken the test).

- [ ] **Step 7: Commit**

```bash
git add glm-statusline.js scripts/verify.js
git commit -m "$(cat <<'EOF'
feat(speed): add session average, hold value on idle, dedicated line

Speed segment now shows `Speed <cur> t/s · Avg <avg> t/s` on its own
trailing line. Average is cumulative output ÷ cumulative API duration.
Idle no longer decays to 0 — the last measured current value is held
(`--` only before the first measurement).

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: Update the README

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Update the `speed` field-table row**

Find:
```markdown
| `speed` | 当前输出速度（tokens/sec，输出 token 增量 ÷ API 耗时增量；首次显示 `--`，空闲 30s 后归零；opt-in，默认不显示） |
```
Replace with:
```markdown
| `speed` | 输出速度，独占一行：`Speed <当前> t/s · Avg <会话均值> t/s`。当前速度 = 输出 token 增量 ÷ API 耗时增量，空闲时保持上次读数（不归零，首次为 `--`）；平均速度 = 会话累计输出 ÷ 累计 API 耗时。opt-in，默认不显示 |
```

- [ ] **Step 2: Update the section-5 bullet**

Find:
```markdown
- `speed`：当前输出速度（tokens/sec）。
```
Replace with:
```markdown
- `speed`：输出速度（当前 + 会话平均 tokens/sec），独占一行。
```

- [ ] **Step 3: Run the suite (README is asserted) and confirm PASS**

Run: `npm test`
Expected: `All plugin verification checks passed.`

- [ ] **Step 4: Commit**

```bash
git add README.md
git commit -m "$(cat <<'EOF'
docs: update speed field for current+average and dedicated line

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: Manual smoke verification

**Files:** none (verification only)

- [ ] **Step 1: Confirm two renders end-to-end**

Run:
```bash
tmp=$(mktemp -d)
cfg="$tmp/cfg.json"; echo '{"display":["speed"]}' > "$cfg"
cache="$tmp/c.json"; t="$tmp/t.jsonl"
echo "{\"timestamp\":\"$(date -u -v-1M +%Y-%m-%dT%H:%M:%SZ)\",\"message\":{\"usage\":{\"input_tokens\":1000,\"output_tokens\":400}}}" > "$t"
echo -n "render 1: "
echo '{"session_id":"smoke","cost":{"total_api_duration_ms":4000},"transcript_path":"'"$t"'"}' \
  | GLM_STATUSLINE_CONFIG_FILE="$cfg" GLM_STATUSLINE_CACHE_FILE="$cache" ANTHROPIC_AUTH_TOKEN='' ANTHROPIC_BASE_URL='' node bin/glm-statusline.js
echo "{\"timestamp\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\",\"message\":{\"usage\":{\"input_tokens\":1000,\"output_tokens\":800}}}" > "$t"
echo -n "render 2: "
echo '{"session_id":"smoke","cost":{"total_api_duration_ms":8000},"transcript_path":"'"$t"'"}' \
  | GLM_STATUSLINE_CONFIG_FILE="$cfg" GLM_STATUSLINE_CACHE_FILE="$cache" ANTHROPIC_AUTH_TOKEN='' ANTHROPIC_BASE_URL='' node bin/glm-statusline.js
rm -rf "$tmp"
```
Expected: render 1 prints a single line `Speed -- t/s · Avg 100 t/s`; render 2 prints `Speed 100 t/s · Avg 100 t/s`.

- [ ] **Step 2: Confirm speed shares the line correctly with another field**

Run:
```bash
tmp=$(mktemp -d)
cfg="$tmp/cfg.json"; echo '{"display":["session","speed"]}' > "$cfg"
cache="$tmp/c.json"; t="$tmp/t.jsonl"
echo "{\"timestamp\":\"$(date -u -v-1M +%Y-%m-%dT%H:%M:%SZ)\",\"message\":{\"usage\":{\"input_tokens\":1000,\"output_tokens\":400}}}" > "$t"
echo '{"session_id":"smoke2","cost":{"total_api_duration_ms":4000},"transcript_path":"'"$t"'"}' \
  | GLM_STATUSLINE_CONFIG_FILE="$cfg" GLM_STATUSLINE_CACHE_FILE="$cache" ANTHROPIC_AUTH_TOKEN='' ANTHROPIC_BASE_URL='' node bin/glm-statusline.js
echo "{\"timestamp\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\",\"message\":{\"usage\":{\"input_tokens\":1000,\"output_tokens\":800}}}" > "$t"
echo '{"session_id":"smoke2","cost":{"total_api_duration_ms":8000},"transcript_path":"'"$t"'"}' \
  | GLM_STATUSLINE_CONFIG_FILE="$cfg" GLM_STATUSLINE_CACHE_FILE="$cache" ANTHROPIC_AUTH_TOKEN='' ANTHROPIC_BASE_URL='' node bin/glm-statusline.js | cat -A
rm -rf "$tmp"
```
Expected (render 2): two lines — `Session …` on line 1, `Speed 100 t/s · Avg 100 t/s` on line 2 (`cat -A` shows the line break as `$`).

---

## Self-Review (completed during authoring)

- **Spec coverage:** average formula (Task 2.2) ✓; hold-last / no-0 / `--` only pre-measurement (Task 2.2 idle branch) ✓; drop `SPEED_IDLE_DECAY_MS` (Task 2.1) ✓; dedicated trailing line + speed-only single line + no leading blank (Task 2.5) ✓; cost gate early-return (Task 2.2) ✓; cache hygiene/prune unchanged (`pruneSpeedCache`, `SPEED_CACHE_TTL_MS` retained) ✓; one transcript read (avg reuses `readJsonlOutputStats` already called for current) ✓; tests rewritten (Task 1) ✓; README (Task 3) ✓.
- **Placeholder scan:** none — every code step contains complete code.
- **Type/name consistency:** `resolveSpeed` → `{ current, average }` used identically in Task 2.2 (definition), Task 2.3 (`speedStats`), Task 2.5 (`speedStats.current` / `speedStats.average`). Cache entry shape `{ out, apiMs, lineMs, ts, shown }` unchanged from v1. `formatSpeed`, `readJsonlOutputStats`, `pruneSpeedCache`, `wrapSegments`, `loadCache`/`saveCache` are pre-existing and unchanged.
- **No regressions:** `speed` stays in `DISPLAY_FIELDS` (selector unaffected); default config has no `speed` so default output, wrap tests, and configure-numbering assertions are untouched. Only `verifyTokenOutputSpeed` changes.
