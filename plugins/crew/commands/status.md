---
description: Show status of crew background tasks
argument-hint: "[task-id]"
allowed-tools: Bash(node:*)
---

Run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/crew-companion.mjs" status $ARGUMENTS
```

Show the output as a short table (id, status, cli/mode, started, task). Do not add extra commentary beyond noting how to fetch results (`/crew:result <id>`) or cancel (`/crew:cancel <id>`).
