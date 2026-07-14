---
description: Ask an external agent CLI to review the current changes (read-only)
argument-hint: "--by <omp|grok|agy|opencode|codex> [--base <ref>] [--background] [focus notes]"
allowed-tools: Bash(git:*), Agent
---

Ask one external CLI to do a read-only code review of the current changes, then return its output verbatim.

Raw user request:
$ARGUMENTS

Steps:

1. Determine the reviewer from `--by <cli>`. If missing, ask the user which CLI should review.
2. Build the review task text:
   - Default scope: uncommitted changes (`git status` + `git diff` + staged).
   - With `--base <ref>`: changes relative to that ref (`git diff <ref>...HEAD`).
   - Task text: "Review the code changes in this repository (<scope>). Look for bugs, regressions, and risky patterns. Report findings with file:line references and severity. Do NOT modify any files." Append the user's focus notes if any.
3. Invoke the `crew:crew-runner` subagent (`subagent_type: "crew:crew-runner"`) with `cli: <reviewer>`, `mode: review`, and that task text. With `--background`, run the subagent in the background.
4. Return the reviewer's output verbatim — no paraphrasing, no added commentary.
