# crew v0.4.0 使用指南

> **面向首次使用 crew 插件的 Claude Code 用户**  
> 本指南包含可直接复制运行的命令示例。所有示例假设你已在 Claude Code 会话中，且当前目录是一个 git 仓库（推荐）。

## 插件是什么？解决什么问题？

`crew` 是一个 Claude Code 插件（版本 0.4.0），用于**把任务委派（delegate）给外部 agent CLI**：

- **omp** (oh-my-pi)
- **grok** (grok.com/build CLI)
- **agy** (Google Antigravity / antigravity CLI)
- **opencode** (opencode.ai)

### 核心价值
- **在 Claude Code 里直接调用其他 CLI 的能力**，无需切换终端或复制粘贴上下文。
- **确定性运行时**（`crew-companion.mjs`）：统一拼装各 CLI 的无头参数（`-p` / `--print` / `run` 等），处理后台任务、会话续跑、git worktree 隔离。
- **后台长任务管理**：适合耗时编码、分析、审查任务，不阻塞当前会话。
- **并行与流水线编排**：race 多 CLI 对比、pipeline（实现→审查→修复循环）。
- **只读审查** + **写操作隔离**：review 永远不改文件；--worktree 让并行写操作互不干扰。
- **会话连续性**：自动记录上次会话，支持 `--resume` 续跑（omp / opencode / grok 在捕获到 `sessionId` 时用 `-r` 精确续跑；无 `sessionId` 时 grok 退化为 `-c`；agy 固定 `--continue`）。
- **原样返回输出**：子代理只做转发，不总结、不改写结果。

**形态参考**：openai/codex-plugin-cc 风格，由薄转发子代理 + 伴侣脚本驱动。

**状态目录**：`~/.crew/`（`jobs/` 放后台任务日志和状态，`worktrees/` 放隔离 worktree）。

## 安装与环境检查

### 安装插件
```bash
# 添加本地 marketplace（假设 crew 仓库在 ~/Desktop/git/crew）
claude plugin marketplace add ~/Desktop/git/crew

# 安装 crew 插件
claude plugin install crew@crew
```

安装后会注册斜杠命令（`/crew:*`）和 5 个具名 subagent 类型。

### 环境检查（必须先做）
```bash
/crew:setup
```

**示例输出**（表格形式）：
```
CLI      | installed? | path                  | version
omp      | OK         | /usr/local/bin/omp    | omp vX.Y.Z
grok     | OK         | /usr/local/bin/grok   | ...
agy      | MISSING    |                       |
opencode | OK         | ...                   | ...
```

**缺失 CLI 的安装提示**（setup 会告诉你来源）：
- `omp`：oh-my-pi（npm 包）
- `grok`：grok.com/build CLI
- `agy`：Google Antigravity CLI
- `opencode`：opencode.ai

**重要**：不要让插件自动安装，先手动安装对应 CLI 并确保在 PATH 中。运行 `/crew:setup` 再次确认。

## 全部命令概览（13 个用户命令）

| 命令 | 作用 | 典型场景 |
|------|------|----------|
| `/crew:omp` | 委派给 omp | 编码、分析、工具调用 |
| `/crew:grok` | 委派给 grok | 深度思考、研究 |
| `/crew:agy` | 委派给 Antigravity | 长上下文、复杂任务 |
| `/crew:opencode` | 委派给 opencode | 自动模式编码 |
| `/crew:review` | 只读审查当前改动 | 代码审查 |
| `/crew:race` | 多 CLI 并行跑同一任务并对比 | 选最优方案 |
| `/crew:pipeline` | 实现 → 审查 → 修复循环 | 质量保证流水线 |
| `/crew:send` | 向已结束任务追问（`--` 后跟消息） | 迭代、追问细节 |
| `/crew:progress` | 看后台任务实时进度 | 监控长任务 |
| `/crew:status` | 查看后台任务列表/状态 | 总览 |
| `/crew:result` | 取后台任务最终结果 | 获取输出 |
| `/crew:cancel` | 取消运行中的后台任务 | 终止 |
| `/crew:setup` | 检查环境 | 首次使用/故障排查 |

## 通用旗标（适用于 omp/grok/agy/opencode）

所有委派命令（omp/grok/agy/opencode）支持这些旗标（**不是任务文本**，会自动被路由）：

