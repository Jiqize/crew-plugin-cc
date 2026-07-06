---
description: Show cost ledger for crew tasks (today + all-time, per CLI)
allowed-tools: Bash(node:*)
---

Run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/crew-companion.mjs" costs
```

Return the output verbatim. Note for the user if relevant: costs come from each CLI's own event stream (opencode/omp report cost per run; grok reports when its events include usage; agy does not report cost — those runs show as 成本未知).
