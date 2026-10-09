/**
 * The mailbox: a small HTTP server that runs inside the Paperclip process.
 *
 * Paperclip runs (`execute`) drop jobs in; live agents, awake in whatever
 * harness they live in, long-poll jobs out, report progress, and post a final
 * result. The agent's own harness owns its model login, so Paperclip never
 * holds a provider credential for it.
 *
 * Protocol (JSON over HTTP, every route except /v1/health needs
 * `Authorization: Bearer <mailboxKey>`):
 *   GET  /v1/health                  liveness, no auth
 *   GET  /v1/next?wait=25            long-poll for the next job (200 job | 204)
 *   POST /v1/jobs/:id/heartbeat      extend the lease -> { cancel, settled }
 *   POST /v1/jobs/:id/log            { stream, text } streamed into the run log
 *   POST /v1/jobs/:id/done           { ok, summary?, error?, result? }
 */
import http from "node:http";
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { decideOnExpiredLease, type JobView } from "./lease-policy.js";

export const MAILBOX_PROTOCOL = "paperclip-live-agent/1";

export interface JobPayload {
  jobId: string;
  protocol: string;
  runId: string;
  agentId: string;
  agentName: string;
  companyId: string;
  taskId: string | null;
  wakeReason: string | null;
  /** The full Paperclip brief for this run. */
  prompt: string;
  /** PAPERCLIP_* variables, including the run-scoped API key when Paperclip issued one. */
  env: Record<string, string>;
  /** Heartbeat at least this often or the lease expires. */
  leaseSec: number;
}

export type JobOutcome =
  | { kind: "done"; ok: boolean; summary: string | null; error: string | null; result: Record<string, unknown> | null }
  | { kind: "cancelled" }
  | { kind: "unclaimed"; waitedSec: number }
  | { kind: "lost"; claims: number };

export interface SubmitInput {
  key: string;
  payload: Omit<JobPayload, "jobId" | "protocol" | "leaseSec">;
  leaseSec: number;
  /** 0 waits forever for an agent to pick the job up. */
  waitForAgentSec: number;
  onLog: (stream: "stdout" | "stderr", text: string) => void;
  /** Fired once, when an agent first claims the job (the work has left Paperclip). */
  onClaim: () => void;
  signal?: AbortSignal;
}

interface Job extends JobView {
  id: string;
  keyHash: Buffer;
  input: SubmitInput;
  state: "queued" | "claimed" | "settled";
  leaseUntil: number;
  cancelRequested: boolean;
  settledAt: number;
  resolve: (outcome: JobOutcome) => void;
}

interface Waiter {
  keyHash: Buffer;
  res: http.ServerResponse;
  timer: NodeJS.Timeout;
}

const MAX_BODY_BYTES = 1024 * 1024;
const MAX_WAIT_SEC = 60;
const SETTLED_RETENTION_MS = 10 * 60 * 1000;
const SWEEP_INTERVAL_MS = 2000;

function hashKey(key: string): Buffer {
  return createHash("sha256").update(key, "utf8").digest();
}

function sameKey(a: Buffer, b: Buffer): boolean {
  return a.length === b.length && timingSafeEqual(a, b);
}

function sendJson(res: http.ServerResponse, status: number, body?: unknown): void {
  if (res.headersSent || res.writableEnded) return;
  if (body === undefined) {
    res.writeHead(status).end();
    return;
  }
  const text = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(text) }).end(text);
}

function readJson(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (chunks.length === 0) return resolve({});
      try {
        const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        resolve(parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {});
      } catch {
        reject(new Error("invalid JSON"));
      }
    });
    req.on("error", reject);
  });
}

export class Mailbox {
  readonly host: string;
  readonly port: number;
  listening = false;
  listenError: string | null = null;
  readonly ready: Promise<void>;

  private readonly jobs = new Map<string, Job>();
  private waiters: Waiter[] = [];
  private readonly lastSeen = new Map<string, number>();
  private readonly server: http.Server;
  private readonly sweeper: NodeJS.Timeout;

  constructor(host: string, port: number) {
    this.host = host;
    this.port = port;
    this.server = http.createServer((req, res) => {
      this.route(req, res).catch((err: unknown) => {
        sendJson(res, 400, { error: err instanceof Error ? err.message : "bad request" });
      });
    });
    this.ready = new Promise((resolve) => {
      this.server.once("listening", () => {
        this.listening = true;
        resolve();
      });
      this.server.once("error", (err: NodeJS.ErrnoException) => {
        this.listenError = `${err.code ?? "ERROR"}: ${err.message}`;
        resolve();
      });
    });
    this.server.listen(port, host);
    this.sweeper = setInterval(() => this.sweep(), SWEEP_INTERVAL_MS);
    this.sweeper.unref();
  }

