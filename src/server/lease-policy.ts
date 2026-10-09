/**
 * What happens when a live agent claims a job and then goes silent.
 *
 * Every claimed job carries a lease. The agent keeps it alive by sending a
 * heartbeat, a log line, or its final result. When the lease runs out, the
 * mailbox asks this policy what to do next:
 *
 *   "requeue"  put the job back in the mailbox for the next poll. If the agent
 *              (or a sibling holding the same key) comes back, it gets the job
 *              again. Risk: the first attempt may already have done part of the
 *              work, such as posting a comment or editing a file, so a second
 *              attempt can duplicate it.
 *   "fail"     end the Paperclip run as lost. Safe and visible, but someone has
 *              to retry, and an agent that was only slow (laptop asleep, long
 *              tool call) loses its progress.
 *
 * Paperclip itself retries transient run failures twice, 30 s apart, so
 * "fail" is not the end of the road for the task.
 */
export interface JobView {
  /** How many times an agent has claimed this job (1 on the first expiry). */
  claims: number;
  /** Epoch ms timestamps. */
  enqueuedAt: number;
  claimedAt: number;
  lastHeartbeatAt: number;
  /** Bytes of progress the agent streamed back before going silent; 0 means it never reported anything. */
  logBytes: number;
}

export type LeaseDecision = "requeue" | "fail";

export function decideOnExpiredLease(job: JobView): LeaseDecision {
  // TODO: choose the policy. Something to weigh: an agent that never
  // logged a byte probably never started, so a retry is cheap; one that
  // streamed a lot may have made changes a second attempt would repeat.
  // Capping the number of claims stops a crash-looping agent from cycling
  // forever.
  void job;
  return "fail";
}