- `--background`：后台运行。立即返回任务 ID，后续用 progress/result 跟踪。适合 >5-10 分钟的任务。
- `--resume`：继续该 CLI 在当前仓库的**上次会话**。
- `--fresh`：强制开启**新会话**（忽略历史）。
- `--worktree`：在独立的 git worktree 中执行（避免并行任务互相污染文件系统）。写操作任务推荐加上。
- `--model <模型名>`：覆盖默认模型（格式因 CLI 而异，例如 `omp` 用 `--model`，`opencode` 用 `-m`）。

**自动行为**（不指定 resume/fresh 时）：
- 同一仓库对该 CLI 有历史会话 → 插件会用 `AskUserQuestion` 问一次：“继续上次会话”还是“开新会话”。
- 明确 follow-up 词（“继续”、“接着”、“keep going”）会推荐 resume。

**示例**（直接复制）：
```bash
# 后台 + 隔离 worktree + 指定模型
/crew:omp --background --worktree --model sonnet "重构 src/utils.ts 中的所有工具函数，添加类型和测试"

# 续跑上次的 grok 会话
/crew:grok --resume "继续上次的方案，处理边界条件"

# 新会话 + 后台
/crew:agy --fresh --background "分析这个大型代码库的架构问题"
```

## 各命令详细用法 + 可复制示例

### 1. /crew:omp <任务>
委派给 omp（支持完整工具调用、可改代码）。

```bash
/crew:omp "实现一个用户认证中间件，支持 JWT 和 session"

# 后台 + worktree
/crew:omp --background --worktree "把所有 console.log 替换成结构化 logger"

# 续跑
/crew:omp --resume "刚才的实现加一个 rate limit"
```

### 2. /crew:grok <任务>
委派给 grok（`acceptEdits` 权限，可改代码）。

```bash
/crew:grok "解释当前 PR 的改动并给出潜在风险清单"

# review 模式后台
/crew:grok --background "审查最近的数据库查询变更"
```

### 3. /crew:agy <任务>
委派给 Antigravity（长上下文强，默认跳过权限确认）。

```bash
/crew:agy "对整个项目做安全审计，列出 OWASP Top 10 相关风险"

# 后台
/crew:agy --background "生成项目的技术文档大纲"
```

### 4. /crew:opencode <任务>
委派给 opencode（`--auto` 模式）。

```bash
/crew:opencode "添加一个新的 API 端点 /health 并写测试"

# 指定 provider/model
/crew:opencode --model anthropic/claude-3-5-sonnet --background "迁移旧的 class 组件到 hooks"
```

### 5. /crew:review --by <cli> [--base <ref>] [关注点]
让指定 CLI **只读**审查当前改动。永远不会修改文件。

```bash
# 审查未提交改动（默认）
/crew:review --by grok "重点关注性能和安全"

# 基于某个 ref 的 diff
/crew:review --by omp --base main "审查本次 feature 分支的所有变更"

# 后台审查
/crew:review --by agy --background "列出所有可能的空指针和边界问题"
```

**实现细节**：自动采集 `git status + git diff + staged`，或 `git diff <base>...HEAD`。

### 6. /crew:race [--by omp,grok,agy,opencode] [--write] <任务>
同一任务在多个 CLI 上**并行**执行，然后对比结果。

- 无 `--write`：每个用 review（只读）模式。
- 有 `--write`：每个自动加 `--worktree` 隔离，互不冲突。

```bash
# 分析任务（只读 race）
/crew:race --by omp,grok "分析当前登录模块的安全性并给出改进建议"

# 写操作 race（自动 worktree）
/crew:race --write "重写用户偏好存储逻辑，支持本地 + 云端同步"

# 默认全四家
/crew:race "为这个 bug 提出三种不同架构方案"
```

**返回格式**：先给出“哪个最好 + 理由”，再逐个引用原始输出 + worktree 路径（可手动 `git worktree list` 后合并）。

### 7. /crew:pipeline [--impl <cli>] [--review <cli>] [--rounds N] <任务>
实现 → 审查 → 修复循环。

- `--impl` 默认 `omp`
- `--review` 默认 `grok`（必须与 impl 不同，否则警告但继续）
- `--rounds` 默认 1
- **仅支持** `--impl`、`--review`、`--rounds` 三个参数（`pipeline.md` 不解析 `--worktree` 等委派旗标）。实现阶段在**当前工作目录**改文件；需要隔离时请先用 `/crew:omp --worktree` 等单独实现，或改用 `/crew:race --write`（自动 worktree）。

