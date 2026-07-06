---
description: Cancel a running crew background task (latest running one if no id given)
argument-hint: "[task-id]"
allowed-tools: Bash(node:*)
---

Run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/crew-companion.mjs" cancel $ARGUMENTS
```

Return the output verbatim.
