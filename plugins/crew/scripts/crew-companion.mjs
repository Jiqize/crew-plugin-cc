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
      if (key === "cli" || key === "model") opts[key] = rest[++i];
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
    if (cost != null) push(`成本: $${cost.toFixed(4)}`);
  } else {
    // agy 等无事件流的 CLI：原文即结果
    finalText = text.trim();
    for (const l of lines.slice(-10)) push(l);
  }
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

// 创建后台任务记录并派生 worker
function startBackgroundJob(fields) {
  ensureDirs();
  const job = {
    status: "running",
    startedAt: new Date().toISOString(),
    logFile: path.join(JOBS_DIR, `${fields.id}.log`),
    ...fields
  };
  writeJson(jobFile(job.id), job);
  const child = spawn(process.execPath, [SELF, "_exec", job.id], { detached: true, stdio: "ignore" });
  child.unref();
  console.log(`已启动后台任务 ${job.id}（${job.cli}/${job.mode}）。`);
  console.log(`看进度 /crew:progress ${job.id}，取结果 /crew:result ${job.id}，取消 /crew:cancel ${job.id}。`);
  if (job.worktree) console.log(`隔离 worktree：${job.worktree}`);
  return job;
}

function markSession(cwd, cli, task) {
  const state = readJson(STATE_FILE, {});
  const key = repoKey(cwd);
  state[key] = state[key] || {};
  state[key][cli] = { lastRunAt: new Date().toISOString(), lastTask: task.slice(0, 200) };
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

  const launchCwd = process.cwd();
  const id = "c-" + crypto.randomBytes(3).toString("hex");
  let cwd = launchCwd;
  let worktree = null;
  if (opts.worktree) {
    worktree = makeWorktree(launchCwd, id);
    cwd = worktree;
  }
  // 后台任务对支持 JSON 事件流的 CLI 打开流式日志，供 progress/result 解析
  const stream = !!opts.background && cli !== "agy";
  const argv = buildArgv(cli, {
    review: !!opts.review,
    resume: !!opts.resume,
    model: opts.model,
    task: opts.task,
    stream
  });
  markSession(launchCwd, cli, opts.task);

  if (opts.background) {
    startBackgroundJob({
      id, cli,
      mode: opts.review ? "review" : "delegate",
      task: opts.task.slice(0, 500),
      cwd, worktree, argv, stream
    });
    return;
  }

  // 前台：stdout/stderr 直通，退出码透传
  const child = spawn(argv[0], argv.slice(1), { cwd, stdio: ["ignore", "inherit", "inherit"] });
  child.on("exit", (code) => {
    if (worktree) console.log(`\n[crew] 改动在隔离 worktree：${worktree}（确认后自行合并，清理用 git worktree remove）`);
    process.exit(code ?? 1);
  });
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

// 追问：向已结束任务的会话追加一条消息（omp/opencode 按会话 id 精确续跑）
function cmdSend(opts) {
  const jobs = loadJobs(opts._[0]);
  if (!jobs.length) return fail("没有可追问的后台任务");
  const job = captureSession(jobs[0]);
  if (!opts.task) return fail("缺少追问内容（放在 -- 之后）");
  if (job.status === "running") return fail(`任务 ${job.id} 还在运行，等它结束（/crew:progress 看进度）或先 /crew:cancel`);
  const stream = !!opts.background && job.cli !== "agy";
  const argv = buildArgv(job.cli, {
    review: job.mode === "review",
    resume: true,
    sessionId: job.sessionId,
    model: opts.model,
    task: opts.task,
    stream
  });
  markSession(job.cwd, job.cli, opts.task);
  if (opts.background) {
    startBackgroundJob({
      id: "c-" + crypto.randomBytes(3).toString("hex"),
      cli: job.cli,
      mode: job.mode,
      task: opts.task.slice(0, 500),
      cwd: job.cwd,
      worktree: job.worktree,
      parent: job.id,
      argv, stream
    });
    return;
  }
  const child = spawn(argv[0], argv.slice(1), { cwd: job.cwd, stdio: ["ignore", "inherit", "inherit"] });
  child.on("exit", (code) => process.exit(code ?? 1));
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
  case "cancel": cmdCancel(opts._[0]); break;
  case "resume-candidate": cmdResumeCandidate(opts); break;
  case "setup": cmdSetup(); break;
  default:
    console.log("用法: crew-companion.mjs <run|status|result|progress|send|cancel|resume-candidate|setup> [flags] [-- task]");
    process.exit(cmd ? 1 : 0);
}
