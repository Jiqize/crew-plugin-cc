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
      if (key === "cli" || key === "model" || key === "cwd") opts[key] = rest[++i];
      else opts[key] = true;
    } else {
      opts._.push(a);
    }
    i++;
  }
  return { cmd, opts };
}

// 各 CLI 的无头调用映射（review 为只读语义）。
// stream 打开各家的 JSON 事件流（供 progress/result 解析）；sessionId 用于精确续跑（omp/opencode 支持）。
function buildArgv(cli, { review, resume, sessionId, model, task, stream }) {
  const t = review
    ? `Read-only review task. Do NOT modify, create, or delete any files.\n\n${task}`
    : task;
  switch (cli) {
    case "omp":
      return [
        "omp", "-p",
        ...(stream ? ["--mode", "json"] : []),
        ...(resume ? (sessionId ? ["-r", sessionId] : ["-c"]) : []),
        ...(model ? ["--model", model] : []),
        t
      ];
    case "grok":
      return [
        "grok", "-p", t,
        "--permission-mode", review ? "plan" : "acceptEdits",
        ...(stream ? ["--output-format", "streaming-json"] : []),
        ...(resume ? (sessionId ? ["-r", sessionId] : ["-c"]) : []),
        ...(model ? ["--model", model] : [])
      ];
    case "agy":
      return [
        "agy", "-p", t, "--print-timeout", "30m",
        ...(review ? [] : ["--dangerously-skip-permissions"]),
        ...(resume ? ["--continue"] : []),
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
        const c = e.usage?.cost?.total ?? e.usage?.cost;
        if (typeof c === "number" && c > 0) cost = (cost || 0) + c;
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
  return { activities, finalText: finalText.trim(), sessionId, cost };
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
    if (j.worktree) console.log(`[crew] 改动在隔离 worktree：${j.worktree}（确认后自行合并，清理用 git worktree remove）`);
    process.exit(j.status === "done" ? (j.exitCode ?? 0) : 1);
  }
}

// 任务收尾：提取会话 id 回写状态、记账、桌面通知（在 worker 里执行）
function finalizeJob(job) {
  try {
    const log = fs.existsSync(job.logFile) ? fs.readFileSync(job.logFile, "utf8") : "";
    const parsed = parseEvents(job.stream ? job.cli : "_plain", log);
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

function cmdRun(opts) {
  const cli = opts.cli;
  if (!CLIS.includes(cli)) fail(`--cli 必须是 ${CLIS.join("/")} 之一`);
  if (!binaryAvailable(cli)) fail(`${cli} 未安装或不在 PATH，先运行 /crew:setup`);
  if (!opts.task) fail("缺少任务文本（放在 -- 之后）");

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
  const argv = buildArgv(cli, {
    review: !!opts.review,
    resume: !!opts.resume,
    sessionId: opts.resume ? prev?.sessionId : undefined,
    model: opts.model,
    task: opts.task,
    stream
  });
  markSession(launchCwd, cli, opts.task);
  runJob({
    id, cli,
    mode: opts.review ? "review" : "delegate",
    task: opts.task.slice(0, 500),
    cwd, worktree, argv, stream,
    repoKey: key
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
  child.on("exit", (code) => {
    job.status = code === 0 ? "done" : "failed";
    job.exitCode = code;
    job.endedAt = new Date().toISOString();
    writeJson(jf, job);
    finalizeJob(job);
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
