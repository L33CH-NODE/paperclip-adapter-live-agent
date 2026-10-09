#!/usr/bin/env node
/**
 * live-agent-worker: the agent side of the live-agent mailbox.
 *
 *   keygen                       print a fresh 256-bit mailbox key
 *   run   --driver <name>        pick up jobs and run them headless in a CLI harness
 *                                (claude | grok | opencode | hermes | ollama)
 *   watch                        for a LIVE session (e.g. a Claude Code Monitor):
 *                                print one line per job and keep its lease alive;
 *                                the session does the work, then calls `done`
 *   done  <jobId> [--fail]       finish a job: --summary TEXT | --summary-file F
 *   log   <jobId> <text...>      stream a progress line into the Paperclip run log
 *
 * Common flags: --mailbox URL (or LIVE_AGENT_MAILBOX, default http://127.0.0.1:3199)
 *               --agent <agentId>  (the agent's key file on this host; created if missing)
 *               | --key-file F | --key K | LIVE_AGENT_KEY
 */
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { ensureAgentKey } from "../shared/keys.js";
import { LeaseLostError, MailboxClient, type Job } from "./client.js";
import { DRIVERS, type CliDriver } from "./drivers.js";

// ---------------------------------------------------------------------------
// argv
// ---------------------------------------------------------------------------

interface Args {
  positional: string[];
  flags: Map<string, string | true>;
}

function parseArgs(argv: string[]): Args {
  const positional: string[] = [];
  const flags = new Map<string, string | true>();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith("--")) {
      positional.push(arg);
      continue;
    }
    const eq = arg.indexOf("=");
    if (eq > 0) {
      flags.set(arg.slice(2, eq), arg.slice(eq + 1));
    } else if (i + 1 < argv.length && !argv[i + 1].startsWith("--")) {
      flags.set(arg.slice(2), argv[++i]);
    } else {
      flags.set(arg.slice(2), true);
    }
  }
  return { positional, flags };
}

function flag(args: Args, name: string): string | null {
  const value = args.flags.get(name);
  return typeof value === "string" ? value : null;
}

function die(message: string): never {
  process.stderr.write(`live-agent-worker: ${message}\n`);
  process.exit(1);
}

function client(args: Args): MailboxClient {
  const keyFile = flag(args, "key-file");
  const agentId = flag(args, "agent");
  const key = (
    keyFile
      ? readFileSync(keyFile, "utf8")
      : agentId
        ? ensureAgentKey(agentId).key
        : (flag(args, "key") ?? process.env.LIVE_AGENT_KEY ?? "")
  ).trim();
  if (!key) die("no mailbox key: pass --agent <agentId>, --key-file F, --key K, or set LIVE_AGENT_KEY");
  const base = (flag(args, "mailbox") ?? process.env.LIVE_AGENT_MAILBOX ?? "http://127.0.0.1:3199").replace(/\/+$/, "");
  return new MailboxClient(base, key);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function note(message: string): void {
  process.stderr.write(`[${new Date().toISOString()}] ${message}\n`);
}

function jobDir(args: Args): string {
  const dir = flag(args, "dir") ?? path.join(os.tmpdir(), "paperclip-live-agent");
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** Poll until a job arrives, riding out mailbox restarts with a backoff. */
async function nextJob(mb: MailboxClient): Promise<Job> {
  let backoff = 2000;
  for (;;) {
    try {
      const job = await mb.next(25);
      backoff = 2000;
      if (job) return job;
    } catch (err) {
      note(`mailbox unreachable (${err instanceof Error ? err.message : err}); retrying in ${backoff / 1000}s`);
      await sleep(backoff);
      backoff = Math.min(backoff * 2, 60_000);
    }
  }
}

// ---------------------------------------------------------------------------
// process plumbing (Windows .cmd shims need cmd.exe; .exe and POSIX don't)
// ---------------------------------------------------------------------------

function resolveCommand(command: string): string {
  if (path.isAbsolute(command) || command.includes("/") || command.includes("\\")) return command;
  const exts = process.platform === "win32" ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";") : [""];
  for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
    for (const ext of exts) {
      const candidate = path.join(dir, command + ext.toLowerCase());
      if (existsSync(candidate)) return candidate;
    }
  }
  return command;
}

