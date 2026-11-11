# Changelog

本项目的所有显著变更均记录于此文件。

本变更日志遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 规范，版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [0.16.2] - 2026-11-11

### 修复
- 从 Codex 里调用 crew 时开不出 Tern 面板：Codex 会缓存启动时的环境变量，`TERN_PANE` 可能是过期 id。分屏失败时回退到 `@focused`（当前焦点面板）旁边开。

## [0.16.1] - 2026-11-11

### 修复
- 原文保真：任务的最终回答另存为 `~/.crew/jobs/<id>.final.md`，前台输出与 `result` 都打印 `[crew] 原文：<路径>`；写报告时直接读该文件，不经模型转述。前台等收尾写好原文（最多 3 秒）再输出，避免漏打路径。
- `crew-runner` 明确要求逐字节原样返回 stdout（不翻译、不改写、不转义 `<>&`），修复转发时措辞被改写的问题。

## [0.16.0] - 2026-11-11

### 新增
- Tern 可见模式（omp、codex）：在 Tern 里运行时不再无头执行，而是 `tern split` 在面板里交互式启动完整 TUI（omp `--auto-approve --session-dir <任务目录>`，codex `--dangerously-bypass-approvals-and-sandbox`），任务作为首条消息。worker 跟踪会话记录（omp 任务专属 session 目录；codex 按启动时间 + 工作目录 + 任务文本认领 `~/.codex/sessions` 的 rollout），转换成无头模式的事件格式写进任务日志，progress/result/成本/multicrew 账本无需改动。一轮回答结束（omp stopReason 非 toolUse；codex task_complete）即判完成，面板与 agent 保留可继续对话。
- `send`：可见任务的面板还开着时，追问直接粘贴进该面板并等下一轮结束；面板已关则在新面板续跑会话。
- `cancel`：可见任务连同面板一起关闭。面板被手动关闭或 agent 退出时任务判失败。
- `--no-pane` 对 omp/codex 表示回到无头模式。

## [0.15.1] - 2026-11-11

### 新增
- 环境变量 `CREW_NO_PANE=1` 关闭 Tern 单任务面板：供 multicrew 等编排方自己开面板时使用，避免重复。

## [0.15.0] - 2026-11-11

### 新增
- Tern 终端集成：检测到 `TERN_PANE`（运行在 Tern 里）时，`run`/`send` 启动任务后用 `tern split` 自动开分屏，跑新增的 `watch <id>` 子命令每秒刷新最近活动、结束后显示最终回答。首个面板在发起面板右侧，后续任务从上一个 crew 面板往下分（记录在 `~/.crew/tern-pane.json`）。任务成功 watch 退出码 0、Tern 自动关闭面板；失败/取消/中断退出码 1，面板保留。best-effort，开面板失败不影响任务。
- `--no-pane`：单次禁用 Tern 面板。

## [0.14.1] - 2026-07-17

### 修复（kimi 接入 review 收口）
- kimi $0 入账锚点：从"仅 session.resume_hint 出现"放宽为"解析到最终回答或会话收尾任一"——resume_hint 行被同 fd 追加的裸工具 stdout 粘连丢失时，成功任务不再落成"成本未知"。
- kimi 事件字段类型防御：`content` 非字符串跳过（避免 finalText.trim() 在 cmdResult/cmdProgress 无保护路径抛 TypeError）；注释明示已知限制——kimi 无 end/error 事件，stopReason 恒空，假成功守卫只剩 !finalText 兜底。
- race/review 文档标注只读强度分级：grok（plan）/opencode（去 --auto）为硬只读，agy/codex/kimi 仅 prompt 前缀软只读——只读 race 在意外写入敏感的仓库建议加 --worktree 或用 --by 排除软只读 CLI。

## [0.14.0] - 2026-07-17

### 新增
- 接入 kimi（Moonshot Kimi Code CLI，实测 0.26.0）：`run --cli kimi` 走 `kimi -p <task> --output-format stream-json` 无头模式。`-p` 与 `--yolo`/`--auto`/`--plan` 全部互斥，prompt 模式默认自动执行工具，review 只读靠 prompt 前缀约束（同 agy）；续跑 `-S <sessionId>` 精确续跑、无 id 时 `-c` 续同目录上一会话；人设走 task 前缀注入。
- kimi 事件解析：`assistant.content` 为回答、`assistant.tool_calls` 为工具活动、`meta session.resume_hint` 捕获会话 id；工具 stdout 会裸混进日志，非 JSON 行跳过。订阅制全程无金额事件，解析到正常收尾按 $0 入账（同 grok/codex 口径）。
- 新增 `/crew:kimi` 命令与 `crew:crew-kimi` subagent；race/pipeline/review/setup/send/runner 文档的 CLI 清单同步扩到六个。

## [0.13.0] - 2026-07-15

### 新增
- `crew-companion run --json`：前台/后台 run 输出单行稳定结构化 JSON（`schemaVersion`/`jobId`/`cli`/`status`/`exitCode`/`finalText`/`cost`/`worktree`/`logFile`），供 multicrew 免正则反解取 `jobId`/`finalText`/`worktree`。`finalizeJob` 持久化 `finalText` 进 job 记录，供结果择优免二次解析日志。非 `--json` 路径逐字不变。

