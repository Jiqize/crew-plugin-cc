---
description: "Chain crew CLIs: one implements, another reviews, optionally a fix round"
argument-hint: "[--impl <cli>] [--review <cli>] [--rounds N] <task>"
allowed-tools: Agent, Bash(node:*, git:*)
---

Run an implement → review (→ fix) pipeline across external CLIs.

Raw user request:
$ARGUMENTS

Steps:

1. Parse flags: `--impl <cli>` (implementer, default omp), `--review <cli>` (reviewer, default grok; must differ from implementer — if the user picked the same CLI, warn and proceed anyway), `--rounds N` (max fix rounds, default 1). Valid CLIs: omp, grok, agy, opencode.
2. **Implement**: invoke the implementer's subagent (`crew:crew-<impl>`, foreground) with the task in delegate mode.
3. **Review**: invoke the reviewer's subagent (`crew:crew-<review>`) in review mode with: "Review the uncommitted changes in this repository (git status + git diff, including staged). Look for bugs, regressions, and risky patterns. Report findings with file:line and severity (critical/major/minor). Do NOT modify any files. If there are no significant issues, say exactly: LGTM."
4. **Fix loop**: if the review reports critical or major findings and fix rounds remain, invoke the implementer again with `resume: true` and a task of: "A reviewer found these issues in your changes — fix them:" followed by the findings verbatim. Then re-review. Repeat until LGTM or rounds are exhausted.
5. Final report: what was implemented (implementer's summary), the final review verdict, and how many fix rounds ran. Quote key outputs faithfully; do not embellish. If the loop ended with unresolved findings, list them clearly.
