# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A Claude Code **status line plugin** ("GLM StatusLine") that shows GLM / Z.ai usage (5H quota, MCP/tools quota, context %, session tokens, day/30D usage, mapped model name, effort level, output speed) in the Claude Code status bar. It is also a learning project: `notes/` holds 11 study notes on the Claude Code plugin system (in Chinese) with this plugin as the worked example, and `docs/` holds two longer-form English guides (`docs/claude-code-plugin-build-guide.md`, `docs/claude-code-skills-and-extensions-guide.md`) plus `docs/superpowers/{plans,specs}/` working artifacts from the output-speed feature.

**Zero dependencies** — Node.js standard library only (`fs`, `path`, `os`, `http`, `https`, `url`, `child_process`, `readline`, `assert`). There is no `npm install` step. Node 18+.

## Commands

```bash
npm test                              # runs scripts/verify.js — the only test harness
npm run statusline                    # runs bin/glm-statusline.js (pipes a session JSON via stdin)
node glm-statusline.js --plan-details # detailed plan view
node glm-statusline.js --preview      # status line with a "Preview:" prefix
node bin/glm-statusline-install.js install|configure|uninstall [--force]|print-command
```

`npm test` is the gate. It has no test framework — it's plain `assert` plus a local Node `http` fixture server (`createFixtureApiServer`) serving `test/fixtures/*.json`. It spawns the real `bin/` scripts as child processes. When debugging, read `scripts/verify.js` directly; each `verify*` function is an isolated scenario you can lift into a scratch script.

To run the status line by hand the way Claude Code does, feed it session JSON on stdin:
```bash
echo '{"model":{"display_name":"Sonnet"},"context_window":{"used_percentage":12,"context_window_size":200000}}' | node bin/glm-statusline.js
```

### Test-isolation env vars (required when scripting runs)
The verifier and any manual testing must point at throwaway files instead of the user's real `~/.claude/*`:
`GLM_STATUSLINE_CONFIG_FILE`, `GLM_STATUSLINE_CACHE_FILE`, `GLM_STATUSLINE_SETTINGS_FILE`, `GLM_STATUSLINE_LAUNCHER_FILE`, `GLM_STATUSLINE_PLUGIN_CACHE_ROOT`. Setting `ANTHROPIC_AUTH_TOKEN=''` + `ANTHROPIC_BASE_URL=''` makes `fetchQuota`/`fetchModelUsage` short-circuit to their fallback values without hitting the network.

## Architecture

Three layers; read top-down.

**1. Entry (`bin/`)**
- `bin/glm-statusline.js` — one-line `require('../glm-statusline.js')`. This is what Claude Code's `statusLine.command` ultimately invokes.
- `bin/glm-statusline-install.js` — install / interactive-configure / uninstall CLI. Backs the four `/glm-statusline:*` skills. Edits `~/.claude/settings.json` (backing it up first) and writes the stable launcher.

**2. Core orchestrator (`glm-statusline.js`, the single-file brain)**
The flow for every status-line render is `renderStatusLine(sessionContext)`:
1. `mergeEnvFromSettings` — merge `env` across three settings layers (`~/.claude/settings.json` → `<cwd>/.claude/settings.json` → `<cwd>/.claude/settings.local.json`), then layer `process.env` on top. This is *why* the status line works regardless of which project directory Claude Code is in.
2. `fetchQuota` (quota/limit API) + conditionally `fetchModelUsage` (day/month token API). Both check the JSON cache (`~/.claude/glm-statusline-cache.json`, default 60 s TTL) before hitting the network. **`model-usage` is only fetched when `day` or `30d` is in the display list** (`needsDay`/`needsMonth`) — a deliberate cost gate.
3. Build a `fields` map. If `config.layout === 'grouped'`, partition the selected fields via `groupDisplay` and render each category row through `wrapSegments`; otherwise pass the selected segments to `wrapSegments` (single line), with `speed` (if shown) pulled out and appended as its own trailing line.