  /** Stop listening and drop open long-polls (tests; Paperclip never calls this). */
  close(): Promise<void> {
    clearInterval(this.sweeper);
    for (const waiter of this.waiters) clearTimeout(waiter.timer);
    this.waiters = [];
    return new Promise((resolve) => {
      this.server.close(() => resolve());
      this.server.closeAllConnections();
    });
  }

  get address(): string {
    return `http://${this.host.includes(":") ? `[${this.host}]` : this.host}:${this.port}`;
  }

  /** Milliseconds since an agent holding `key` last talked to the mailbox, or null if never. */
  sinceLastSeen(key: string): number | null {
    const at = this.lastSeen.get(hashKey(key).toString("hex"));
    return at === undefined ? null : Date.now() - at;
  }

  submit(input: SubmitInput): Promise<JobOutcome> {
    return new Promise((resolve) => {
      const now = Date.now();
      const job: Job = {
        id: randomUUID(),
        keyHash: hashKey(input.key),
        input,
        state: "queued",
        claims: 0,
        enqueuedAt: now,
        claimedAt: 0,
        lastHeartbeatAt: 0,
        logBytes: 0,
        leaseUntil: 0,
        cancelRequested: false,
        settledAt: 0,
        resolve,
      };
      this.jobs.set(job.id, job);
      if (input.signal?.aborted) {
        this.cancel(job.id);
        return;
      }
      input.signal?.addEventListener("abort", () => this.cancel(job.id), { once: true });
      this.deliver(job.keyHash);
    });
  }

  private settle(job: Job, outcome: JobOutcome): void {
    if (job.state === "settled") return;
    job.state = "settled";
    job.settledAt = Date.now();
    job.resolve(outcome);
  }

  private cancel(id: string): void {
    const job = this.jobs.get(id);
    if (!job || job.state === "settled") return;
    // A claimed job stays on record so the agent's next heartbeat sees cancel:true.
    job.cancelRequested = true;
    this.settle(job, { kind: "cancelled" });
  }

  private claim(job: Job): JobPayload {
    const now = Date.now();
    job.state = "claimed";
    job.claims += 1;
    job.claimedAt = now;
    job.lastHeartbeatAt = now;
    job.leaseUntil = now + job.input.leaseSec * 1000;
    if (job.claims === 1) job.input.onClaim();
    else job.input.onLog("stderr", `[live-agent] job re-claimed (claim #${job.claims})\n`);
    return { ...job.input.payload, jobId: job.id, protocol: MAILBOX_PROTOCOL, leaseSec: job.input.leaseSec };
  }

  /** Hand queued jobs for this key to waiting agents, oldest first on both sides. */
  private deliver(keyHash: Buffer): void {
    for (;;) {
      const waiter = this.waiters.find((w) => sameKey(w.keyHash, keyHash));
      if (!waiter) return;
      const job = this.nextQueued(keyHash);
      if (!job) return;
      this.waiters = this.waiters.filter((w) => w !== waiter);
      clearTimeout(waiter.timer);
      if (waiter.res.writableEnded || waiter.res.destroyed) continue;
      sendJson(waiter.res, 200, this.claim(job));
    }
  }

  private nextQueued(keyHash: Buffer): Job | undefined {
    let oldest: Job | undefined;
    for (const job of this.jobs.values()) {
      if (job.state !== "queued" || !sameKey(job.keyHash, keyHash)) continue;
      if (!oldest || job.enqueuedAt < oldest.enqueuedAt) oldest = job;
    }
    return oldest;
  }

  private sweep(): void {
    const now = Date.now();
    for (const job of this.jobs.values()) {
      if (job.state === "settled") {
        if (now - job.settledAt > SETTLED_RETENTION_MS) this.jobs.delete(job.id);
        continue;
      }
      if (job.state === "queued") {
        const waitMs = job.input.waitForAgentSec * 1000;
        if (waitMs > 0 && now - job.enqueuedAt > waitMs) {
          this.settle(job, { kind: "unclaimed", waitedSec: Math.round((now - job.enqueuedAt) / 1000) });
        }
        continue;
      }
      if (now <= job.leaseUntil) continue;
      let decision: "requeue" | "fail";
      try {
        decision = decideOnExpiredLease({
          claims: job.claims,
          enqueuedAt: job.enqueuedAt,
          claimedAt: job.claimedAt,
          lastHeartbeatAt: job.lastHeartbeatAt,
          logBytes: job.logBytes,
        });
      } catch {
        decision = "fail";
      }
      if (decision === "requeue") {
        job.state = "queued";
        job.input.onLog("stderr", "[live-agent] agent went silent; lease expired, job requeued\n");
        this.deliver(job.keyHash);
      } else {
        job.input.onLog("stderr", "[live-agent] agent went silent; lease expired, giving up\n");
        this.settle(job, { kind: "lost", claims: job.claims });
      }
    }
  }

