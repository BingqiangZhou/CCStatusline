# Token Output Speed Field — Design

- **Date:** 2026-06-13
- **Status:** Approved (pending spec review)
- **Field key:** `speed`
- **Display format:** `Speed 95 t/s` (e.g. `Speed 1.2K t/s`, `Speed --`, `Speed 0 t/s`)
- **Default display:** Opt-in only (added to `DISPLAY_FIELDS` + configure selector; **not** in `DEFAULT_DISPLAY`)

## Goal

Add an opt-in status-line segment showing the current GLM/Z.ai **output speed** in tokens per second (tokens/sec), so the user can see roughly how fast the model is producing tokens — analogous to the `tok/s` readout in LM Studio / Ollama.

## Background & research findings

No popular Claude Code statusline plugin (`ccstatusline`, `ccusage`, `claude-code-usage-bar`, "Super Simple Statusline") computes tokens/sec today — they all surface usage/cost/quota, never throughput. Claude Code does **not** stream per-token timing to status-line scripts, so throughput must be **derived** from two signals that are already available:

1. **`cost.total_api_duration_ms`** in the stdin session JSON — cumulative milliseconds the API spent responding. Present in current Claude Code versions (listed in [issue #11535](https://github.com/anthropics/claude-code/issues/11535)). This is the key signal: it is **real API time** (generation + small overhead), and it **excludes idle/thinking time** between renders.
2. **`output_tokens` per line in the transcript JSONL** (already read by this plugin via `tokenTotalFromUsage`), each with a completion `timestamp`.

The status line runs as a fresh Node process every ~5s and on events, so per-render state has no memory. State is persisted between renders in the cache file — the same pattern the plugin already uses for the context-flicker fix (`context:<sessionId>` entries).

## Measurement algorithm

### Why not the naive approaches

- **Per-refresh delta (output delta ÷ render wall-clock):** over-reports. Idle time between renders inflates the denominator, so a turn that completes looks faster than it really was.
- **Transcript-timestamp span only:** usable fallback, but each timestamp is message-completion time; across multiple turns completing between renders it spans inter-turn gaps.
- **`cost.total_api_duration_ms` delta:** best denominator — it is the actual API response time consumed, which for long streaming outputs is dominated by generation time. Conservative direction: TTFT/overhead makes it slightly large, so reported speed slightly **under-reports** peak generation throughput (the honest way to err).

### Data collection

A new helper `readJsonlOutputStats(filePath)` does **one pass** over the transcript JSONL (mirrors the existing `readJsonlTokenStats` read loop) and returns:

```js
{ outputTokens: <number>, lastLineMs: <number|null> }
```

- `outputTokens` = sum of `output_tokens` / `outputTokens` across all lines (reuses `tokenTotalFromUsage`-style extraction but **output keys only**).
- `lastLineMs` = the timestamp of the most recent line (via the existing `lineTimestamp`).

`renderStatusLine` reads `apiDurationMs = Number(sessionContext?.cost?.total_api_duration_ms)` (may be `NaN`/absent on older versions).

### Per-session cached sample

Cache key `speed:<sessionId>`, value:

```js
{ out: <number>, apiMs: <number|null>, lineMs: <number|null>, ts: <number>, shown: <number|null> }
```

- `out` — cumulative `outputTokens` at last sample
- `apiMs` — `cost.total_api_duration_ms` at last sample (or `null` if absent)
- `lineMs` — transcript last-line timestamp at last sample (fallback denominator source)
- `ts` — `Date.now()` of the sample (wall-clock, used **only** for idle/staleness, never as the speed denominator)
- `shown` — last computed speed (tok/s), shown until refreshed or decayed

### Resolution each render

Given `currentOut`, `currentApiMs`, `currentLineMs`, and the cached previous sample:

1. **No previous sample** (first tick for this session, or cache cleared): seed the cache with the current values, render `Speed --`. (Honors the *never coerce unknown to 0* invariant.)
2. **`dOut = currentOut - prev.out > 0`** (new output this interval):
   - Denominator seconds, in priority order:
     1. `(currentApiMs - prev.apiMs) / 1000` when both finite and `> 0`.
     2. else `(currentLineMs - prev.lineMs) / 1000` when both finite and `> 0`.
     3. else `(Date.now() - prev.ts) / 1000` (last-resort wall-clock; rare).
   - Guard against absurd spikes: clamp the denominator to a minimum floor (e.g. `0.1s`) so a tiny `ΔapiMs` can't produce a multimillion tok/s spike from integer/truncation noise.
   - `speed = dOut / denomSeconds`. Update cache `{ out, apiMs, lineMs, ts: now, shown: speed }`. Render `Speed <formatSpeed(speed)> t/s`.
3. **`dOut == 0`** (idle — no new output since last sample):
   - Keep `prev.shown` for display, **but** if `(Date.now() - prev.ts) > SPEED_IDLE_DECAY_MS` (default `30000`), render `Speed 0 t/s` instead (clearly idle) and keep the cached sample (so when generation resumes we still have a valid `prev` baseline). Do **not** rewrite `shown` to 0 in the cache — we want the next active tick to compute from the real baseline.

**Note on cache writes:** only the `speed` field participates; entries are pruned after `SPEED_CACHE_TTL_MS` (default 24h, same as context). Cache write errors are swallowed (status line must never break Claude Code — preserved invariant).

### Session isolation

Keyed by `session_id` (fallback `sessionId`). A `/clear` starts a fresh `session_id` with no cached sample → first render shows `Speed --`, exactly as desired.

## Field integration (touch points)

Per CLAUDE.md "Adding a display field" recipe:

1. **`lib/display-fields.js`**
   - Add `'speed'` to `DISPLAY_FIELDS` (positioned after `'session'` → `[…, 'session', 'speed', 'day', '30d']`, grouping live-session metrics together).
   - Add `speed: 'output speed'` to `FIELD_LABELS`.
   - `DEFAULT_DISPLAY` unchanged (opt-in).
2. **`glm-statusline.js`**
   - Add `readJsonlOutputStats(filePath)`.
   - Add `resolveOutputSpeed(sessionContext, config)` mirroring `resolveContextPercent`'s read-hold-write pattern.
   - Add the `speed` entry to the `fields` map: ``speed: `Speed ${formatSpeed(shown)} t/s` `` (always carries the `t/s` unit; `formatSpeed(null)` returns `'--'` so the no-data case reads `Speed -- t/s`).
   - Wire it into `renderStatusLine` (only compute when `config.display.includes('speed')`, mirroring the `needsDay` cost gate — reading the transcript is already done for `session`, so reuse the pass).
3. **`README.md`**
   - Add `speed` row to the field table under "### 1. Claude Code 状态栏".
   - Add `speed` bullet to the "### 5. 选择显示字段并预览" list.
4. **`scripts/verify.js`** — new `verifyTokenOutputSpeed` scenario (see Testing).
5. **`bin/glm-statusline-install.js`** — **no change**: the configure selector iterates `FIELD_ORDER`/`FIELD_LABELS` and auto-includes `speed`.

## Formatting

`formatSpeed(value)` in `glm-statusline.js` (small local helper; not promoted to `lib/statusline-format.js` since it's single-use):

- `value == null` → `'--'`
- `< 1000` → rounded integer, e.g. `95`
- `>= 1000` → one decimal + `K`, e.g. `1.2K`, `12.5K`
- `>= 1_000_000` → one decimal + `M`, e.g. `1.3M` (extreme edge; keeps width bounded)

The segment is width-counted correctly by the existing `wrapSegments`/`displayLength` (plain ASCII), so wrapping still respects terminal width.

## Edge cases & invariants

- **Never crash Claude Code.** All transcript/cache/cost reads are try/catch-guarded; `main().catch(...)` already prints a fallback.
- **Never coerce unknown to 0.** First tick / missing `cost` / no transcript → `Speed --`, not `Speed 0`.
- **Idle decay** → eventually `Speed 0 t/s` after 30s of no new output, without poisoning the cached baseline.
- **Denominator clamp** (≥0.1s) prevents truncation spikes.
- **Missing `cost.total_api_duration_ms`** (older CC versions) → transparent fallback to transcript-timestamp span, then wall-clock.
- **`speed` not in display list** → no transcript re-read beyond what `session` already needs, no cache writes (cost gate, like `needsDay`).

## Testing plan (`scripts/verify.js`)

Add `verifyTokenOutputSpeed({ tempDir })`:

1. Write a transcript fixture with cumulative `output_tokens` and timestamps.
2. **First render** with an empty cache + `display: ['speed']` → asserts `Speed --`, and that the cache is seeded.
3. **Second render** after appending output and bumping `cost.total_api_duration_ms` by a known delta → asserts a `Speed <N> t/s` value matching `dOut / (dApiMs/1000)` (e.g. `Δout=500`, `ΔapiMs=5000` → `100 t/s`).
4. **Idle render** (`dOut=0`, recent `ts`) → asserts the last `shown` is held.
5. **Idle decay** (`ts` older than `SPEED_IDLE_DECAY_MS`) → asserts `Speed 0 t/s`.
6. **Missing `cost`** → asserts the transcript-timestamp-span fallback path produces a sane number.
7. Confirm cache isolation env vars (`GLM_STATUSLINE_CACHE_FILE`, `…_CONFIG_FILE`) are used and that the existing version-triple / README assertions still pass.

`npm test` is the gate.

## Out of scope

- A sparkline / historical throughput graph (single number only).
- Distinguishing input vs cache-read vs output rates (output only, per the request).
- Adding `speed` to `--plan-details` (that view is quota-centric; can revisit later).
- Live in-flight streaming rate (not measurable from message-completion data).
