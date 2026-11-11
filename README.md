# crew

在 Claude Code 里把任务委派给其他 agent CLI：**omp (oh-my-pi)、grok、antigravity (agy)、opencode、codex、kimi (Kimi Code)**。

形态参考 [openai/codex-plugin-cc](https://github.com/openai/codex-plugin-cc)：各 CLI 走自己的无头模式（`-p` / `run`），由确定性运行时 `scripts/crew-companion.mjs` 统一拼命令、管后台任务和会话状态，薄转发子代理 `crew:crew-runner` 只负责调用它，输出原样返回。

## 安装

```bash
claude plugin marketplace add Jiqize/crew-plugin-cc
claude plugin install crew@crew
```

本地开发安装：

```bash
claude plugin marketplace add /path/to/crew-plugin-cc
claude plugin install crew@crew
```

前置要求：需要已安装并登录相应的 CLI（omp / grok / agy / opencode / codex / kimi，装哪个用哪个），安装后可用 `/crew:setup` 体检。

## 命令

| 命令 | 作用 |
|---|---|
| `/crew:omp <任务>` | 委派给 omp（可改代码） |
| `/crew:grok <任务>` | 委派给 grok（可改代码，acceptEdits） |
| `/crew:agy <任务>` | 委派给 Antigravity（可改代码） |
| `/crew:opencode <任务>` | 委派给 opencode（可改代码，--auto） |
| `/crew:codex <任务>` | 委派给 Codex（可改代码，免审批） |
| `/crew:kimi <任务>` | 委派给 Kimi Code（可改代码，prompt 模式自动执行工具） |
| `/crew:review --by <cli> [--base ref] [关注点]` | 让指定 CLI 只读审查当前改动 |
| `/crew:race [--by cli1,cli2] [--write] <任务>` | 多 CLI 并行做同一任务，对比选优（--write 时自动 worktree 隔离） |
| `/crew:pipeline [--impl cli] [--review cli] [--rounds N] [--worktree] <任务>` | 流水线：一个实现 → 另一个审查 → 循环修复直到 LGTM，可整条跑在隔离 worktree 里 |
| `/crew:status [id]` | 查看后台任务状态 |
| `/crew:progress [id]` | 流式进度：看任务正在干嘛（工具调用、思考、输出、成本） |
| `/crew:result [id]` | 取后台任务结果（自动解析出最终回答和成本） |
| `/crew:send [id] <消息>` | 追问任意已结束任务的会话（前台运行也有任务 id；omp/grok/opencode/kimi 按会话 id 精确续跑） |
| `/crew:cancel [id]` | 取消运行中的后台任务 |
| `/crew:costs` | 成本台账：今天/累计各 CLI 花了多少 |
| `/crew:setup` | 检查六个 CLI 是否安装可用 |

通用旗标：`--background`（后台跑，companion 返回任务 id）、`--resume`（继续该 CLI 上次会话）、`--fresh`（强制新会话）、`--worktree`（在独立 git worktree 里跑，避免并行互踩）、`--model <m>`（指定模型）、`--no-pane`（不开 Tern 进度面板）。

**Tern 终端集成**：在 Tern 终端里运行时：
- **omp / codex**：直接在右侧分屏里以完整交互界面运行（和平时手动打开一样），crew 读它的会话记录拿结果；回答完面板和 agent 保留，可以直接在面板里接着聊，`/crew:send` 追问也会发进同一个面板，`/crew:cancel` 关闭面板。
- **其它 CLI**：后台无头运行，右侧分屏显示实时活动日志，成功自动关闭，失败/取消保留。
- 多个任务从上一个 crew 面板往下叠；`--no-pane` 本次不开面板（omp/codex 回到无头模式）；不在 Tern 里时无任何变化。

同一仓库对某 CLI 有过历史会话且未指定 `--resume/--fresh` 时，会像 Codex 插件一样问一次"继续上次还是开新会话"。

状态目录：`~/.crew/`（任务日志在 `jobs/`，隔离 worktree 在 `worktrees/`，成本台账 `costs.jsonl`；7 天前的已结束任务自动清理）。

v0.5 起：每次运行（前台/后台）都是有 id 的任务，都可被 `send` 追问；后台任务完成会弹 macOS 桌面通知；`--resume` 自动使用记录的精确会话 id；`--cwd <dir>` 可把任务派进指定目录（如已有的 worktree）。

## 具名 agent 类型

六个 CLI 各注册了一个一等公民 subagent：`crew:crew-omp`、`crew:crew-grok`、`crew:crew-agy`、`crew:crew-opencode`、`crew:crew-codex`、`crew:crew-kimi`。除了斜杠命令，CC 原生的 Agent 工具和 Workflow 编排（`agentType: 'crew:crew-grok'`）都能直接调度它们，fan-out / pipeline / judge panel 等编排模式开箱即用。

## 自然语言触发

直接说"让 grok 看看这个 bug""叫 opencode 去修 XX""让 omp 审查一下"即可，会自动路由到对应命令。
