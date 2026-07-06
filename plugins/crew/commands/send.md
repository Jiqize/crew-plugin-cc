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

- Every crew run (foreground or background) is a tracked task since v0.5, so any of them can be followed up. Without a task-id it targets the most recent task.
- omp, grok and opencode resume by exact session id when one was captured from the task's event log; otherwise they continue the most recent session in that task's directory (agy always does).
- The follow-up runs in the original task's working directory (including its isolated worktree, if any).
- If the companion says the task is still running, relay that — the user can watch it with `/crew:progress` or cancel first.
- `--background` runs the follow-up as a new tracked background task (it will print a new task id).
