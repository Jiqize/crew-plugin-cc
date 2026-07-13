#!/usr/bin/env node
// crew-companion —— crew 插件的确定性运行时。
// 统一调用 omp/grok/agy/opencode 的无头模式，提供后台任务管理（status/result/cancel）、
// 会话续跑记录（resume-candidate）和 git worktree 隔离。命令由本脚本拼装，不靠模型现场拼。
import { spawn, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const SELF = fileURLToPath(import.meta.url);
const STATE_DIR = path.join(os.homedir(), ".crew");
const JOBS_DIR = path.join(STATE_DIR, "jobs");
const WT_DIR = path.join(STATE_DIR, "worktrees");
const STATE_FILE = path.join(STATE_DIR, "state.json");
const CLIS = ["omp", "grok", "agy", "opencode"];

function fail(msg) {
  console.error(`[crew] ${msg}`);
  process.exit(1);
}

function ensureDirs() {
  fs.mkdirSync(JOBS_DIR, { recursive: true });
  // 顺手清理 7 天前的已结束任务记录
  const cutoff = Date.now() - 7 * 86400e3;
  for (const f of fs.readdirSync(JOBS_DIR)) {
    if (!f.endsWith(".json")) continue;
    const j = readJson(path.join(JOBS_DIR, f), null);
    if (j && j.status !== "running" && new Date(j.startedAt).getTime() < cutoff) {
      try { fs.unlinkSync(path.join(JOBS_DIR, f)); } catch {}
      try { fs.unlinkSync(j.logFile); } catch {}
    }
  }
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2));
}

function jobFile(id) {
  return path.join(JOBS_DIR, `${id}.json`);
}

function binaryAvailable(cli) {
  return spawnSync("which", [cli], { encoding: "utf8" }).status === 0;
}

// 会话状态按 git 仓库根目录（无仓库则按 cwd）归档
function repoKey(cwd) {
  const r = spawnSync("git", ["rev-parse", "--show-toplevel"], { cwd, encoding: "utf8" });
  return r.status === 0 ? r.stdout.trim() : cwd;
}

// 解析 argv：子命令 + 旗标 + `--` 之后的任务文本
function parseArgs(argv) {
  const [cmd, ...rest] = argv;
  const opts = { _: [] };
  let i = 0;
  while (i < rest.length) {
    const a = rest[i];
    if (a === "--") {
      opts.task = rest.slice(i + 1).join(" ");
      break;
    }
    if (a.startsWith("--")) {
      const key = a.slice(2);
      if (key === "cli" || key === "model" || key === "cwd" || key === "agent" || key === "squad" || key === "run") opts[key] = rest[++i];
      else if (key === "reasoning-effort") opts.reasoningEffort = rest[++i];
      else if (key === "rules") opts.rules = rest[++i];
      else if (key === "system-prompt-override") opts.systemPromptOverride = rest[++i];
      else opts[key] = true;
    } else {
      opts._.push(a);
    }
    i++;
  }
  // --task-stdin：从 stdin 读任务文本（heredoc 传入，避免多行文本被 shell 换行截断）
  if (opts["task-stdin"] && !opts.task) {
    try { opts.task = fs.readFileSync(0, "utf8").trim(); } catch {}
  }
  return { cmd, opts };
}

