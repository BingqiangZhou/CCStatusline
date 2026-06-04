# Changelog

## 1.2.3 - 2026-06-04

- Added automatic wrapping at field boundaries based on a conservative terminal-width estimate.

## 1.2.2 - 2026-06-04

- Added an install completion hint that points users to `/glm-statusline:configure`.

## 1.2.1 - 2026-06-04

- Changed no-argument `/glm-statusline:configure` into an interactive selector that saves and previews after every field toggle.

## 1.2.0 - 2026-06-04

- Simplified the live status line to one row: 5H quota/reset, Context, and Session tokens.
- Added configurable status line fields through `/glm-statusline:configure`, `GLM_STATUSLINE_DISPLAY`, and `~/.claude/glm-statusline-config.json`.
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
