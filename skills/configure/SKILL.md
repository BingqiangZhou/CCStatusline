---
description: Configure which GLM StatusLine fields are shown and print a live preview.
argument-hint: "[--show=plan,5h,mcp,context,model,session,day,30d] [--layout=compact|full] [--bar-width=1-20]"
disable-model-invocation: true
---

# Configure GLM StatusLine

If the user did not provide `$ARGUMENTS`, ask which fields they want to show. Supported fields are:

- `plan`
- `5h`
- `mcp`
- `context`
- `model`
- `session`
- `day`
- `30d`

Then run the plugin configurator:

```bash
glm-statusline-install.js configure $ARGUMENTS
```

Report the command output as-is, including the `Preview:` block. Tell the user the real Claude Code status line will refresh after the next interaction or refresh interval.
