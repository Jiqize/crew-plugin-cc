# crew

在 Claude Code 里把任务委派给其他 agent CLI：**omp (oh-my-pi)、grok、antigravity (agy)、opencode**。

形态参考 [openai/codex-plugin-cc](https://github.com/openai/codex-plugin-cc)：各 CLI 走自己的无头模式（`-p` / `run`），由确定性运行时 `scripts/crew-companion.mjs` 统一拼命令、管后台任务和会话状态，薄转发子代理 `crew:crew-runner` 只负责调用它，输出原样返回。

## 安装

```bash
claude plugin marketplace add ~/Desktop/git/crew
claude plugin install crew@crew
```

## 命令

| 命令 | 作用 |
|---|---|
| `/crew:omp <任务>` | 委派给 omp（可改代码） |
| `/crew:grok <任务>` | 委派给 grok（可改代码，acceptEdits） |
| `/crew:agy <任务>` | 委派给 Antigravity（可改代码） |
| `/crew:opencode <任务>` | 委派给 opencode（可改代码，--auto） |
| `/crew:review --by <cli> [--base ref] [关注点]` | 让指定 CLI 只读审查当前改动 |
| `/crew:race [--by cli1,cli2] [--write] <任务>` | 多 CLI 并行做同一任务，对比选优（--write 时自动 worktree 隔离） |
| `/crew:pipeline [--impl cli] [--review cli] [--rounds N] <任务>` | 流水线：一个实现 → 另一个审查 → 循环修复直到 LGTM |
| `/crew:status [id]` | 查看后台任务状态 |
| `/crew:result [id]` | 取后台任务输出（默认最近一个） |
| `/crew:cancel [id]` | 取消运行中的后台任务 |
| `/crew:setup` | 检查四个 CLI 是否安装可用 |

通用旗标：`--background`（后台跑，companion 返回任务 id）、`--resume`（继续该 CLI 上次会话）、`--fresh`（强制新会话）、`--worktree`（在独立 git worktree 里跑，避免并行互踩）、`--model <m>`（指定模型）。

同一仓库对某 CLI 有过历史会话且未指定 `--resume/--fresh` 时，会像 Codex 插件一样问一次"继续上次还是开新会话"。

状态目录：`~/.crew/`（后台任务日志在 `jobs/`，隔离 worktree 在 `worktrees/`）。

## 具名 agent 类型

四个 CLI 各注册了一个一等公民 subagent：`crew:crew-omp`、`crew:crew-grok`、`crew:crew-agy`、`crew:crew-opencode`。除了斜杠命令，CC 原生的 Agent 工具和 Workflow 编排（`agentType: 'crew:crew-grok'`）都能直接调度它们，fan-out / pipeline / judge panel 等编排模式开箱即用。

## 自然语言触发

直接说"让 grok 看看这个 bug""叫 opencode 去修 XX""让 omp 审查一下"即可，会自动路由到对应命令。
