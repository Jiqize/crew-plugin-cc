# crew

在 Claude Code 里把任务委派给其他 agent CLI：**omp (oh-my-pi)、grok、antigravity (agy)、opencode**。

形态参考 [openai/codex-plugin-cc](https://github.com/openai/codex-plugin-cc)，但实现极简：各 CLI 都用自己的无头模式（`-p` / `run`），由一个薄转发子代理 `crew:crew-runner` 统一调用，输出原样返回。

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
| `/crew:setup` | 检查四个 CLI 是否安装可用 |

通用旗标：`--background`（后台跑，稍后要结果）、`--resume`（继续该 CLI 上次会话）、`--fresh`（强制新会话）、`--model <m>`（指定模型）。

## 自然语言触发

直接说"让 grok 看看这个 bug""叫 opencode 去修 XX""让 omp 审查一下"即可，会自动路由到对应命令。
