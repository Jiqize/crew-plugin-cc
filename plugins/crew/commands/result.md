---
description: Show the output of a crew background task (latest if no id given)
argument-hint: "[task-id]"
allowed-tools: Bash(node:*)
---

Run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/crew-companion.mjs" result $ARGUMENTS
```

Return the output verbatim. If it says the task is still running, tell the user to check again later with `/crew:result`.
