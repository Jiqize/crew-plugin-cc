---
description: "Chain crew CLIs: one implements, another reviews, optionally a fix round"
argument-hint: "[--impl <cli>] [--review <cli>] [--rounds N] <task>"
allowed-tools: Agent, Bash(node:*, git:*)
---

Run an implement → review (→ fix) pipeline across external CLIs.

Raw user request:
$ARGUMENTS

Steps:

1. Parse flags: `--impl <cli>` (implementer, default omp), `--review <cli>` (reviewer, default grok; must differ from implementer — if the user picked the same CLI, warn and proceed anyway), `--rounds N` (max fix rounds, default 1), `--worktree` (run the whole pipeline in an isolated git worktree). Valid CLIs: omp, grok, agy, opencode, codex, kimi.
2. **Implement**: invoke the implementer's subagent (`crew:crew-<impl>`, foreground) with the task in delegate mode. With `--worktree`, tell the runner to add `--worktree`; the companion output will contain a line `隔离 worktree：<path>` — extract that path, and pass `cwd: <path>` (runner flag `--cwd <path>`) to ALL subsequent stages so review and fixes happen inside the same worktree.
3. **Review**: invoke the reviewer's subagent (`crew:crew-<review>`) in review mode with: "Review the uncommitted changes in this repository (git status + git diff, including staged). Look for bugs, regressions, and risky patterns. Report findings with file:line and severity (critical/major/minor). Do NOT modify any files. If there are no significant issues, say exactly: LGTM."
4. **Fix loop**: if the review reports critical or major findings and fix rounds remain, invoke the implementer again with `resume: true` and a task of: "A reviewer found these issues in your changes — fix them:" followed by the findings verbatim. Then re-review. Repeat until LGTM or rounds are exhausted.
5. Final report: what was implemented (implementer's summary), the final review verdict, and how many fix rounds ran. Quote key outputs faithfully; do not embellish. If the loop ended with unresolved findings, list them clearly. For `--worktree` runs, end with the worktree path and how to inspect/merge it (`git -C <path> diff`, merge or cherry-pick, clean up with `git worktree remove`).
