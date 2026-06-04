---
description: Open an interactive selector for choosing which GLM StatusLine fields are shown, saving and previewing after every choice.
argument-hint: "[--show=plan,5h,mcp,context,model,session,day,30d] [--layout=compact|full] [--bar-width=1-20]"
disable-model-invocation: true
---

# Configure GLM StatusLine

Run the interactive configurator from the plugin `bin` directory:

```bash
glm-statusline-install.js configure $ARGUMENTS
```

When the user invokes `/glm-statusline:configure` without arguments, the command opens a numbered selector. The user can type a number to toggle one field; after every toggle, the command saves the config and prints a fresh `Preview:` block.

Supported fields are:

- `plan`
- `5h`
- `mcp`
- `context`
- `model`
- `session`
- `day`
- `30d`

Report the command output as-is. Tell the user the real Claude Code status line will refresh after the next interaction or refresh interval.
