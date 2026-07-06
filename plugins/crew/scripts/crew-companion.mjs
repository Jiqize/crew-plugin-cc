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

// 各 CLI 的无头调用映射（review 为只读语义）
function buildArgv(cli, { review, resume, model, task }) {
  const t = review
    ? `Read-only review task. Do NOT modify, create, or delete any files.\n\n${task}`
    : task;
  switch (cli) {
    case "omp":
      return ["omp", "-p", ...(resume ? ["-c"] : []), ...(model ? ["--model", model] : []), t];
    case "grok":
      return [
        "grok", "-p", t,
        "--permission-mode", review ? "plan" : "acceptEdits",
        ...(resume ? ["-c"] : []),
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
        ...(resume ? ["-c"] : []),
        ...(model ? ["-m", model] : [])
      ];
    default:
      throw new Error(`unknown cli: ${cli}`);
  }
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
  const argv = buildArgv(cli, {
    review: !!opts.review,
    resume: !!opts.resume,
    model: opts.model,
    task: opts.task
  });
  markSession(launchCwd, cli, opts.task);

  if (opts.background) {
    ensureDirs();
    const job = {
      id, cli,
      mode: opts.review ? "review" : "delegate",
      task: opts.task.slice(0, 500),
      cwd, worktree, argv,
      status: "running",
      startedAt: new Date().toISOString(),
      logFile: path.join(JOBS_DIR, `${id}.log`)
    };
    writeJson(jobFile(id), job);
    const child = spawn(process.execPath, [SELF, "_exec", id], { detached: true, stdio: "ignore" });
    child.unref();
    console.log(`已启动后台任务 ${id}（${cli}/${job.mode}）。`);
    console.log(`查进度 /crew:status，看结果 /crew:result ${id}，取消 /crew:cancel ${id}。`);
    if (worktree) console.log(`隔离 worktree：${worktree}`);
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
  const job = jobs[0]; // 不带 id 则取最近一个
  console.log(`[crew] ${job.id}  ${job.status}  ${job.cli}/${job.mode}  ${job.task.slice(0, 100)}`);
  if (job.worktree) console.log(`[crew] 隔离 worktree：${job.worktree}`);
  const log = fs.existsSync(job.logFile) ? fs.readFileSync(job.logFile, "utf8").trim() : "";
  console.log(log || "（暂无输出）");
  if (job.status === "running") console.log("\n[crew] 任务仍在运行，稍后再取结果。");
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
  case "cancel": cmdCancel(opts._[0]); break;
  case "resume-candidate": cmdResumeCandidate(opts); break;
  case "setup": cmdSetup(); break;
  default:
    console.log("用法: crew-companion.mjs <run|status|result|cancel|resume-candidate|setup> [flags] [-- task]");
    process.exit(cmd ? 1 : 0);
}