function quoteForCmd(arg: string): string {
  return `"${arg.replace(/"/g, '""')}"`;
}

function spawnPortable(command: string, args: string[], cwd: string, env: NodeJS.ProcessEnv) {
  const resolved = resolveCommand(command);
  if (process.platform === "win32" && /\.(cmd|bat)$/i.test(resolved)) {
    const line = [resolved, ...args].map(quoteForCmd).join(" ");
    return spawn(process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", `"${line}"`], {
      cwd,
      env,
      windowsVerbatimArguments: true,
      windowsHide: true,
    });
  }
  return spawn(resolved, args, { cwd, env, windowsHide: true });
}

function killTree(pid: number | undefined): void {
  if (!pid) return;
  if (process.platform === "win32") spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true });
  else {
    try {
      process.kill(-pid, "SIGTERM");
    } catch {
      process.kill(pid, "SIGTERM");
    }
  }
}

// ---------------------------------------------------------------------------
// run: headless CLI harnesses
// ---------------------------------------------------------------------------

/** Batches output into mailbox log calls so a chatty agent isn't one HTTP request per line. */
class LogPump {
  private buffer = "";
  private timer: NodeJS.Timeout;
  constructor(private readonly mb: MailboxClient, private readonly jobId: string, private readonly onControl: (cancel: boolean) => void) {
    this.timer = setInterval(() => void this.flush(), 1000);
  }
  push(text: string): void {
    this.buffer += text;
    if (this.buffer.length > 16_384) void this.flush();
  }
  async flush(): Promise<void> {
    if (!this.buffer) return;
    const text = this.buffer;
    this.buffer = "";
    try {
      const control = await this.mb.log(this.jobId, text);
      this.onControl(control.cancel);
    } catch (err) {
      if (err instanceof LeaseLostError) this.onControl(true);
    }
  }
  async close(): Promise<void> {
    clearInterval(this.timer);
    await this.flush();
  }
}