  private async route(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://mailbox");
    if (req.method === "GET" && url.pathname === "/v1/health") {
      return sendJson(res, 200, { ok: true, protocol: MAILBOX_PROTOCOL });
    }

    const auth = req.headers.authorization ?? "";
    const key = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
    if (!key) return sendJson(res, 401, { error: "missing bearer mailbox key" });
    const keyHash = hashKey(key);
    this.lastSeen.set(keyHash.toString("hex"), Date.now());

    if (req.method === "GET" && url.pathname === "/v1/next") {
      const job = this.nextQueued(keyHash);
      if (job) return sendJson(res, 200, this.claim(job));
      const waitSec = Math.max(0, Math.min(MAX_WAIT_SEC, Number(url.searchParams.get("wait") ?? 25) || 0));
      if (waitSec === 0) return sendJson(res, 204);
      const waiter: Waiter = {
        keyHash,
        res,
        timer: setTimeout(() => {
          this.waiters = this.waiters.filter((w) => w !== waiter);
          sendJson(res, 204);
        }, waitSec * 1000),
      };
      this.waiters.push(waiter);
      req.on("close", () => {
        clearTimeout(waiter.timer);
        this.waiters = this.waiters.filter((w) => w !== waiter);
      });
      return;
    }

    const match = /^\/v1\/jobs\/([0-9a-f-]{36})\/(heartbeat|log|done)$/.exec(url.pathname);
    if (req.method !== "POST" || !match) return sendJson(res, 404, { error: "not found" });
    const job = this.jobs.get(match[1]);
    // Unknown job and someone else's job look identical to the caller.
    if (!job || !sameKey(job.keyHash, keyHash)) return sendJson(res, 404, { error: "no such job" });
    const body = await readJson(req);
    const action = match[2];

    if (job.state === "settled") {
      return sendJson(res, 200, { cancel: true, settled: true });
    }
    if (job.state === "queued") {
      // The lease expired and the job went back to the queue; this worker no longer owns it.
      return sendJson(res, 409, { error: "lease_lost" });
    }

    const now = Date.now();
    job.lastHeartbeatAt = now;
    job.leaseUntil = now + job.input.leaseSec * 1000;

    if (action === "heartbeat") {
      return sendJson(res, 200, { cancel: job.cancelRequested, settled: false });
    }
    if (action === "log") {
      const text = typeof body.text === "string" ? body.text : "";
      const stream = body.stream === "stderr" ? "stderr" : "stdout";
      if (text) {
        job.logBytes += Buffer.byteLength(text);
        job.input.onLog(stream, text.endsWith("\n") ? text : `${text}\n`);
      }
      return sendJson(res, 200, { cancel: job.cancelRequested, settled: false });
    }
    const result = body.result && typeof body.result === "object" && !Array.isArray(body.result)
      ? (body.result as Record<string, unknown>)
      : null;
    this.settle(job, {
      kind: "done",
      ok: body.ok === true,
      summary: typeof body.summary === "string" ? body.summary : null,
      error: typeof body.error === "string" ? body.error : null,
      result,
    });
    return sendJson(res, 200, { cancel: false, settled: true });
  }
}

// One mailbox per Paperclip process. It lives on globalThis so an adapter
// hot-reload (POST /api/adapters/live_agent/reload) reuses the running server
// and its in-flight jobs instead of fighting it for the port. Changes to this
// file therefore take effect only after a Paperclip restart.
const GLOBAL_KEY = Symbol.for("paperclip-adapter-live-agent.mailbox");

export function getMailbox(): Mailbox {
  const slot = globalThis as unknown as Record<symbol, Mailbox | undefined>;
  let mailbox = slot[GLOBAL_KEY];
  if (!mailbox) {
    const host = process.env.LIVE_AGENT_MAILBOX_HOST?.trim() || "127.0.0.1";
    const port = Number(process.env.LIVE_AGENT_MAILBOX_PORT) || 3199;
    mailbox = new Mailbox(host, port);
    slot[GLOBAL_KEY] = mailbox;
  }
  return mailbox;
}