```bash
# 默认流水线（omp 实现 → grok 审查，最多 1 轮修复）
/crew:pipeline "实现一个带缓存的 API 客户端"

# 指定 + 多轮
/crew:pipeline --impl opencode --review omp --rounds 3 "添加完整的错误重试和退避逻辑"
```

**流程**：
1. impl 跑任务（delegate 模式）
2. review 跑审查（只读）
3. 如果有 critical/major 问题且 rounds 剩余 → 带问题描述 resume impl → 再 review
4. 直到 LGTM 或 rounds 用尽

### 8. /crew:send [task-id] [--background] -- <follow-up>
向**已结束**任务的会话追问（迭代、要改动、追细节）。

- task-id 可省略 → 最近任务
- 消息必须放在 `--` 之后
- omp / opencode / grok：优先用任务日志里捕获的 `sessionId` 精确续跑（`-r` / `-s`）；grok 无 `sessionId` 时用 `-c`
- agy：在该任务的工作目录下用 `--continue` 续跑
- `--background` 会把追问也作为新后台任务

```bash
# 对最近任务追问
/crew:send -- 刚才的实现里加上单元测试

# 指定 id + 后台追问
/crew:send c-a1b2c3 --background -- "把错误处理改成用 Result 类型"

# 明确 id
/crew:send c-xyz789 -- "根据审查意见修复第 3 条问题"
```

**注意**：如果任务还在 running，会提示先等或 cancel。

### 9. /crew:progress [task-id]
查看后台任务**实时在做什么**（工具调用、思考、输出片段、成本）。

```bash
/crew:progress

/crew:progress c-a1b2c3

# 持续观察（每 20s 刷新，直到结束）
# 在 Claude Code 中可多次发送：
/crew:progress c-a1b2c3
# 等 20s 后再次发送...
```

内部会解析各 CLI 的 JSON 事件流（agy 除外，无事件流）。

### 10. /crew:status [task-id]
列出后台任务（简表：id、status、cli/mode、时间、任务摘要）。

```bash
/crew:status

/crew:status c-a1b2c3
```

状态包括：running / done / failed / interrupted / canceled。

### 11. /crew:result [task-id]
取出后台任务的**最终结果**。

- 自动解析事件日志中的 finalText、成本、会话 id
- 仍 running 时会提示用 progress
- 同时打印 worktree 路径（如果有）

```bash
/crew:result

/crew:result c-a1b2c3
```

### 12. /crew:cancel [task-id]
取消正在运行的后台任务（杀进程组 + 标记 canceled）。

```bash
/crew:cancel

/crew:cancel c-a1b2c3
```

### 13. /crew:setup
见“环境检查”一节。

## 后台任务完整生命周期（推荐流程）

```bash
# 1. 派发长任务（后台）
/crew:omp --background --worktree "重构整个认证系统并写完整测试"

# 输出示例：
# 已启动后台任务 c-7f8e9d（omp/delegate）。
# 看进度 /crew:progress c-7f8e9d，取结果 /crew:result c-7f8e9d，取消 /crew:cancel c-7f8e9d。
# 隔离 worktree：/Users/.../.crew/worktrees/c-7f8e9d

# 2. 查进度（可多次）
/crew:progress c-7f8e9d

# 3. 任务结束时取结果
/crew:result c-7f8e9d

# 4. 追问续跑（基于原会话）
/crew:send c-7f8e9d -- "根据结果再加一个登出接口"

# 5. 取消（仅 running 时有效）
/crew:cancel c-7f8e9d
```

**提示**：
- 想让 Claude Code 自动轮询：可以让它多次调用 progress，直到状态不是 running。
- 所有后台任务状态持久化在 `~/.crew/jobs/*.json`。

## 5 个 Subagent 类型的编排用法

插件注册了 5 个具名 subagent（可在 Claude Code 的 `Agent` 工具或 Workflow 中直接使用）：

1. `crew:crew-runner`（内部薄转发器）
2. `crew:crew-omp`
3. `crew:crew-grok`
4. `crew:crew-agy`
5. `crew:crew-opencode`

**特点**：这些 agent **只做一件事**——调用 companion 脚本并**原样返回 stdout**。不读文件、不总结、不做额外工作。

### 直接在 Agent 工具中使用（示例）
```xml
<use_tool>
<tool_name>Agent</tool_name>
<parameters>
<subagent_type>crew:crew-grok</subagent_type>
<task>审查当前登录模块的安全问题</task>
<run_in_background>true</run_in_background>
</parameters>
</use_tool>
```

### 典型编排模式