async function runCliJob(mb: MailboxClient, job: Job, driver: CliDriver, args: Args): Promise<void> {
  const dir = jobDir(args);
  const promptFile = path.join(dir, `${job.jobId}.md`);
  writeFileSync(promptFile, job.prompt, "utf8");
  const cwd = path.resolve(flag(args, "cwd") ?? process.cwd());
  const command = flag(args, "command") ?? driver.command;
  const driverArgs = driver.args({
    promptFile,
    cwd,
    model: flag(args, "model"),
    autoApprove: !args.flags.has("no-auto-approve"),
  });

  note(`job ${job.jobId} (run ${job.runId}${job.taskId ? `, task ${job.taskId}` : ""}) -> ${command}`);
  // A worker started from a terminal owned by Claude Code inherits that session's variables:
  // nesting markers (`claude` refuses to start, or turns transcripts off) and the session's
  // messaging token and socket (a driver holding them could act as the parent session).
  // Drop them all; configuration such as CLAUDE_CONFIG_DIR passes through.
  const parentSessionVar = /^(CLAUDECODE|CLAUDE_PID|CLAUDE_CODE_(ENTRYPOINT|SESSION(_\w+)?|CHILD_SESSION|PARENT_SESSION|BRIDGE_SESSION_ID|MESSAGING_\w+))$/;
  const env: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(process.env)) if (!parentSessionVar.test(name)) env[name] = value;
  Object.assign(env, job.env);
  const child = spawnPortable(command, driverArgs, cwd, env);
  let cancelled = false;
  const stop = (cancel: boolean) => {
    if (cancel && !cancelled) {
      cancelled = true;
      note(`job ${job.jobId}: cancelled by Paperclip; stopping ${command}`);
      killTree(child.pid);
    }
  };
  const pump = new LogPump(mb, job.jobId, stop);
  let tail = "";
  child.stdout.on("data", (chunk: Buffer) => {
    const text = chunk.toString("utf8");
    tail = (tail + text).slice(-4000);
    pump.push(text);
  });
  let errTail = "";
  child.stderr.on("data", (chunk: Buffer) => {
    errTail = (errTail + chunk.toString("utf8")).slice(-2000);
  });
  if (driver.promptOnStdin) child.stdin.end(job.prompt);
  else child.stdin.end();

  const beat = setInterval(async () => {
    try {
      stop((await mb.heartbeat(job.jobId)).cancel);
    } catch (err) {
      if (err instanceof LeaseLostError) stop(true);
    }
  }, Math.max(5, job.leaseSec / 3) * 1000);

  const code = await new Promise<number | null>((resolve) => {
    child.on("error", (err) => {
      errTail += `\n${err.message}`;
      resolve(null);
    });
    child.on("close", (exitCode) => resolve(exitCode));
  });
  clearInterval(beat);
  await pump.close();
  if (cancelled) return;

  const summary = tail.trim().slice(-1500) || undefined;
  const ok = code === 0;
  try {
    await mb.done(job.jobId, ok ? { ok, summary } : { ok, summary, error: `${command} exited ${code ?? "on spawn error"}: ${errTail.trim().slice(-800)}` });
    note(`job ${job.jobId}: ${ok ? "done" : `failed (exit ${code})`}`);
  } catch (err) {
    note(`job ${job.jobId}: could not report done (${err instanceof Error ? err.message : err})`);
  }
}

// ---------------------------------------------------------------------------
// run: ollama (answer-only; no tool loop, so it posts its answer as a comment)
// ---------------------------------------------------------------------------