// 各 CLI 的无头调用映射（review 为只读语义）。
// stream 打开各家的 JSON 事件流（供 progress/result 解析）；sessionId 用于精确续跑（omp/opencode 支持）。
function buildArgv(cli, { review, resume, sessionId, model, task, stream, reasoningEffort, rules, systemPromptOverride, agentInstructions }) {
  // 人设注入矩阵：grok 走 --rules（用户已显式给 --rules 时让位，改走 task 前缀）；
  // omp/agy/opencode 恒走 task 前缀——omp 的 --append-system-prompt 实测内容可注入，
  // 但追加在 ~44k 系统提示末尾行为约束不生效（2026-07-13 冒烟），故不用。
  // review 只读前缀仍拼在最外层。
  const personaViaFlag = cli === "grok" && !rules;
  const withPersona = agentInstructions && !personaViaFlag
    ? `# Agent persona (follow strictly)\n\n${agentInstructions}\n\n---\n\n# Task\n\n${task}`
    : task;
  const t = review
    ? `Read-only review task. Do NOT modify, create, or delete any files.\n\n${withPersona}`
    : withPersona;
  switch (cli) {
    case "omp":
      // 显式 --auto-approve：不依赖各机器的 approvalMode 配置（always-ask 会让无头模式挂死）
      return [
        "omp", "-p", "--auto-approve",
        ...(stream ? ["--mode", "json"] : []),
        ...(resume ? (sessionId ? ["-r", sessionId] : ["-c"]) : []),
        ...(model ? ["--model", model] : []),
        t
      ];
    case "grok":
      // delegate 必须 bypassPermissions：acceptEdits 只自动批文件编辑，终端命令会等审批，
      // 无头模式下约 60s 超时导致整个回合被 Cancelled（退出码仍为 0）
      // reasoning-effort 优先级：用户显式 > review 保持满推理（不加） > 写操作默认 low
      const eff = reasoningEffort || (!review ? "low" : "");
      return [
        "grok", "-p", t,
        "--permission-mode", review ? "plan" : "bypassPermissions",
        ...(stream ? ["--output-format", "streaming-json"] : []),
        ...(resume ? (sessionId ? ["-r", sessionId] : ["-c"]) : []),
        ...(model ? ["--model", model] : []),
        ...(eff ? ["--reasoning-effort", eff] : []),
        ...(rules ? ["--rules", rules] : agentInstructions ? ["--rules", agentInstructions] : []),
        ...(systemPromptOverride ? ["--system-prompt-override", systemPromptOverride] : [])
      ];
    case "agy":
      // --new-project 必须加：agy 的 print 模式默认跑在"上次活跃项目"目录而非 cwd（实测跑错仓库）。
      // review 也要 skip-permissions：否则命令被静默拒绝后 agy 会编造答案；只读靠 prompt 前缀约束。
      // 注意 --new-project 与 --continue 互斥，续跑时不加。
      return [
        "agy", "-p", t, "--print-timeout", "30m",
        "--dangerously-skip-permissions",
        ...(resume ? ["--continue"] : ["--new-project"]),
        ...(model ? ["--model", model] : [])
      ];
    case "opencode":
      return [
        "opencode", "run", t,
        ...(review ? [] : ["--auto"]),
        ...(stream ? ["--format", "json"] : []),
        ...(resume ? (sessionId ? ["-s", sessionId] : ["-c"]) : []),
        ...(model ? ["-m", model] : [])
      ];
    default:
      throw new Error(`unknown cli: ${cli}`);
  }
}

// 解析各 CLI 的 JSON 事件日志 → 活动轨迹 / 最终回答 / 会话 id / 成本
function parseEvents(cli, text) {
  const lines = text.split(/\r?\n/).filter(Boolean);
  const activities = [];
  let finalText = "";
  let sessionId = null;
  let cost = null;
  let stopReason = null;
  const push = (s) => {
    if (s && s.trim()) activities.push(s.replace(/\s+/g, " ").trim().slice(0, 120));
  };
  if (cli === "grok") {
    let thought = "";
    let answer = "";
    for (const l of lines) {
      let e;
      try { e = JSON.parse(l); } catch { continue; }
      if (e.type === "thought") thought += e.data || "";
      else if (e.type === "text") answer += e.data || "";
      else {
        if (e.sessionId) sessionId = e.sessionId;
        if (e.type === "end" && e.stopReason) stopReason = e.stopReason;
        const c = e.usage?.cost?.total ?? e.usage?.cost;
        if (typeof c === "number") cost = (cost || 0) + c;
        else if (e.type === "end" && e.usage && cost == null) cost = 0; // 订阅制：end 有用量但全程无金额，按 $0 入账（同 omp 口径）
        push(`[${e.type}] ${JSON.stringify(e).slice(0, 100)}`);
      }
    }
    if (thought) push(`思考: ${thought.slice(0, 100)}`);
    if (answer) push(`输出: ${answer.slice(0, 100)}`);
    finalText = answer;
  } else if (cli === "omp") {
    for (const l of lines) {
      let e;
      try { e = JSON.parse(l); } catch { continue; }
      if (e.type === "session") sessionId = e.id;
      else if (e.type === "message_end" && e.message?.role === "assistant") {
        const mc = e.message.usage?.cost?.total;
        if (typeof mc === "number") cost = (cost || 0) + mc; // 订阅制 provider 报 0 也是合法成本
        for (const c of e.message.content || []) {
          if (c.type === "thinking") push(`思考: ${c.thinking}`);
          else if (c.type === "toolCall") push(`工具 ${c.name}: ${JSON.stringify(c.arguments ?? {})}`);
          else if (c.type === "text") { finalText = c.text || ""; push(`输出: ${c.text}`); }
        }
      }
    }
  } else if (cli === "opencode") {
    for (const l of lines) {
      let e;
      try { e = JSON.parse(l); } catch { continue; }
      if (e.sessionID) sessionId = e.sessionID;
      const p = e.part || {};
      if (e.type === "tool_use") push(`工具 ${p.tool || "?"}${p.state?.status ? ` (${p.state.status})` : ""}`);
      else if (e.type === "text") { finalText += (finalText ? "\n" : "") + (p.text || ""); push(`输出: ${p.text}`); }
      else if (e.type === "step_finish" && p.cost != null) cost = (cost || 0) + p.cost;
    }
  } else {
    // agy 等无事件流的 CLI：原文即结果
    finalText = text.trim();
    for (const l of lines.slice(-10)) push(l);
  }
  if (cost != null) push(`成本: $${cost.toFixed(4)}`);
  return { activities, finalText: finalText.trim(), sessionId, cost, stopReason };
}

