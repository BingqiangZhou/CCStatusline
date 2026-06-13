---
description: Open an interactive selector for choosing which GLM StatusLine fields are shown, saving and previewing after every choice.
disable-model-invocation: true
---

# Configure GLM StatusLine

Run the interactive configurator from the plugin `bin` directory:

```bash
glm-statusline-install.js configure
```

The command opens a numbered selector. The user can type a number to toggle one field; typing `l` switches between the single-line and grouped layouts (fields grouped onto separate lines). After every toggle, the command saves the config and prints a fresh `Preview:` block.

Supported fields are (selector order):

- `plan`
- `5h`
- `mcp`
- `context`
- `model`
- `effort`
- `session`
- `speed`
- `day`
- `30d`

Report the command output as-is. Tell the user the real Claude Code status line will refresh after the next interaction or refresh interval.
