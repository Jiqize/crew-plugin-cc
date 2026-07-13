---
description: Delegate a task to grok CLI in headless mode
argument-hint: "[--background] [--resume|--fresh] [--worktree] [--model <model>] [--reasoning-effort <effort>] [--rules <rules>] [--system-prompt-override <prompt>] <task for grok>"
allowed-tools: Bash(node:*), AskUserQuestion, Agent
---

Invoke the `crew:crew-runner` subagent via the `Agent` tool (`subagent_type: "crew:crew-runner"`) with: `cli: grok`, `mode: delegate`, and the raw user request below. Return the subagent's output verbatim — do not paraphrase, summarize, or add commentary.

Raw user request:
$ARGUMENTS

Routing flags (`--background`, `--resume`, `--fresh`, `--worktree`, `--model`, `--reasoning-effort`, `--rules`, `--system-prompt-override`) are not task text — forward them to the runner as flags:
写操作默认 `--reasoning-effort low`；`--review` 保持满推理不降档；显式传 `--reasoning-effort` 以用户值为准。

- `--background` → run the subagent in the background (`run_in_background: true`); tell the user the task id line the companion prints.
- If neither `--resume` nor `--fresh` is present, first run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/crew-companion.mjs" resume-candidate --cli grok
```

- If it reports `available: true`, use `AskUserQuestion` exactly once: `Continue previous grok session` vs `Start a new grok session`. If the user's request is clearly a follow-up ("continue", "接着", "keep going"), recommend continue; otherwise recommend new. Map the answer to `--resume` or `--fresh`. If `available: false`, route normally without asking.
- If the user gave no task text, ask what grok should do.
