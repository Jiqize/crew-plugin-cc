---
description: Run the same task on multiple crew CLIs in parallel and compare the results
argument-hint: "[--by omp,grok,agy,opencode,codex] [--write] <task>"
allowed-tools: Agent, Bash(node:*)
---

Race the same task across multiple external CLIs, then compare their results.

Raw user request:
$ARGUMENTS

Steps:

1. Contestants: parse `--by` as a comma-separated list of CLIs (omp, grok, agy, opencode, codex). Default when absent: all five.
2. Task nature:
   - Without `--write`: treat it as analysis/research — each contestant runs read-only (tell the runner `mode: review`).
   - With `--write`: the task modifies code — each contestant MUST run with worktree isolation so they don't clash (tell the runner to add `--worktree`).
3. Launch ALL contestants in a single message as parallel `Agent` calls, one per CLI, using the matching subagent type (`crew:crew-omp`, `crew:crew-grok`, `crew:crew-agy`, `crew:crew-opencode`, `crew:crew-codex`), each forwarding the same task text.
4. When all return, write a comparison:
   - A short verdict first: which CLI gave the best result and why (correctness, depth, actionability).
   - Then a per-CLI summary with its key findings/output quoted faithfully. Note any contestant that failed or timed out instead of silently dropping it.
   - For `--write` races: list each contestant's worktree path so the user can inspect the diffs and merge the winner (`git worktree list`, then merge or cherry-pick; clean up with `git worktree remove`).
