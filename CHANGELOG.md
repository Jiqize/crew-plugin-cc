# Changelog

本项目的所有显著变更均记录于此文件。

本变更日志遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 规范，版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [0.6.0] - 2026-07-07

### 修复
- 引入 `--task-stdin` + heredoc 调用规范，彻底解决多行任务被 shell 换行截断的实战问题。
- 实现假成功识别：退出码为 0 但回合被取消（如 grok stopReason=Cancelled）时，自动标记为 failed 并给出说明。
- 委派任务无最终产出时，自动标注“结果存疑”。
- 增强 `result` 和 `progress` 的失败诊断能力，可识别 agy 认证过期、MCP server 不可达等已知模式并给出修复提示。

## [0.5.0] - 2026-07-06

### 新增
- 前台运行也创建任务记录，任何一次运行都支持通过 `/crew:send` 追问（修复 v0.4 实际使用摩擦点）。
- 新增 `/crew:costs` 成本台账命令，数据来自各 CLI 事件流（含订阅制 $0 记录）。
- 后台任务完成后自动弹出 macOS 桌面通知。
- 自动清理 7 天前的已结束任务记录。

### 变更
- `--resume` 自动使用状态中记录的精确会话 id。
- 新增 `--cwd` 参数，支持将任务派发到指定目录。
- `/crew:pipeline --worktree` 支持整条流水线运行在同一隔离 worktree 中。

## [0.4.0] - 2026-07-06

### 新增
- 后台任务自动接入各 CLI 的 JSON 事件流（grok streaming-json / omp mode=json / opencode format=json）。
- 新增 `/crew:progress` 命令，实时展示工具调用、思考过程、输出与成本。
- 新增 `/crew:send` 命令，支持追问已结束任务的会话（omp 使用 `-r`、grok 使用 `-r`、opencode 使用 `-s` 按会话 id 精确续跑）。
- `/crew:result` 自动解析最终回答和成本，原始事件日志完整留档。
- 发布 `docs/usage-guide.md` 与 `usage-guide.html` 使用指南（由 omp 撰写、grok 通过 crew 自身审查）。

## [0.3.0] - 2026-07-06

### 新增
- 引入 `agents/crew-{omp,grok,agy,opencode}.md`，将各 CLI 包装为一等公民 subagent，可被 Agent 工具和 Workflow 编排直接调度。
- 新增 `/crew:race` 命令：多 CLI 并行竞赛选优，`--write` 时自动启用 worktree 隔离。
- 新增 `/crew:pipeline` 命令：实现“实现 → 审查 → 修复”循环，直到 LGTM 或轮次用尽。

## [0.2.0] - 2026-07-06

### 新增
- `scripts/crew-companion.mjs`：统一拼装各 CLI 无头命令，集中管理后台任务与会话状态。
- 新增 `/crew:status`、`/crew:result`、`/crew:cancel` 后台任务管理命令。
- 委派命令支持续会话询问（resume-candidate）和 `--worktree` 隔离。
- `setup` 命令改为通过 companion 进行统一体检。

### 变更
- 整体运行时对齐 codex-plugin 的确定性伴随进程模型。

## [0.1.0] - 2026-07-06

### 新增
- 首个版本，建立插件骨架（marketplace.json、plugin.json、README）。
- 提供将任务从 Claude Code 委派给 omp / grok / agy / opencode 四个外部 CLI 的能力。
- 新增 crew-runner agent 与命令：`/crew:omp`、`/crew:grok`、`/crew:agy`、`/crew:opencode`、`/crew:review`、`/crew:setup`。