// 已知故障模式 → 给用户的修复提示
function diagnose(logText) {
  const hints = [];
  if (/authentication failed/i.test(logText)) {
    hints.push("agy 会话过期：在终端交互式跑一次 agy 完成登录即可恢复");
  }
  if (/ConnectionRefused.*mcp|Transport channel closed/i.test(logText)) {
    hints.push("有 MCP server 连不上（grok 会继承 ~/.claude.json 的 mcpServers）。此错误本身不影响任务，可清理对应 MCP 配置消除噪音");
  }
  if (/run_terminal_command/i.test(logText) && /"stopReason":"Cancelled"/.test(logText)) {
    hints.push("grok 回合在等待终端命令审批时超时被取消：确认 companion 是新版（delegate 用 bypassPermissions）；review 模式（plan）本就禁止执行命令，属预期");
  }
  return hints;
}

// 从日志中提取并回写会话 id
function captureSession(job) {
  if (job.sessionId || !fs.existsSync(job.logFile)) return job;
  const parsed = parseEvents(job.stream ? job.cli : "_plain", fs.readFileSync(job.logFile, "utf8"));
  if (parsed.sessionId) {
    job.sessionId = parsed.sessionId;
    writeJson(jobFile(job.id), job);
  }
  return job;
}

// multicrew 看板集成：向项目级 .multicrew/events.jsonl 发事件。
// 非侵入约定：multicrew 未安装/出错/被禁用（MULTICREW_DISABLE=1）一律静默跳过，绝不影响 crew 主流程。
function emitMulticrew(job, args) {
  if (process.env.MULTICREW_DISABLE === "1") return;
  if (!job.launchCwd) return;
  try {
    spawnSync("multicrew", ["task", ...args, "--dir", job.launchCwd], { stdio: "ignore" });
  } catch {}
}

