---
description: Enable the GLM status line in Claude Code user settings after the plugin is installed, optionally choosing which fields to display.
argument-hint: "[--show=plan,5h,mcp,context,model,session,day,30d] [--layout=compact|full] [--bar-width=1-20]"
---

# Install GLM StatusLine

Run the plugin installer from the plugin `bin` directory, passing any user-provided arguments:

```bash
glm-statusline-install.js install $ARGUMENTS
```

Then tell the user that the status line is enabled and will refresh after their next Claude Code interaction. Include the `Preview:` block from the command output when present.
Also tell the user they can run `/glm-statusline:configure` to choose which fields are shown; that command opens an interactive selector and previews after each selection.
If the command fails, report the error output and suggest checking `~/.claude/settings.json`.