async function runOllamaJob(mb: MailboxClient, job: Job, args: Args): Promise<void> {
  const ollamaUrl = (flag(args, "ollama-url") ?? process.env.OLLAMA_HOST ?? "http://127.0.0.1:11434").replace(/\/+$/, "");
  const model = flag(args, "model") ?? die("--model is required for the ollama driver");
  note(`job ${job.jobId} -> ollama ${model}`);
  const beat = setInterval(() => void mb.heartbeat(job.jobId).catch(() => undefined), Math.max(5, job.leaseSec / 3) * 1000);
  try {
    const res = await fetch(`${ollamaUrl}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model,
        stream: false,
        messages: [
          {
            role: "system",
            content:
              "You are an agent working a Paperclip task. You cannot run tools. Reply with your complete work product for the task: findings, the draft, the answer. It is posted as your comment on the issue.",
          },
          { role: "user", content: job.prompt },
        ],
      }),
    });
    if (!res.ok) throw new Error(`ollama answered ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const answer = String(((await res.json()) as { message?: { content?: string } }).message?.content ?? "").trim();
    if (!answer) throw new Error("ollama returned an empty answer");

    const { PAPERCLIP_API_URL: api, PAPERCLIP_API_KEY: token, PAPERCLIP_RUN_ID: runId } = job.env;
    if (job.taskId && api && token) {
      const posted = await fetch(`${api.replace(/\/+$/, "")}/api/issues/${job.taskId}/comments`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}`, "x-paperclip-run-id": runId },
        body: JSON.stringify({ body: answer }),
      });
      if (!posted.ok) throw new Error(`posting the comment failed: ${posted.status} ${(await posted.text()).slice(0, 300)}`);
    }
    await mb.log(job.jobId, answer);
    await mb.done(job.jobId, { ok: true, summary: answer.slice(0, 1500) });
    note(`job ${job.jobId}: done`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    note(`job ${job.jobId}: failed (${message})`);
    await mb.done(job.jobId, { ok: false, error: message }).catch(() => undefined);
  } finally {
    clearInterval(beat);
  }
}

// ---------------------------------------------------------------------------
// watch: live sessions do the work themselves
// ---------------------------------------------------------------------------

async function watch(mb: MailboxClient, args: Args): Promise<void> {
  const dir = jobDir(args);
  note(`watching ${mb.baseUrl}; job files go to ${dir}`);
  for (;;) {
    const job = await nextJob(mb);
    const promptFile = path.join(dir, `${job.jobId}.md`);
    const envFile = path.join(dir, `${job.jobId}.env`);
    writeFileSync(promptFile, job.prompt, "utf8");
    writeFileSync(
      envFile,
      Object.entries(job.env).map(([k, v]) => `export ${k}='${v.replace(/'/g, "'\\''")}'`).join("\n") + "\n",
      { encoding: "utf8", mode: 0o600 },
    );
    // One line per event: a Monitor turns each line into a notification in the live session.
    process.stdout.write(
      `JOB ${job.jobId} agent="${job.agentName}" task=${job.taskId ?? "-"} prompt=${promptFile} env=${envFile} lease=${job.leaseSec}s\n`,
    );
    // Keep the lease alive until the session reports done (or Paperclip cancels).
    for (;;) {
      await sleep(Math.max(5, job.leaseSec / 3) * 1000);
      try {
        const control = await mb.heartbeat(job.jobId);
        if (control.settled) {
          process.stdout.write(`SETTLED ${job.jobId}\n`);
          break;
        }
        if (control.cancel) process.stdout.write(`CANCEL ${job.jobId}\n`);
      } catch (err) {
        if (err instanceof LeaseLostError) {
          process.stdout.write(`LOST ${job.jobId}\n`);
          break;
        }
        note(`heartbeat failed (${err instanceof Error ? err.message : err}); will retry`);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  const args = parseArgs(rest);
  switch (command) {
    case "keygen":
      process.stdout.write(`${randomBytes(32).toString("base64url")}\n`);
      return;
    case "run": {
      const name = flag(args, "driver") ?? die(`--driver is required (${Object.keys(DRIVERS).join(", ")})`);
      const driver = DRIVERS[name] ?? die(`unknown driver "${name}" (${Object.keys(DRIVERS).join(", ")})`);
      const mb = client(args);
      note(`${name} worker polling ${mb.baseUrl}`);
      do {
        const job = await nextJob(mb);
        if (driver.kind === "ollama") await runOllamaJob(mb, job, args);
        else await runCliJob(mb, job, driver, args);
      } while (!args.flags.has("once"));
      return;
    }
    case "watch":
      return watch(client(args), args);
    case "done": {
      const jobId = args.positional[0] ?? die("usage: done <jobId> [--fail] [--summary TEXT | --summary-file F]");
      const summaryFile = flag(args, "summary-file");
      const summary = summaryFile ? readFileSync(summaryFile, "utf8") : flag(args, "summary") ?? undefined;
      const ok = !args.flags.has("fail");
      await client(args).done(jobId, ok ? { ok, summary } : { ok, summary, error: summary ?? "the agent reported failure" });
      process.stdout.write(`reported ${ok ? "done" : "failure"} for ${jobId}\n`);
      return;
    }
    case "log": {
      const [jobId, ...words] = args.positional;
      if (!jobId || words.length === 0) die("usage: log <jobId> <text...>");
      await client(args).log(jobId, words.join(" "));
      return;
    }
    default:
      process.stdout.write(
        "usage: live-agent-worker <keygen | run --driver NAME | watch | done JOBID | log JOBID TEXT> [--mailbox URL] [--key-file F]\n",
      );
      process.exit(command ? 1 : 0);
  }
}

main().catch((err: unknown) => die(err instanceof Error ? err.message : String(err)));
