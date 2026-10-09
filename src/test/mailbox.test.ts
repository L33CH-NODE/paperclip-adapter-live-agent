import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { Mailbox, type JobOutcome, type SubmitInput } from "../server/mailbox.js";
import { decideOnExpiredLease } from "../server/lease-policy.js";
import { MailboxClient } from "../worker/client.js";

const PORT = 31990 + Math.floor(Math.random() * 9);
let mailbox: Mailbox;

before(async () => {
  mailbox = new Mailbox("127.0.0.1", PORT);
  await mailbox.ready;
  assert.equal(mailbox.listening, true, mailbox.listenError ?? "not listening");
});
after(() => mailbox.close());

const BASE = `http://127.0.0.1:${PORT}`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function submit(key: string, overrides: Partial<SubmitInput> = {}) {
  const logs: string[] = [];
  let claimed = 0;
  const outcome: Promise<JobOutcome> = mailbox.submit({
    key,
    leaseSec: 30,
    waitForAgentSec: 0,
    payload: {
      runId: "run-1",
      agentId: "agent-1",
      agentName: "Tester",
      companyId: "co-1",
      taskId: "task-1",
      wakeReason: "manual",
      prompt: "do the thing",
      env: { PAPERCLIP_API_KEY: "run-jwt" },
    },
    onLog: (_stream, text) => logs.push(text),
    onClaim: () => {
      claimed += 1;
    },
    ...overrides,
  });
  return { outcome, logs, claims: () => claimed };
}

test("health needs no key", async () => {
  const res = await fetch(`${BASE}/v1/health`);
  assert.equal(res.status, 200);
});

test("delivers a job, streams logs, and settles on done", async () => {
  const { outcome, logs, claims } = submit("key-a");
  const mb = new MailboxClient(BASE, "key-a");
  const job = await mb.next(5);
  assert.ok(job);
  assert.equal(job.prompt, "do the thing");
  assert.equal(job.env.PAPERCLIP_API_KEY, "run-jwt");
  assert.equal(claims(), 1);
  assert.deepEqual(await mb.log(job.jobId, "working"), { cancel: false, settled: false });
  await mb.done(job.jobId, { ok: true, summary: "did it" });
  const result = await outcome;
  assert.equal(result.kind, "done");
  assert.equal(result.kind === "done" && result.summary, "did it");
  assert.ok(logs.includes("working\n"));
  // Late calls on a settled job tell the worker to stop.
  assert.deepEqual(await mb.heartbeat(job.jobId), { cancel: true, settled: true });
});

test("a long-poll waiting before the job arrives gets it", async () => {
  const mb = new MailboxClient(BASE, "key-b");
  const pending = mb.next(10);
  await sleep(200);
  const { outcome } = submit("key-b");
  const job = await pending;
  assert.ok(job);
  await mb.done(job.jobId, { ok: false, error: "nope" });
  const result = await outcome;
  assert.equal(result.kind === "done" && result.ok, false);
});

test("jobs are invisible to other keys", async () => {
  const { outcome } = submit("key-c", { waitForAgentSec: 1 });
  const intruder = new MailboxClient(BASE, "not-key-c");
  assert.equal(await intruder.next(0), null);
  const result = await outcome;
  assert.equal(result.kind, "unclaimed");
});

test("rejects requests without a key", async () => {
  const res = await fetch(`${BASE}/v1/next?wait=0`);
  assert.equal(res.status, 401);
});

test("aborting the run cancels a claimed job and the worker hears it", async () => {
  const controller = new AbortController();
  const { outcome } = submit("key-d", { signal: controller.signal });
  const mb = new MailboxClient(BASE, "key-d");
  const job = await mb.next(5);
  assert.ok(job);
  controller.abort();
  assert.equal((await outcome).kind, "cancelled");
  assert.equal((await mb.heartbeat(job.jobId)).cancel, true);
});

test("an expired lease follows the lease policy", async () => {
  const { outcome } = submit("key-e", { leaseSec: 1 });
  const mb = new MailboxClient(BASE, "key-e");
  const job = await mb.next(5);
  assert.ok(job);
  const expected = decideOnExpiredLease({ claims: 1, enqueuedAt: 0, claimedAt: 0, lastHeartbeatAt: 0, logBytes: 0 });
  if (expected === "fail") {
    assert.equal((await outcome).kind, "lost");
  } else {
    // Requeued: the same key gets the job again, and the old claim is dead.
    const again = await mb.next(10);
    assert.equal(again?.jobId, job.jobId);
    await mb.done(job.jobId, { ok: true });
    assert.equal((await outcome).kind, "done");
  }
});
