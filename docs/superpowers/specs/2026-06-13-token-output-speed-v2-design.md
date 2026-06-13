# Token Output Speed v2 (current + average, separate line) — Design

- **Date:** 2026-06-13
- **Status:** Approved
- **Builds on:** `docs/superpowers/specs/2026-06-13-token-output-speed-design.md` (the v1 `speed` field, shipped in 1.2.12).
- **Branch:** `feat/speed-current-average`

## Goal

Improve the `speed` segment based on real-use feedback:
1. Show **average** output speed alongside the current speed.
2. Stop the value from **abruptly dropping to 0** when the model isn't actively generating.
3. Render both on a **dedicated line** separate from the other status fields.

## Confirmed decisions (from brainstorming)

- **Idle behavior:** hold the last measured current value indefinitely; `--` only before the first measurement. The value `0` never appears.
- **Average basis:** session average — cumulative `output_tokens ÷ cumulative cost.total_api_duration_ms`.
- **Line format:** `Speed <cur> t/s · Avg <avg> t/s`, always on its own trailing line.

## Data (per render, unchanged sources)

- `outputTokens` (cumulative) + `lastLineMs` from `readJsonlOutputStats(filePath)` (one pass over the transcript JSONL — already exists).
- `apiMs = cost.total_api_duration_ms` from the stdin session JSON.

## Average speed (new)

Computed fresh each render (no caching needed — it's a pure total ÷ total):

```
average = outputTokens / (apiMs / 1000)        // tok/s, when apiMs > 0
average = null                                  // -> rendered as '--' when apiMs absent/0
```

`--` only when `cost.total_api_duration_ms` is absent or 0 (old Claude Code versions). On the very first tick it is already computable (e.g. 200 tokens ÷ 10s API = `Avg 20 t/s`).

## Current speed (behavior change)

Replace `resolveOutputSpeed` with `resolveSpeed(...) → { current, average }` that reads the transcript **once** and `cost` once, and returns both values.

Current-speed logic (baseline cache entry `speed:<sessionId>` = `{ out, apiMs, lineMs, ts, shown }`, unchanged shape):

1. **No baseline yet** (first tick for the session): seed `{ out: outputTokens, apiMs, lineMs, ts: now, shown: null }`, prune, save. `current = null` → `--`.
2. **Active tick** (`dOut = outputTokens - prev.out > 0`):
   - Denominator (seconds), priority: `(apiMs - prev.apiMs)/1000` → `(lastLineMs - prev.lineMs)/1000` → `(now - prev.ts)/1000`.
   - Clamp denominator to `SPEED_MIN_DENOM_S` (0.1).
   - `current = dOut / denomSeconds`. Update baseline `{ out, apiMs, lineMs, ts: now, shown: current }`, prune, save.
3. **Idle tick** (`dOut == 0`):
   - If `prev.shown` is not a number (seeded but never measured): `current = null` → `--`.
   - Else: `current = prev.shown` (**hold last value**). Do NOT rewrite the cache (baseline stays intact so the next active tick computes correctly).

Net: `current` is `--` until the first real delta, then holds the last measured generation speed across idle. **`0` never appears.**

### Removed
- `SPEED_IDLE_DECAY_MS` constant and all decay-to-0 logic.
- Keep `SPEED_MIN_DENOM_S` (denominator floor) and `SPEED_CACHE_TTL_MS` (pruning).

## Rendering — dedicated line

In `renderStatusLine`:

- Build the **non-speed** segments: `config.display.filter((f) => f !== 'speed').map((f) => fields[f])`. (Remove `speed` from the `fields` map — it is no longer a normal `│ `-joined segment.)
- `mainLines = wrapSegments(nonSpeedSegments, maxWidth)` (unchanged behavior; `''` when empty).
- If `speed` is in `config.display`:
  - `{ current, average } = resolveSpeed(sessionContext, transcriptPath, config)` (early-return `{current:null,average:null}` when `speed` not in display — cost gate, same as v1).
  - `speedLine = 'Speed ' + formatSpeed(current) + ' t/s · Avg ' + formatSpeed(average) + ' t/s'`.
  - `output = mainLines ? mainLines + '\n' + speedLine : speedLine` (no leading blank line when speed is the only field).
- Else: `output = mainLines`.

`formatSpeed` (unchanged) maps `null` → `--`, `<1000` → rounded int, `<1M` → `1.2K`, else `1.3M`. The ` · ` separator matches `--plan-details`.

## Edge cases & invariants (preserved)

- **Never crash Claude Code.** All transcript/cache/cost reads are try/catch-guarded; `main().catch(...)` fallback unchanged.
- **Never coerce unknown to 0.** `--` for both current (pre-measurement) and average (no apiMs). `0` is gone entirely.
- **Cost gate.** `resolveSpeed` early-returns `{current:null,average:null}` when `speed` not in display — no transcript pass beyond what `session` already needs, no cache writes.
- **Cache hygiene.** `speed:<sessionId>` pruned by `pruneSpeedCache` (24h TTL); no collision with other keys; `saveCache` swallows write errors.
- **Speed-only config** → single line, no leading newline. **Speed + others** → others wrap normally, speed on its own trailing line.

## Out of scope

- Folding the pre-existing session↔speed double transcript read into one pass (noted by the v1 reviewer; available as a separate follow-up).
- Adding speed/avg to `--plan-details` (quota-centric view; unchanged).
- Rolling-window average (rejected in brainstorming — session average chosen).
- Slow-decay or any synthetic current value (rejected — hold-last chosen).
