---
description: Send a follow-up message into a finished crew task's session (ask questions, request changes)
argument-hint: "[task-id] [--background] <follow-up message>"
allowed-tools: Bash(node:*)
---

Run (task-id is optional — defaults to the most recent task; the follow-up message goes after `--`):

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/crew-companion.mjs" send [task-id] [--background] -- <follow-up message>
```

Return the output verbatim. Notes:

- omp and opencode resume by exact session id (captured from the task's event log); grok and agy continue their most recent session in that task's directory.
- The follow-up runs in the original task's working directory (including its isolated worktree, if any).
- If the companion says the task is still running, relay that — the user can watch it with `/crew:progress` or cancel first.
- `--background` runs the follow-up as a new tracked background task (it will print a new task id).