// 创建任务记录并派生 worker。前台/后台统一走这里：每次运行都有任务 id，因此都能被 send 追问。
// 前台模式轮询等待完成后渲染结果；即使本进程被杀（如 Bash 超时），worker 仍在后台继续，可用 /crew:result 取回。
async function runJob(fields, { background }) {
  ensureDirs();
  const job = {
    status: "running",
    startedAt: new Date().toISOString(),
    logFile: path.join(JOBS_DIR, `${fields.id}.log`),
    notify: !!background,
    ...fields
  };
  writeJson(jobFile(job.id), job);
  emitMulticrew(job, ["create", "--id", job.id, "--title", job.task.slice(0, 80), "--executor", job.cli, ...(job.agent ? ["--agent", job.agent] : []), ...(job.squad ? ["--squad", job.squad, "--run", job.squadRun] : []), "--start"]);
  // 派发留痕：CLI 进程启动之前落 dispatched 审计事件（best-effort，同 emitMulticrew 语义）
  emitMulticrew(job, [
    "dispatch", job.id, "--cli", job.cli,
    "--argv-json", JSON.stringify(job.auditArgv ?? job.argv),
    "--cwd", job.cwd, "--job-id", job.id,
    ...(job.model ? ["--model", job.model] : []),
    ...(job.reasoningEffort ? ["--reasoning-effort", job.reasoningEffort] : []),
    ...(job.agent ? ["--agent", job.agent] : []),
    ...(job.agentHash ? ["--agent-hash", job.agentHash] : [])
  ]);
  const child = spawn(process.execPath, [SELF, "_exec", job.id], { detached: true, stdio: "ignore" });
  child.unref();
  if (background) {
    console.log(`已启动后台任务 ${job.id}（${job.cli}/${job.mode}）。`);
    console.log(`看进度 /crew:progress ${job.id}，取结果 /crew:result ${job.id}，取消 /crew:cancel ${job.id}。`);
    if (job.worktree) console.log(`隔离 worktree：${job.worktree}`);
    return;
  }
  for (;;) {
    await new Promise((r) => setTimeout(r, 500));
    const j = readJson(jobFile(job.id), null);
    if (!j) process.exit(1);
    if (j.status === "running" && j.workerPid && !isAlive(j.workerPid)) {
      j.status = "interrupted";
      writeJson(jobFile(job.id), j);
      emitMulticrew(j, ["fail", j.id, "--reason", "worker process died (interrupted)"]);
    }
    if (j.status === "running") continue;
    const log = fs.existsSync(j.logFile) ? fs.readFileSync(j.logFile, "utf8").trim() : "";
    if (j.stream) {
      const parsed = parseEvents(j.cli, log);
      console.log(parsed.finalText || log || "（无输出）");
      if (parsed.cost != null) console.log(`\n[crew] 成本：$${parsed.cost.toFixed(4)}`);
    } else {
      console.log(log || "（无输出）");
    }
    console.log(`[crew] 任务 ${j.id} ${j.status}，追问用 /crew:send ${j.id} -- <消息>。`);
    if (j.failReason) console.log(`[crew] ⚠️ ${j.failReason}`);
    for (const h of j.status !== "done" || j.failReason ? diagnose(log) : []) console.log(`[crew] 提示：${h}`);
    if (j.worktree) console.log(`[crew] 改动在隔离 worktree：${j.worktree}（确认后自行合并，清理用 git worktree remove）`);
    process.exit(j.status === "done" ? (j.exitCode ?? 0) : 1);
  }
}

// 任务收尾：识别假成功、提取会话 id 回写状态、记账、桌面通知（在 worker 里执行）
function finalizeJob(job) {
  try {
    const log = fs.existsSync(job.logFile) ? fs.readFileSync(job.logFile, "utf8") : "";
    const parsed = parseEvents(job.stream ? job.cli : "_plain", log);
    // 假成功识别：退出码 0 但回合被取消/出错，或委派任务没有任何最终产出
    if (job.status === "done" && parsed.stopReason && !/^(EndTurn|stop|end_turn)$/i.test(parsed.stopReason)) {
      job.status = "failed";
      job.failReason = `回合被终止（stopReason: ${parsed.stopReason}），任务可能没有真正执行`;
    } else if (job.status === "done" && job.stream && !parsed.finalText) {
      job.failReason = "没有解析到最终回答，结果存疑，建议核对";
    }
    if (job.failReason) writeJson(jobFile(job.id), job);
    // 回写解析成本（供 multicrew done --cost 与状态记录使用），非数值不写
    if (typeof parsed.cost === "number") {
      job.cost = parsed.cost;
      writeJson(jobFile(job.id), job);
    }
    if (parsed.sessionId) {
      job.sessionId = parsed.sessionId;
      writeJson(jobFile(job.id), job);
      if (job.repoKey) {
        const state = readJson(STATE_FILE, {});
        state[job.repoKey] = state[job.repoKey] || {};
        state[job.repoKey][job.cli] = { ...state[job.repoKey][job.cli], sessionId: parsed.sessionId };
        writeJson(STATE_FILE, state);
      }
    }
    fs.appendFileSync(path.join(STATE_DIR, "costs.jsonl"), JSON.stringify({
      at: job.endedAt, id: job.id, cli: job.cli, mode: job.mode, status: job.status,
      cost: parsed.cost, task: job.task.slice(0, 80)
    }) + "\n");
    if (job.notify && process.platform === "darwin") {
      const msg = `${job.cli} ${job.status === "done" ? "完成 ✓" : job.status}：${job.task.slice(0, 60)}`;
      spawnSync("osascript", ["-e", `display notification ${JSON.stringify(msg)} with title "crew" subtitle ${JSON.stringify(job.id)}`]);
    }
  } catch {}
}

function markSession(cwd, cli, task) {
  const state = readJson(STATE_FILE, {});
  const key = repoKey(cwd);
  state[key] = state[key] || {};
  // 保留已记录的 sessionId（任务收尾时由 finalizeJob 更新）
  state[key][cli] = { ...state[key][cli], lastRunAt: new Date().toISOString(), lastTask: task.slice(0, 200) };
  writeJson(STATE_FILE, state);
}

