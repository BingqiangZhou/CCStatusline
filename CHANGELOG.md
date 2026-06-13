# Changelog

## 1.2.16 - 2026-06-13

- Made the single-line / grouped layout toggle in `/glm-statusline:configure` more prominent: it now renders as a radio-style two-option block (`[x] single` / `[ ] grouped`), each with a one-line description, separated from the field list by a blank line, and the input prompt now reads `l = layout`. The README configure example and skill docs were updated to match.

## 1.2.15 - 2026-06-13

- Changed the `grouped` layout's field-to-row assignment: row 1 is now `plan` / `5h` / `mcp`; row 2 is `context` / `session` / `day` / `30d`; row 3 is `model` / `effort` / `speed`. (Previously row 1 held all quota fields, row 2 the conversation fields, and row 3 only `model`.) The single-line default layout is unchanged.

## 1.2.14 - 2026-06-13

- Added an opt-in `grouped` layout that splits the status line into category rows: quota (`plan`, `5h`, `mcp`, `day`, `30d`), current conversation (`context`, `effort`, `session`, `speed`), and model (`model`) — each on its own line, with no selected fields in a category omitting that line. Each row still auto-wraps to terminal width and keeps the usual field order. In grouped mode the `speed` field merges into the conversation row instead of occupying its own trailing line. Toggle it via `/glm-statusline:configure` (press `l`) or set `"layout": "grouped"` in the config file; the default remains the single-line layout.

## 1.2.13 - 2026-06-13

- Upgraded the optional `speed` field to show both current and session-average output throughput on its own dedicated line: `Speed <current> t/s · Avg <average> t/s`. Average is cumulative output tokens ÷ cumulative API time. The current value no longer drops to `0` when idle — it holds the last measured speed (`--` only before the first measurement). Also fixed `Avg 0 t/s` appearing on sessions with API time but no output tokens yet.

## 1.2.12 - 2026-06-13

- Added an optional `speed` field showing the current output throughput in tokens/sec, derived from the transcript's output-token growth over the `cost.total_api_duration_ms` growth (real API time, so idle between renders can't inflate the number), with per-session state cached by `session_id`. The first reading shows `--`, the value holds while idle, and it decays to `0` after 30s of no new output. Falls back to the transcript-timestamp span, then wall-clock, when `cost.total_api_duration_ms` is unavailable. Toggle it via `/glm-statusline:configure`; off by default.

## 1.2.11 - 2026-06-13

- Fixed the context bar still flashing to `0%` mid-session in some cases. Claude Code occasionally emits a literal `0` for `used_percentage` during session transitions (between turns, model switch); the previous fix only held steady across `null` readings. A reported `0` is now treated as transient when a real value is already cached for the session, and is deliberately not written to the cache so it can't poison later ticks. A genuine `0` at the very start of a session (no prior value) is still cached so the bar holds `0%` instead of flashing to `--%`.

## 1.2.10 - 2026-06-13

- Added the MCP/tools quota expiry date to the MCP status line field, shown as a compact `@MM-DD` (e.g. `@06-14`) next to the MCP bar. The GLM / Z.ai API already returns the window expiry; it is now surfaced in the status line (`@--` when unavailable), and `--plan-details` shows the full date and time for the MCP window.

## 1.2.9 - 2026-06-12

- Added an optional `effort` field showing the current reasoning effort level (`low` / `medium` / `high` / `xhigh` / `max`), read from Claude Code's `effort.level` statusline input (Claude Code v2.1.119+). Toggle it via `/glm-statusline:configure`; off by default.
- Fixed the context bar briefly flashing to `0%` early in a session and after `/compact`. Claude Code reports `used_percentage` as `null` at those moments; the bar now holds the last known value for the session (cached by `session_id`) so it stays steady, and shows `--%` only before the first real value instead of a misleading `0%`.

## 1.2.8 - 2026-06-06

- Changed progress bar characters from partial blocks (▏▎▍▌▋▊▉) to full-width shade characters (░▒▓█), eliminating visible gaps between filled and empty cells.
- Each bar cell now has 4 shade levels (░ empty → ▒ medium → ▓ dark → █ full), giving 24 total steps (~4.17% per step) with seamless visual appearance.

## 1.2.7 - 2026-06-06

- Changed `renderBar` from `Math.round` to `Math.ceil` so small percentages (like 4%) show at least one visible block instead of appearing empty.
- Introduced partial block characters for finer granularity (~1.56% per step), later replaced by full-width shades in 1.2.8.

## 1.2.6 - 2026-06-04

- Extracted display field definitions into `lib/display-fields.js` and formatting utilities into `lib/statusline-format.js`.
- Added test fixtures for GLM / Z.ai API responses (`test/fixtures/`).
- Updated README: added GitHub `owner/repo` marketplace install option alongside local path.
- Updated plugin build guide documentation.

## 1.2.5 - 2026-06-04

- Changed the default status line fields to `5h`, `mcp`, `session`, and `day`.

## 1.2.4 - 2026-06-04

- Simplified configuration to the no-argument interactive selector and a single `display` config array.
- Removed parameter-style display configuration, field aliases, boolean display flags, layout selection, and configurable bar width.

## 1.2.3 - 2026-06-04

- Added automatic wrapping at field boundaries based on a conservative terminal-width estimate.

## 1.2.2 - 2026-06-04

- Added an install completion hint that points users to `/glm-statusline:configure`.

## 1.2.1 - 2026-06-04

- Changed no-argument `/glm-statusline:configure` into an interactive selector that saves and previews after every field toggle.

## 1.2.0 - 2026-06-04

- Simplified the live status line to one row: 5H quota/reset, Context, and Session tokens.
- Added configurable status line fields through `/glm-statusline:configure` and `~/.claude/glm-statusline-config.json`.
- Added `glm-statusline.js --preview` and installer/configurator preview output so users can see selected fields immediately.
- Added `/glm-statusline:plan-details` for expanded GLM Coding Plan information.
- Added quota detail extraction for used/total values, reset times, MCP quota, and weekly quota when the API returns it.
- Kept model, Context, and Session token details out of the plan details command.

## 1.1.2 - 2026-06-04

- Added `CHANGELOG.md` to track plugin releases.
- Added `GLM_STATUSLINE_CACHE_FILE` for tests and isolated runs, so verification does not write mock API entries into the user's real status line cache.
- Cleaned test pollution from the local cache workflow.
- Removed the old personal notes document from the repository contents.

## 1.1.1 - 2026-06-04

- Changed the installer to write a stable launcher at `~/.claude/glm-statusline-launcher.js`.
- The stable launcher automatically selects the latest installed plugin cache version, so `claude plugin update glm-statusline@bingqiangzhou-tools` no longer leaves `statusLine.command` pinned to an older version path.
- Kept uninstall support for both the old version-pinned command and the new stable launcher command.

## 1.1.0 - 2026-06-04

- Replaced the current clock display with `5H@HH:mm`.
- `5H@HH:mm` prefers the 5H quota `nextResetTime`; when that field is unavailable, it shows the last successful quota refresh time.
- Changed `Mon` to `30D` for clearer recent 30-day token usage.
- Switched Day and 30D token totals to the Zhipu/Z.ai `/api/monitor/usage/model-usage` API.
- Removed local project transcript scanning for Day and 30D usage totals.
- Improved large token formatting, for example `5.98B` instead of `6B`.

## 1.0.0 - 2026-06-04

- Initial Claude Code plugin packaging for GLM StatusLine.
- Added install and uninstall skills.
- Added marketplace manifest for `bingqiangzhou-tools`.
- Added validation script and plugin build documentation.