**3. Shared library (`lib/`)**
- `lib/display-fields.js` — the canonical field set, order, labels, and config normalization. `DISPLAY_FIELDS` (`['plan','5h','mcp','context','model','effort','session','speed','day','30d']`) is the single source of truth for ordering; `DEFAULT_DISPLAY` is `['5h','mcp','session','day']`. `FIELD_GROUPS` + `groupDisplay()` (same file) define the opt-in `grouped` layout — see [Layouts](#layouts-single-vs-grouped).
- `lib/statusline-format.js` — rendering primitives: `renderBar` (the `░▒▓█` shaded bar, ~24 steps), `wrapSegments` + `displayLength` (terminal-width auto-wrap that correctly counts CJK chars and the `░▒▓█` block chars as width-2), `formatTokens`, `clampPercent`, `parseResetTime`, plus the time/date formatters used by the fields and `--plan-details` (`formatTimeHHmm`, `formatResetHHmm`, `formatResetMMDD`, `formatDateMMDD`, `formatLocalDateTime`, `formatAge`).

**Plugin packaging:** `.claude-plugin/plugin.json` + `.claude-plugin/marketplace.json` (local marketplace `bingqiangzhou-tools`, `source: "./"`). The version string in `package.json`, `plugin.json`, and `marketplace.json` **must stay identical** — `verify.js` asserts all three match and also asserts no version number is hardcoded in the verifier itself.

**Skills (`skills/`):** `install`, `configure`, `plan-details`, `uninstall` → `/glm-statusline:*` commands. Each `SKILL.md` just runs a `bin/` command. They carry `disable-model-invocation: true`; `configure` is interactive-only and rejects arguments.

## Layouts (single vs grouped)

The status line has two layouts, chosen by `config.layout` (parsed in `readStatusConfig`, `glm-statusline.js`):
- `grouped` (default, also when the key is absent or any other value): fields are partitioned into fixed category rows, each rendered on its own line through `wrapSegments` (a wide row can still wrap within itself); empty rows are skipped. In this mode `speed` is a normal segment in its row (no trailing line).
- `single` (opt-out, `layout: "single"`): all selected fields on one line, auto-wrapping at terminal width. `speed`, if shown, is filtered out of the main segments and appended as its own trailing line (a hardcoded special-case in `renderStatusLine`, not a normal segment).

The row assignment is `FIELD_GROUPS` in `lib/display-fields.js` (group order = on-screen line order; within a row, `DISPLAY_FIELDS` canonical order applies). `groupDisplay(display)` does the partition. The grouped branch sits at the top of the `renderStatusLine` tail, before the single-line path. Current rows: row 1 `model`/`effort`/`speed`, row 2 `context`/`session`/`day`/`30d`, row 3 `plan`/`5h`/`mcp`.

Toggle it in `/glm-statusline:configure` by pressing `l` (`handleInput` in `bin/glm-statusline-install.js` flips `config.layout` and re-renders the preview). `readStatusConfig` only ever returns `'single'` or `'grouped'`.

## Critical invariants (don't break these)

- **The status line must never crash Claude Code.** `main().catch(...)` always prints a fallback line; cache-write errors are swallowed; API errors fall back to cached-then-default values. Preserve this when editing the orchestrator.
- **Unknown readings render as `--`, not `0` — except the quota/token counters, which deliberately show `0`.** The rendering primitive `renderBar(null)` → `░░░░░░░░ --%` never coerces; missing *context* → `--%` and missing *effort* → `--` (verified in `verifyEffortAndContextFix`). The `5h`, `mcp`, `day`, and `30d` fields are the deliberate exception: they apply `?? 0` before rendering (`fiveHourPercent ?? 0`, `quota.mcpPercent ?? 0`, `dayTokens ?? 0`, `monthTokens ?? 0` in `renderStatusLine`), so an absent quota/token reading shows an empty bar / `0` rather than `--`. An empty quota bar is the meaningful "nothing used" state, and the day/30d counters default to `0` instead of going blank.
- **Context flicker fix** (`resolveContextPercent`): hold the last-known `%` for that `session_id` from the cache instead of flashing to 0% when the reading is unreliable. Two readings are treated as "no reliable reading this tick": `context_window.used_percentage: null` (early session / after `/compact`), **and** a literal `0` while a real value is already cached. Claude Code sometimes emits a spurious `0` during session transitions (between turns, model switch); that transient 0 is held-against and deliberately **not** written to the cache, so it can't poison later null ticks. Note the asymmetry — a genuine `0` at the very start of a session (no held value yet) **is** cached and shown as `0%`, so the following null ticks hold `0%` instead of flashing to `--%`. (Net effect: real reading → transient 0 → real reading never dips the bar; start-of-session never flashes to `--%`.) Real context is never 0 once a session has produced tokens, and `/clear` starts a fresh `session_id` with no held value, so holding is always safe. Only the `context` field participates; entries are pruned after `CONTEXT_CACHE_TTL_MS` (24 h).
- **Speed session-reset re-seed** (`resolveSpeed`): the per-tick output-speed baseline is keyed by `session_id` and held across renders, like context. But `/clear` (and other transitions — `/compact`, session restore) can briefly hand the seed tick a stale larger cumulative output-token count (e.g. a new `session_id` whose `transcript_path` still resolves to the previous session's transcript). That poisons the baseline: the new session's growing count can never exceed it, so `dOut` stays ≤ 0 and `current` freezes at `--` for the rest of the session. Since cumulative output only grows within a real session, `outputTokens > 0 && outputTokens < prev.out` is treated as an unambiguous reset — re-seed the baseline from the current reading and return `current: null` until the next tick. The `> 0` guard avoids tripping on a transient read failure (an unreadable transcript returns 0). Do not remove this guard.
- **Speed Avg carry-over anchoring** (`resolveSpeed` → `anchoredAverage`): `cost.total_api_duration_ms` is a Claude Code **process-lifetime accumulator** — `/clear` (same process, new `session_id`) does **not** reset it, so the new session inherits the prior session's accumulated API time. The absolute average `out / (apiMs/1000)` was depressed by that foreign time while `current` stayed correct (delta-based). Proven live: a 357 s session reporting 1682 s of API time — 4.7× its own wall-clock, impossible without carry-over. `average` is now anchored at the session's first observed tick — `(out - out0) / ((apiMs - apiMs0)/1000)` — with `out0`/`apiMs0` seeded alongside the speed baseline (and re-seeded on the reset above); the foreign base cancels in both terms. The first tick / right after a reset still returns the absolute ratio (no delta yet) so the segment never shows a bare `--`; old cache entries lacking `out0`/`apiMs0` fall back to absolute until re-seeded. Do not revert `average` to the absolute formula.
- **Speed idle resilience + atomic shared cache.** Every Claude Code project writes the **same** cache file (`~/.claude/glm-statusline-cache.json`); each status-line render rewrites it. A non-atomic in-place write interleaved with a concurrent project's write corrupts the file → `loadCache` returns `{}` → every entry lost, including this session's `speed:<id>` baseline. Because the speed idle branch deliberately **never rewrites** the cache (to preserve the baseline for the next active tick), a lost entry stays `shown: null` → `Speed --` until the next message (other fields rewrite every render, so they recover in one tick — only speed strands). Two mitigations, both required: (1) `saveCache` writes **atomically** — temp file `${CACHE_FILE}.tmp.${process.pid}` then `fs.renameSync`; `rename` is atomic on POSIX so a reader always sees a complete file. (2) the idle branch falls back to a valid average when `shown` is null/<1 (`heldUsable = prev.shown >= 1`, matching `formatSpeed`'s `<1 → '--'`): `validAvg = anchored ?? (seedConsistent ? average : null)`, where `seedConsistent` (= `out0 === 0` or `out0 > 0 && apiMs0 > 0`) gates the absolute ratio to one process-lifetime — a resumed session (`out0 > 0`, `apiMs0` 0/null) has a mismatched old-transcript/new-process base and correctly stays `--`. The displayed `Avg` is unchanged; only `current`'s fallback widens. Do not make `saveCache` non-atomic, and do not remove the idle fallback.
- **Transcript usage dedup.** Claude Code writes one transcript line **per content block** (thinking / text / tool_use …) and attaches the **full `message.usage`** to each, so summing naively over-counts a message ~N× (measured 3.29×). `readJsonlOutputStats` and `readJsonlTokenStats` dedup by `message.id` (a `Set`), counting each message's usage once. Lines without `message.id` (e.g. `test/fixtures` and the verifier's single-line transcripts) count as-is. Do not sum usage across all lines without this dedup — it inflates `Speed`/`Avg`/`session`.
- **One cache read + one cache write per render.** `renderStatusLine` calls `loadCache()` once into a shared object and threads `(cache, mark)` through `resolveSpeed` / `fetchQuota` / `resolveContextPercent` / `fetchModelUsage`; each field mutates that object and calls `commitCache(cache, mark)` (which just flags dirty via `mark`), and a single `if (cacheDirty) saveCache(cache)` at the end persists everything — only when a field actually changed (a pure-idle render writes nothing). Do NOT reintroduce per-field `loadCache()`/`saveCache()` in these field functions: it brings back ~4 redundant whole-file reads/writes per render and widens the cross-project write-race window. The field functions keep `cache = cache || loadCache()` + `commitCache` so `renderPlanDetails` (which omits `cache`/`mark`) still self-manages; `cacheAgeFor` also still calls `loadCache()` directly — both are intentional and outside the status-line render path.
- **Stable launcher pattern.** `install` writes `~/.claude/glm-statusline-launcher.js` — a small script that finds the highest-semver `bin/glm-statusline.js` under `~/.claude/plugins/cache/bingqiangzhou-tools/glm-statusline/<version>/` and falls back to the source tree. The `statusLine.command` points at the *launcher*, never directly at a cache path, so `claude plugin update` can't orphan the command on a stale cache path. `uninstall` refuses to touch a `statusLine` it didn't manage unless `--force`.

## Domain logic to know: compatibility parsing

The GLM / Z.ai monitor API has **no fixed schema** — `test/fixtures/*.json` are illustrative samples, not a contract. `extractQuotaData` / `classifyLimit` / `readPercent` / `readUsageDetail` / `recursiveFindStringByKeys` recursively walk the response, matching fields against many candidate key names and classifying each limit object into `fiveHour` / `mcp` / `weekly` by keyword. When the API changes shape, expect to extend these candidate-key lists rather than restructure. Model names map Opus/Sonnet/Haiku → `ANTHROPIC_DEFAULT_*_MODEL` env vars (`mapClaudeModelToGlm`).

## Adding a display field

Touches these places, in order:
- `lib/display-fields.js` — add to `DISPLAY_FIELDS` + `FIELD_LABELS` (optionally `DEFAULT_DISPLAY`), and place it in the right `FIELD_GROUPS` row so it lands on the correct grouped-layout line.
- the `fields` map in `renderStatusLine` (`glm-statusline.js`).
- `README.md` — the field table, the "字段数据来源（每项怎么来的）" subsection, and the configure / layout examples.
- `bin/glm-statusline-install.js` — only if it changes the grouped-row string shown in the configure prompt.
- a new assertion in `scripts/verify.js`.

At release time, also add the entry to **both** `CHANGELOG.md` (English) and `CHANGELOG.zh.md` (Chinese). Note `verify.js` also asserts README content (must contain `兼容式解析`, `test/fixtures`, `lib/`, etc.) and forbids machine-specific absolute paths in docs — README edits can break the build.

## Releasing

A release is **commit + tag + push** — the git tag alone makes the version installable (`claude plugin update` resolves versions from tags). Steps:
1. Bump the version in all three manifests (`package.json`, `.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json`) — they must stay identical (`verify.js` asserts it).
2. Add a `## X.Y.Z - YYYY-MM-DD` entry to **both** `CHANGELOG.md` and `CHANGELOG.zh.md`.
3. `npm test`.
4. Commit the feature/docs change first, then a `chore: release glm statusline X.Y.Z` commit carrying the three manifests + both changelogs.
5. Tag `vX.Y.Z` (annotated: `git tag -a vX.Y.Z -m "Release glm statusline X.Y.Z"`) and push the commit and the tag.

The GitHub Actions workflow `.github/workflows/release.yml` triggers on a `v[0-9]*` tag push and creates a GitHub Release named `GLM StatusLine <version>` whose body is the matching entry pulled from `CHANGELOG.md` (English). No manual `gh release create` — and it won't fire if the workflow file isn't on `main`.