function makeWorktree(cwd, id) {
  fs.mkdirSync(WT_DIR, { recursive: true });
  const dir = path.join(WT_DIR, id);
  const r = spawnSync("git", ["worktree", "add", dir, "HEAD"], { cwd, encoding: "utf8" });
  if (r.status !== 0) fail(`git worktree add 失败：${r.stderr.trim()}`);
  return dir;
}

// 审计引用替换：人设 instructions 全文 → 占位符（含内容哈希前 12 位与原文字符数）。
// 凡包含 instructions 全文的 argv 元素（grok --rules 值、前缀注入后的 task 文本）统一被替换，task 原文照存。
function redactArgv(argv, instructions) {
  const hash12 = crypto.createHash("sha256").update(instructions, "utf8").digest("hex").slice(0, 12);
  const placeholder = `[agent-instructions sha256:${hash12} ${instructions.length} chars]`;
  return { agentHash: hash12, auditArgv: argv.map((el) => el.split(instructions).join(placeholder)) };
}

// --agent 预设解析：显式引用必须生效，任何失败都报错退出、不建 job、不写任务事件
// （与 emitMulticrew 的静默吞错语义相反——那是隐式记账）
function resolveAgentPreset(id) {
  let r;
  try {
    r = spawnSync("multicrew", ["agent", "show", id, "--json"], { encoding: "utf8" });
  } catch (e) {
    fail(`multicrew 调用失败（预设 ${id}）：${e.message}`);
  }
  if (r.error) fail(`multicrew 未安装或不可执行（--agent 需要 multicrew）：${r.error.message}`);
  let parsed;
  try {
    parsed = JSON.parse(r.stdout);
  } catch {
    fail(`multicrew agent show ${id} 输出无法解析：${(r.stdout || r.stderr || "").trim().slice(0, 200)}`);
  }
  if (r.status !== 0 || parsed.error) {
    fail(`预设 ${id} 解析失败：${parsed?.error?.message || (r.stderr || "").trim() || `exit ${r.status}`}`);
  }
  if (!parsed.instructions) fail(`预设 ${id} 没有 instructions 正文`);
  return parsed;
}

// --squad 预设解析：镜像 resolveAgentPreset 的失败语义（显式引用必须生效）。
// 只做存在性与状态校验，squad 内容不注入任务文本。
function resolveSquadPreset(id) {
  let r;
  try {
    r = spawnSync("multicrew", ["squad", "show", id, "--json"], { encoding: "utf8" });
  } catch (e) {
    fail(`multicrew 调用失败（squad ${id}）：${e.message}`);
  }
  if (r.error) fail(`multicrew 未安装或不可执行（--squad 需要 multicrew）：${r.error.message}`);
  let parsed;
  try {
    parsed = JSON.parse(r.stdout);
  } catch {
    fail(`multicrew squad show ${id} 输出无法解析：${(r.stdout || r.stderr || "").trim().slice(0, 200)}`);
  }
  if (r.status !== 0 || parsed.error) {
    fail(`squad ${id} 解析失败：${parsed?.error?.message || (r.stderr || "").trim() || `exit ${r.status}`}`);
  }
  return parsed;
}

