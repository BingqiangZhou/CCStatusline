# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A Claude Code **status line plugin** ("GLM StatusLine") that shows GLM / Z.ai usage (5H quota, MCP/tools quota, context %, session tokens, day/30D usage, mapped model name, effort level) in the Claude Code status bar. It is also a learning project: `notes/` holds 11 study notes on the Claude Code plugin system (in Chinese) with this plugin as the worked example.

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
3. Build a `fields` map and pass selected segments to `wrapSegments`.

**3. Shared library (`lib/`)**
- `lib/display-fields.js` — the canonical field set, order, labels, and config normalization. `DISPLAY_FIELDS` (`['plan','5h','mcp','context','model','effort','session','day','30d']`) is the single source of truth for ordering; `DEFAULT_DISPLAY` is `['5h','mcp','session','day']`.
- `lib/statusline-format.js` — rendering primitives: `renderBar` (the `░▒▓█` shaded bar, ~24 steps), `wrapSegments` + `displayLength` (terminal-width auto-wrap that correctly counts CJK chars and the `░▒▓█` block chars as width-2), `formatTokens`, `parseResetTime`, `formatTimeHHmm`, `clampPercent`.

**Plugin packaging:** `.claude-plugin/plugin.json` + `.claude-plugin/marketplace.json` (local marketplace `bingqiangzhou-tools`, `source: "./"`). The version string in `package.json`, `plugin.json`, and `marketplace.json` **must stay identical** — `verify.js` asserts all three match and also asserts no version number is hardcoded in the verifier itself.

**Skills (`skills/`):** `install`, `configure`, `plan-details`, `uninstall` → `/glm-statusline:*` commands. Each `SKILL.md` just runs a `bin/` command. They carry `disable-model-invocation: true`; `configure` is interactive-only and rejects arguments.

## Critical invariants (don't break these)

- **The status line must never crash Claude Code.** `main().catch(...)` always prints a fallback line; cache-write errors are swallowed; API errors fall back to cached-then-default values. Preserve this when editing the orchestrator.
- **Never coerce an unknown value to 0.** Missing context → `--%` (not `0%`); missing effort → `--`; missing percent → `--%`. This is intentional and verified in `verifyEffortAndContextFix`.
- **Context flicker fix** (`resolveContextPercent`): when Claude Code reports `context_window.used_percentage: null` (early session / after `/compact`), hold the last-known `%` for that `session_id` from the cache instead of flashing to 0%. Only the `context` field participates; entries are pruned after `CONTEXT_CACHE_TTL_MS` (24 h).
- **Stable launcher pattern.** `install` writes `~/.claude/glm-statusline-launcher.js` — a small script that finds the highest-semver `bin/glm-statusline.js` under `~/.claude/plugins/cache/bingqiangzhou-tools/glm-statusline/<version>/` and falls back to the source tree. The `statusLine.command` points at the *launcher*, never directly at a cache path, so `claude plugin update` can't orphan the command on a stale cache path. `uninstall` refuses to touch a `statusLine` it didn't manage unless `--force`.

## Domain logic to know: compatibility parsing

The GLM / Z.ai monitor API has **no fixed schema** — `test/fixtures/*.json` are illustrative samples, not a contract. `extractQuotaData` / `classifyLimit` / `readPercent` / `readUsageDetail` / `recursiveFindStringByKeys` recursively walk the response, matching fields against many candidate key names and classifying each limit object into `fiveHour` / `mcp` / `weekly` by keyword. When the API changes shape, expect to extend these candidate-key lists rather than restructure. Model names map Opus/Sonnet/Haiku → `ANTHROPIC_DEFAULT_*_MODEL` env vars (`mapClaudeModelToGlm`).

## Adding a display field

Touches four places, in order: `lib/display-fields.js` (`DISPLAY_FIELDS` + `FIELD_LABELS`; optionally `DEFAULT_DISPLAY`), the `fields` map in `renderStatusLine` (`glm-statusline.js`), the field tables in `README.md`, and a new assertion in `scripts/verify.js`. Note `verify.js` also asserts README content (must contain `兼容式解析`, `test/fixtures`, `lib/`, etc.) and forbids machine-specific absolute paths in docs — README edits can break the build.
