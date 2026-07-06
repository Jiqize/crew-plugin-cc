---
description: Check that the crew CLIs (omp, grok, agy, opencode) are installed and working
allowed-tools: Bash
---

Run this check and report the results as a short table (CLI, installed?, path, version):

```bash
for cmd in omp grok agy opencode; do
  p=$(command -v "$cmd" 2>/dev/null)
  if [ -n "$p" ]; then
    v=$("$cmd" --version 2>/dev/null | head -1)
    echo "OK|$cmd|$p|$v"
  else
    echo "MISSING|$cmd||"
  fi
done
```

For any missing CLI, note it and suggest the install source: omp (oh-my-pi, npm), grok (grok.com/build CLI), agy (Google Antigravity CLI), opencode (opencode.ai). Do not install anything without asking.