function cmdRun(opts) {
  // squad 归组：run id 由编排者铸造，crew 不代铸
  if (opts.squad && !opts.run) fail("--squad 需要显式 --run <rid>（run id 由编排者铸造，可先 multicrew task create --squad 获取）");
  if (opts.run && !opts.squad) fail("--run 需要 --squad");
  if (opts.squad) resolveSquadPreset(opts.squad);
  // 预设缺省值合并：命令行显式旗标优先于预设
  const preset = opts.agent ? resolveAgentPreset(opts.agent) : null;
  const cli = opts.cli || preset?.cli;
  if (!CLIS.includes(cli)) fail(`--cli 必须是 ${CLIS.join("/")} 之一`);
  if (!binaryAvailable(cli)) fail(`${cli} 未安装或不在 PATH，先运行 /crew:setup`);
  if (!opts.task) fail("缺少任务文本（用 --task-stdin 从 heredoc 传入，或放在 -- 之后）");

  const launchCwd = opts.cwd ? path.resolve(opts.cwd) : process.cwd();
  if (opts.cwd && !fs.existsSync(launchCwd)) fail(`--cwd 目录不存在：${launchCwd}`);
  const key = repoKey(launchCwd);
  const id = "c-" + crypto.randomBytes(3).toString("hex");
  let cwd = launchCwd;
  let worktree = null;
  if (opts.worktree) {
    worktree = makeWorktree(launchCwd, id);
    cwd = worktree;
  }
  // 支持 JSON 事件流的 CLI 一律走流式日志（前后台统一），供 progress/result/send 解析
  const stream = cli !== "agy";
  // --resume 时优先用状态里记录的精确会话 id
  const prev = readJson(STATE_FILE, {})[key]?.[cli];
  // 合并后的 model/reasoningEffort：显式旗标优先于预设（供 buildArgv 与审计落账共用）
  const model = opts.model || preset?.model;
  const reasoningEffort = opts.reasoningEffort || preset?.reasoning_effort;
  const argv = buildArgv(cli, {
    review: !!opts.review,
    resume: !!opts.resume,
    sessionId: opts.resume ? prev?.sessionId : undefined,
    model,
    reasoningEffort,
    rules: opts.rules,
    systemPromptOverride: opts.systemPromptOverride,
    task: opts.task,
    stream,
    agentInstructions: preset?.instructions
  });
  // 审计视图：有预设时人设全文替换为引用占位符；原始 argv 不变供 _exec 执行
  const redacted = preset ? redactArgv(argv, preset.instructions) : { auditArgv: argv };
  markSession(launchCwd, cli, opts.task);
  runJob({
    id, cli,
    mode: opts.review ? "review" : "delegate",
    task: opts.task.slice(0, 500),
    // launchCwd 供 multicrew 定位项目级 ledger：worktree 任务也用发起目录（看板在主仓库看）
    cwd, worktree, argv, stream, launchCwd,
    auditArgv: redacted.auditArgv,
    ...(model ? { model } : {}),
    ...(reasoningEffort ? { reasoningEffort } : {}),
    repoKey: key,
    ...(opts.squad ? { squad: opts.squad, squadRun: opts.run } : {}),
    ...(preset ? { agent: preset.id, agentInstructions: preset.instructions, agentHash: redacted.agentHash } : {})
  }, { background: !!opts.background });
}

