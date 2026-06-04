# GLM StatusLine Claude Code Plugin

This project packages `glm-statusline.js` as a Claude Code plugin.

The status line shows GLM Coding Plan quota, MCP/tool usage, current context usage, the mapped GLM model, current session tokens, day tokens, and recent 30-day tokens.

## Local Development

```bash
npm test
node bin/glm-statusline.js
```

## Install From This Directory

For development:

```bash
claude --plugin-dir .
```

For marketplace-style installation from this local repository:

```text
/plugin marketplace add /Users/bingqiangzhou/Workspaces/Projects/CCStatusline
/plugin install glm-statusline@bingqiangzhou-tools
/glm-statusline:install
```

`/glm-statusline:install` runs `glm-statusline-install.js install`, which writes the `statusLine` command into `~/.claude/settings.json`.

## Configure GLM

Keep GLM credentials in Claude Code settings:

```json
{
  "env": {
    "ANTHROPIC_AUTH_TOKEN": "your GLM or Z.ai API key",
    "ANTHROPIC_BASE_URL": "https://open.bigmodel.cn/api/anthropic",
    "ANTHROPIC_DEFAULT_OPUS_MODEL": "glm-5.1",
    "ANTHROPIC_DEFAULT_SONNET_MODEL": "glm-5.1",
    "ANTHROPIC_DEFAULT_HAIKU_MODEL": "glm-4.5-air",
    "GLM_STATUSLINE_CONTEXT_WINDOW": "200000"
  }
}
```

See these docs for the build notes and extension research:

- [docs/claude-code-plugin-build-guide.md](docs/claude-code-plugin-build-guide.md)
- [docs/claude-code-skills-and-extensions-guide.md](docs/claude-code-skills-and-extensions-guide.md)
