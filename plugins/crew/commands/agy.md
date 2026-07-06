---
description: Delegate a task to Antigravity CLI (agy) in headless mode
argument-hint: "[--background] [--resume] [--model <model>] <task for antigravity>"
allowed-tools: Bash(agy:*), Agent
---

Invoke the `crew:crew-runner` subagent via the `Agent` tool (`subagent_type: "crew:crew-runner"`) with: `cli: agy`, `mode: delegate`, and the raw user request below. Return the subagent's output verbatim — do not paraphrase, summarize, or add commentary.

Raw user request:
$ARGUMENTS

Execution rules:

- `--background` → run the subagent in the background (`run_in_background: true`); tell the user the task is running and they can ask for the result later. Otherwise run in the foreground.
- `--resume` → tell the runner to continue agy's previous session. `--fresh` → start new. These are routing flags, not task text.
- `--model <m>` → pass through to the runner; otherwise leave the model unset.
- If the user gave no task text, ask what Antigravity should do.
