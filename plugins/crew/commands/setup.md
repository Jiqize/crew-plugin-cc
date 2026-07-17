---
description: Check that the crew CLIs (omp, grok, agy, opencode, codex, kimi) are installed and working
allowed-tools: Bash(node:*)
---

Run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/crew-companion.mjs" setup
```

Report the results as a short table (CLI, installed?, path, version). For any missing CLI, note the install source: omp (oh-my-pi, npm), grok (grok.com/build CLI), agy (Google Antigravity CLI), opencode (opencode.ai), codex (OpenAI Codex CLI), kimi (Moonshot Kimi Code, moonshotai.github.io/kimi-code). Do not install anything without asking.
