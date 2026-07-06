---
description: Show live progress of a crew background task (what it is doing right now)
argument-hint: "[task-id]"
allowed-tools: Bash(node:*)
---

Run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/crew-companion.mjs" progress $ARGUMENTS
```

Return the output verbatim. If the user asks to keep watching ("盯着它" / "watch"), poll this command every ~20 seconds (Bash `sleep 20` between calls) until the status is no longer `running`, then fetch `/crew:result` and show it.
