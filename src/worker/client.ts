/** Thin client for the live-agent mailbox protocol (see src/server/mailbox.ts). */

export interface Job {
  jobId: string;
  protocol: string;
  runId: string;
  agentId: string;
  agentName: string;
  companyId: string;
  taskId: string | null;
  wakeReason: string | null;
  prompt: string;
  env: Record<string, string>;
  leaseSec: number;
}

export interface JobControl {
  cancel: boolean;
  settled: boolean;
}

export class LeaseLostError extends Error {
  constructor() {
    super("lease_lost: the mailbox requeued this job; this worker no longer owns it");
  }
}

export class MailboxClient {
  constructor(
    readonly baseUrl: string,
    private readonly key: string,
  ) {}

  private headers(): Record<string, string> {
    return { authorization: `Bearer ${this.key}`, "content-type": "application/json" };
  }

  /** Long-poll for the next job; null when the wait elapsed with nothing to do. */
  async next(waitSec = 25): Promise<Job | null> {
    const res = await fetch(`${this.baseUrl}/v1/next?wait=${waitSec}`, {
      headers: this.headers(),
      signal: AbortSignal.timeout((waitSec + 15) * 1000),
    });
    if (res.status === 204) return null;
    if (res.status === 401) throw new Error("mailbox rejected the key (401)");
    if (!res.ok) throw new Error(`mailbox /v1/next answered ${res.status}`);
    return (await res.json()) as Job;
  }

  private async post(jobId: string, action: "heartbeat" | "log" | "done", body: unknown): Promise<JobControl> {
    const res = await fetch(`${this.baseUrl}/v1/jobs/${jobId}/${action}`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify(body ?? {}),
      signal: AbortSignal.timeout(15_000),
    });
    if (res.status === 409) throw new LeaseLostError();
    if (!res.ok) throw new Error(`mailbox ${action} answered ${res.status}`);
    return (await res.json()) as JobControl;
  }

  heartbeat(jobId: string): Promise<JobControl> {
    return this.post(jobId, "heartbeat", {});
  }

  log(jobId: string, text: string, stream: "stdout" | "stderr" = "stdout"): Promise<JobControl> {
    return this.post(jobId, "log", { stream, text });
  }

  done(jobId: string, outcome: { ok: boolean; summary?: string; error?: string; result?: Record<string, unknown> }): Promise<JobControl> {
    return this.post(jobId, "done", outcome);
  }
}