**并行 fan-out**（race 类似）：
同时调用 `crew:crew-omp`、`crew:crew-grok`、`crew:crew-agy`，然后在主会话汇总。

**串行 pipeline**：
先 `crew:crew-omp`（impl）→ 然后把输出 + diff 喂给 `crew:crew-grok`（review）。

**Judge / 选择器**：
跑多个 → 让 Claude Code 或另一个 agent 挑最好的。

**带 resume 的复杂流程**：
```xml
<!-- 第一次 -->
<use_tool>
<subagent_type>crew:crew-opencode</subagent_type>
<task>实现功能 X</task>
</use_tool>

<!-- 后面追问（需要从上一步拿到 id 或让 runner 记录） -->
<use_tool>
<subagent_type>crew:crew-opencode</subagent_type>
<task>继续上一步，修复 review 指出的问题</task>
<!-- 实际续跑由 companion 的 --resume 机制或 send 命令处理 -->
</use_tool>
```

**推荐**：复杂编排时优先用 `/crew:race` 和 `/crew:pipeline`。`/crew:pipeline` 内部编排多个 subagent，负责实现→审查→修复循环及 review 只读语义。worktree 隔离由 `/crew:race --write` 自动处理，或由 `/crew:omp` 等委派命令的 `--worktree` 提供。

**直接使用具名 agent** 的好处：
- Workflow / 自定义 agent 可以 fan-out。
- 精确控制哪家 CLI 执行哪一步。
- 后台：Agent 工具的 `run_in_background: true` 生效；`--worktree`、`--resume` 等 companion 旗标需经 `/crew:omp` 等斜杠命令路由，或在 `task` 文本里写明由主会话转发给 `crew:crew-runner`

## 已知问题 & 注意事项

1. **agy 的 -p（headless/print）模式 token 过期**
   - agy 在非交互 `-p` 模式下，认证 token 有时会过期。
   - **解决**：手动在终端运行一次交互式 `agy`（或 `agy login` / 相应刷新命令），完成浏览器/终端登录后，headless 模式才能继续使用。
   - crew 不会自动处理 agy 认证。

2. **agy 不支持事件流（progress 解析有限）**
   - 后台 agy 任务的 `/crew:progress` 只能显示最后几行原始输出，没有结构化“思考/工具/成本”。
   - 其他 CLI（omp/grok/opencode）支持 JSON streaming，progress 更丰富。

3. **worktree 清理**
   - 用完隔离 worktree 后需手动清理：
     ```bash
     git worktree list
     git worktree remove /path/to/.crew/worktrees/c-xxx
     ```
   - 插件不会自动删除。

4. **长时间任务超时**
   - 前台任务 companion 设置 10 分钟 timeout（600000ms）。
   - 预计更长 → 必须加 `--background`。

5. **resume 行为差异**
   - omp / opencode / grok：有 `sessionId` 时用 `-r` / `-s` 精确续跑（最可靠）；grok 无 `sessionId` 时退化为 `-c`。
   - agy：resume 固定 `--continue`，依赖该任务目录下的最近会话，不如精确 `sessionId` 稳定。

6. **权限与危险操作**
   - agy 默认加 `--dangerously-skip-permissions`（非 review 模式）。
   - grok 用 `--permission-mode acceptEdits`。
   - review 模式永远不会让任何 CLI 改文件。

7. **状态文件损坏**
   - 如遇异常，可手动清理 `~/.crew/jobs/` 下的旧 json（谨慎）。

8. **CLI 版本兼容**
   - 各 CLI 的无头参数（`-p`、`-r`、`-c`、JSON 格式）可能随版本变化。遇到问题先 `/crew:setup` 确认版本，并更新对应 CLI。

## 最佳实践建议

- 长任务一律 `--background --worktree`。
- 写代码前先 `/crew:review --by grok` 看当前状态。
- 重要改动用 `race --write` 让多家比对。
- 质量关键路径用 `pipeline --rounds 2+`。
- 追问时用 `/crew:send`，不要重新贴整段历史。
- 定期 `/crew:setup` 检查环境。
- 想用在自定义 Workflow → 直接引用 `crew:crew-*` subagent。

---

**反馈与贡献**  
本指南基于 `plugins/crew/` 下所有命令、agent 定义和 `crew-companion.mjs` 的源码注释与参数解析逻辑编写（v0.4.0）。

直接在 Claude Code 里尝试第一个命令：
```bash
/crew:setup
```

祝使用愉快！把复杂任务交给 crew，让 Claude Code 专注编排。