### 说明
- 本版正式发版 `run --json`（提交 c4c1351，在 0.12.0 之后落地、未随即发版）。0.11.0（codex 无头适配）、0.12.0（codex skill 前端）已随各自提交发布，未单列于本文件。

## [0.10.0] - 2026-07-13

### 新增
- `crew-companion run --squad <id> --run <rid>`：把派发的任务归入 multicrew squad run。created 事件追加 `--squad/--run` 透传（`multicrew ls --run <rid>`、`squad runs` 可按 run 聚合查看）；job 记录新增 `squad`/`squadRun` 字段。
- `--squad` 必须搭配显式 `--run`（run id 由编排者铸造，crew 不代铸，可先 `multicrew task create --squad` 获取）；`--run` 必须搭配 `--squad`。
- 派发前经 `multicrew squad show <id> --json` 校验 squad 预设存在且非 deprecated；校验失败报错退出、不建 job、不写任务事件（显式引用必须生效，同 `--agent` 语义）。squad 内容不注入任务文本。

### 验证（真实派发，2026-07-13）
- 临时项目内 `run --cli omp --squad demo.e2e.v1 --run sr-e2e001 -- 输出 ok` → 任务 done，`multicrew show <jobId> --json` 的 `.squad`=demo.e2e.v1、`.squadRun`=sr-e2e001；`ls --run sr-e2e001` 恰列该单。
- `--squad nope.squad.v1` → `squad 解析失败：Squad preset "nope.squad.v1" not found.` 退出 1，账本零新增事件；缺 `--run` / 缺 `--squad` 各自报错退出 1。
- 不带 `--squad` 最小派发 → created/dispatched/done 正常落账（cost 0），快照无 squad 键，与 0.9.1 行为一致。

## [0.9.1] - 2026-07-13

### 修复
- grok 成本采集：grok CLI（订阅制 OIDC 登录）事件流只报 token 用量、不含金额，此前成本一律记 unknown。现在 `end` 事件带 usage 但全程无 cost 字段时按 $0 入账（与 omp「订阅制 provider 报 0 也是合法成本」口径一致）；若未来 grok 事件流开始报金额，数值解析优先生效（含 0 也如实累加，不再要求 >0）。

## [0.9.0] - 2026-07-13

### 新增
- 派发留痕：每次派发在 CLI 进程启动之前，经 `multicrew task dispatch` 向项目级账本落一条 `dispatched` 审计事件（cli、model、reasoning-effort、agent、agentHash、完整 argv、cwd、jobId）。best-effort 语义同既有 emitMulticrew：multicrew 缺席/出错/`MULTICREW_DISABLE=1` 一律静默跳过，不阻断派发。覆盖全部派发路径（delegate 与 review、前台与后台，含 send 续跑单）。
- 审计引用替换：argv 中注入的人设 instructions 全文（grok `--rules` 值、task 前缀注入文本）替换为占位符 `[agent-instructions sha256:<hash12> <N> chars]`，task 原文照存；`agentHash` 为 instructions sha256 hex 前 12 位，与占位符内哈希一致。
- job 记录新增 `model`/`reasoningEffort`（合并后的生效值）、`agentHash`、`auditArgv`（引用替换后的 argv；原始 `argv` 不变供执行）。

## [0.8.0] - 2026-07-13

### 新增
- `crew-companion run --agent <id>`：引用 multicrew 用户级 agent 预设（`~/.multicrew/agents/*.md`）派发任务。派发前经 `multicrew agent show <id> --json` 解析预设；解析失败报错退出、不建 job、不写任务事件（显式引用必须生效，与看板记账的静默吞错语义相反）。
- 预设的 `cli`/`model`/`reasoning_effort` 作为缺省值，命令行显式旗标优先。
- 人设注入矩阵：grok 走 `--rules`（用户已显式给 `--rules` 时让位，改走 task 前缀）；omp/agy/opencode 走 task 前缀注入（omp 的 `--append-system-prompt` 实测内容可注入但行为约束不生效，弃用）。
- job 记录新增 `agent`/`agentInstructions` 字段；multicrew created 事件带 `--agent <id>`（看板可见人设身份）。

## [0.7.0] - 2026-07-13

### 新增
- multicrew 看板集成：任务派发/结束/取消/中断自动写入项目级 `.multicrew/events.jsonl`（created+started、done 带成本、failed 带原因和退出码、cancelled），worker 每 60s 检测日志增长发心跳 progress。非侵入：multicrew 未安装、出错或 `MULTICREW_DISABLE=1` 时静默跳过，crew 主流程不受影响。
- job 记录新增 `launchCwd`（定位项目级 ledger，worktree 任务也记发起目录）与 `cost`（finalizeJob 从事件流回写解析成本）。
- grok 新增 `--reasoning-effort`/`--rules`/`--system-prompt-override` 透传；delegate 模式默认 `--reasoning-effort low`（review 保持满推理）。

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