// 后台 worker：真正跑 CLI 并把输出写进日志、退出后回写状态
function cmdExec(id) {
  const jf = jobFile(id);
  const job = readJson(jf, null);
  if (!job) process.exit(1);
  job.workerPid = process.pid;
  writeJson(jf, job);
  const out = fs.openSync(job.logFile, "a");
  const child = spawn(job.argv[0], job.argv.slice(1), { cwd: job.cwd, stdio: ["ignore", out, out] });
  job.cliPid = child.pid;
  writeJson(jf, job);
  // 心跳：日志有增长才发 progress（size 单调递增保证语义 ID 不重复；无增长不发，配合看板 stalled 判定）
  let lastLogSize = 0;
  const heartbeat = setInterval(() => {
    try {
      const size = fs.statSync(job.logFile).size;
      if (size > lastLogSize) {
        lastLogSize = size;
        emitMulticrew(job, ["log", job.id, `output grew to ${size}B`]);
      }
    } catch {}
  }, 60000);
  heartbeat.unref();
  child.on("exit", (code) => {
    job.status = code === 0 ? "done" : "failed";
    job.exitCode = code;
    job.endedAt = new Date().toISOString();
    writeJson(jf, job);
    finalizeJob(job); // 可能把假成功改判 failed、回写 job.cost
    if (job.status === "done") {
      emitMulticrew(job, ["done", job.id, ...(typeof job.cost === "number" ? ["--cost", String(job.cost)] : [])]);
    } else {
      emitMulticrew(job, [
        "fail", job.id, "--reason", job.failReason || `exit code ${code}`,
        ...(Number.isInteger(code) ? ["--exit-code", String(code)] : [])
      ]);
    }
    process.exit(0);
  });
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function loadJobs(idArg) {
  ensureDirs();
  let jobs = fs.readdirSync(JOBS_DIR)
    .filter((f) => f.endsWith(".json"))
    .map((f) => readJson(path.join(JOBS_DIR, f), null))
    .filter(Boolean);
  // worker 已死但状态还是 running 的，标记为 interrupted
  for (const j of jobs) {
    if (j.status === "running" && j.workerPid && !isAlive(j.workerPid)) {
      j.status = "interrupted";
      writeJson(jobFile(j.id), j);
    }
  }
  if (idArg) jobs = jobs.filter((j) => j.id === idArg);
  jobs.sort((a, b) => (b.startedAt || "").localeCompare(a.startedAt || ""));
  return jobs;
}

function cmdStatus(idArg, asJson) {
  const jobs = loadJobs(idArg);
  if (asJson) return console.log(JSON.stringify(jobs, null, 2));
  if (!jobs.length) return console.log(idArg ? `没有任务 ${idArg}。` : "没有后台任务。");
  for (const j of jobs) {
    console.log(`${j.id}  ${j.status.padEnd(11)}  ${j.cli}/${j.mode}  ${j.startedAt}  ${j.task.slice(0, 80)}`);
  }
}

function cmdResult(idArg) {
  const jobs = loadJobs(idArg);
  if (!jobs.length) return fail(idArg ? `没有任务 ${idArg}` : "没有后台任务");
  const job = captureSession(jobs[0]); // 不带 id 则取最近一个
  console.log(`[crew] ${job.id}  ${job.status}  ${job.cli}/${job.mode}  ${job.task.slice(0, 100)}`);
  if (job.worktree) console.log(`[crew] 隔离 worktree：${job.worktree}`);
  const log = fs.existsSync(job.logFile) ? fs.readFileSync(job.logFile, "utf8").trim() : "";
  if (job.stream) {
    const parsed = parseEvents(job.cli, log);
    console.log(parsed.finalText || "（暂无最终回答）");
    if (parsed.cost != null) console.log(`\n[crew] 成本：$${parsed.cost.toFixed(4)}`);
    console.log(`[crew] 原始事件日志：${job.logFile}`);
  } else {
    console.log(log || "（暂无输出）");
  }
  if (job.failReason) console.log(`[crew] ⚠️ ${job.failReason}`);
  if (job.status !== "done" || job.failReason) for (const h of diagnose(log)) console.log(`[crew] 提示：${h}`);
  if (job.status === "running") console.log("\n[crew] 任务仍在运行，用 /crew:progress 看它正在干嘛。");
}

// 实时进度：解析事件日志，显示任务正在/刚刚做什么
function cmdProgress(idArg) {
  const jobs = loadJobs(idArg);
  if (!jobs.length) return fail(idArg ? `没有任务 ${idArg}` : "没有后台任务");
  const job = captureSession(jobs[0]);
  const end = job.endedAt ? new Date(job.endedAt) : new Date();
  const elapsed = Math.round((end - new Date(job.startedAt)) / 1000);
  console.log(`[crew] ${job.id}  ${job.status}  ${job.cli}/${job.mode}  已运行 ${elapsed}s`);
  console.log(`[crew] 任务：${job.task.slice(0, 100)}`);
  if (job.sessionId) console.log(`[crew] 会话：${job.sessionId}`);
  const log = fs.existsSync(job.logFile) ? fs.readFileSync(job.logFile, "utf8") : "";
  const parsed = parseEvents(job.stream ? job.cli : "_plain", log);
  const recent = parsed.activities.slice(-12);
  console.log(recent.length ? "\n最近活动：" : "\n（还没有活动输出）");
  for (const a of recent) console.log(`  ${a}`);
  if (job.failReason) console.log(`\n[crew] ⚠️ ${job.failReason}`);
  if (job.status !== "done" || job.failReason) for (const h of diagnose(log)) console.log(`[crew] 提示：${h}`);
  if (job.status === "running") console.log("\n[crew] 仍在运行，再次 /crew:progress 可刷新。");
}

// 追问：向已结束任务的会话追加一条消息（omp/grok/opencode 捕获到会话 id 时精确续跑）。
// v0.5 起前台运行也有任务记录，因此任何一次运行都可追问。
function cmdSend(opts) {
  const jobs = loadJobs(opts._[0]);
  if (!jobs.length) return fail("没有可追问的任务");
  const job = captureSession(jobs[0]);
  if (!opts.task) return fail("缺少追问内容（放在 -- 之后）");
  if (job.status === "running") return fail(`任务 ${job.id} 还在运行，等它结束（/crew:progress 看进度）或先 /crew:cancel`);
  const stream = job.cli !== "agy";
  const argv = buildArgv(job.cli, {
    review: job.mode === "review",
    resume: true,
    sessionId: job.sessionId,
    model: opts.model,
    reasoningEffort: opts.reasoningEffort,
    rules: opts.rules,
    systemPromptOverride: opts.systemPromptOverride,
    task: opts.task,
    stream
  });
  markSession(job.cwd, job.cli, opts.task);
  runJob({
    id: "c-" + crypto.randomBytes(3).toString("hex"),
    cli: job.cli,
    mode: job.mode,
    task: opts.task.slice(0, 500),
    cwd: job.cwd,
    worktree: job.worktree,
    parent: job.id,
    argv, stream,
    repoKey: job.repoKey || repoKey(job.cwd)
  }, { background: !!opts.background });
}

// 成本台账：按天/按 CLI 汇总各任务成本（数据来自 finalizeJob 写入的 costs.jsonl）
function cmdCosts() {
  const file = path.join(STATE_DIR, "costs.jsonl");
  if (!fs.existsSync(file)) return console.log("还没有任务记账。");
  const rows = fs.readFileSync(file, "utf8").split("\n").filter(Boolean)
    .map((l) => { try { return JSON.parse(l); } catch { return null; } })
    .filter(Boolean);
  const agg = (list) => {
    const per = {};
    for (const r of list) {
      per[r.cli] = per[r.cli] || { runs: 0, cost: 0, unknown: 0 };
      per[r.cli].runs++;
      if (typeof r.cost === "number") per[r.cli].cost += r.cost;
      else per[r.cli].unknown++;
    }
    return per;
  };
  const fmt = (per) => Object.entries(per).map(([cli, v]) =>
    `  ${cli.padEnd(9)} ${String(v.runs).padStart(3)} 次  $${v.cost.toFixed(4)}${v.unknown ? `（${v.unknown} 次成本未知）` : ""}`
  ).join("\n");
  const today = new Date().toISOString().slice(0, 10);
  const todayRows = rows.filter((r) => (r.at || "").slice(0, 10) === today);
  console.log(`今天（${today}）：${todayRows.length ? "\n" + fmt(agg(todayRows)) : "无任务"}`);
  console.log(`\n累计（${rows.length} 次）：\n${fmt(agg(rows))}`);
}

function cmdCancel(idArg) {
  const jobs = loadJobs(idArg);
  const job = jobs.find((j) => j.status === "running");
  if (!job) return fail(idArg ? `任务 ${idArg} 不在运行中` : "没有运行中的后台任务");
  try {
    process.kill(-job.workerPid, "SIGTERM"); // worker 是进程组组长，连 CLI 一起杀
  } catch {
    if (job.cliPid) try { process.kill(job.cliPid, "SIGTERM"); } catch {}
  }
  job.status = "canceled";
  job.endedAt = new Date().toISOString();
  writeJson(jobFile(job.id), job);
  // 与 worker exit handler 的 fail 存在竞态属预期：账本以第一个终态为准，后到的被 TASK_ALREADY_TERMINAL 静默拒收
  emitMulticrew(job, ["cancel", job.id]);
  console.log(`已取消 ${job.id}（${job.cli}）。`);
}

function cmdResumeCandidate(opts) {
  const cli = opts.cli;
  if (!CLIS.includes(cli)) fail(`--cli 必须是 ${CLIS.join("/")} 之一`);
  const state = readJson(STATE_FILE, {});
  const entry = state[repoKey(process.cwd())]?.[cli] || null;
  const result = entry
    ? { available: true, cli, lastRunAt: entry.lastRunAt, lastTask: entry.lastTask }
    : { available: false, cli };
  console.log(JSON.stringify(result, null, 2));
}

function cmdSetup() {
  for (const cli of CLIS) {
    const p = spawnSync("which", [cli], { encoding: "utf8" }).stdout.trim();
    if (!p) {
      console.log(`MISSING|${cli}||`);
      continue;
    }
    const v = spawnSync(cli, ["--version"], { encoding: "utf8", timeout: 10000 });
    const version = (v.stdout || v.stderr || "").split("\n")[0].trim();
    console.log(`OK|${cli}|${p}|${version}`);
  }
}

const { cmd, opts } = parseArgs(process.argv.slice(2));
switch (cmd) {
  case "run": cmdRun(opts); break;
  case "_exec": cmdExec(opts._[0]); break;
  case "status": cmdStatus(opts._[0], !!opts.json); break;
  case "result": cmdResult(opts._[0]); break;
  case "progress": cmdProgress(opts._[0]); break;
  case "send": cmdSend(opts); break;
  case "costs": cmdCosts(); break;
  case "cancel": cmdCancel(opts._[0]); break;
  case "resume-candidate": cmdResumeCandidate(opts); break;
  case "setup": cmdSetup(); break;
  default:
    console.log("用法: crew-companion.mjs <run|status|result|progress|send|costs|cancel|resume-candidate|setup> [flags] [-- task]");
    process.exit(cmd ? 1 : 0);
}
