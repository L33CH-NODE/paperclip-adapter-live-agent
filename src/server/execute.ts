import type { AdapterExecutionContext, AdapterExecutionResult } from "@paperclipai/adapter-utils";
import {
  asNumber,
  asString,
  buildPaperclipEnv,
  readPaperclipIssueWorkModeFromContext,
} from "@paperclipai/adapter-utils/server-utils";
import { ensureAgentKey } from "../shared/keys.js";
import { getMailbox } from "./mailbox.js";
import { buildLivePrompt } from "./prompt.js";

function failure(errorCode: string, errorMessage: string, extra: Partial<AdapterExecutionResult> = {}): AdapterExecutionResult {
  return { exitCode: 1, signal: null, timedOut: false, errorCode, errorMessage, ...extra };
}

function contextString(ctx: AdapterExecutionContext, key: string): string | null {
  const value = ctx.context[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export async function execute(ctx: AdapterExecutionContext): Promise<AdapterExecutionResult> {
  // An explicit key wins; otherwise the agent gets a key file on this host.
  let key = asString(ctx.config.mailboxKey, "").trim();
  let workerHint = "live-agent-worker run --driver <claude|grok|...> --key-file <the same key>";
  if (!key) {
    try {
      const agentKey = ensureAgentKey(ctx.agent.id);
      key = agentKey.key;
      workerHint = `live-agent-worker run --driver <claude|grok|...> --agent ${ctx.agent.id}`;
      if (agentKey.created) await ctx.onLog("stdout", `[live-agent] created this agent's mailbox key file: ${agentKey.file}\n`);
    } catch (err) {
      return failure(
        "live_agent_mailbox_key_missing",
        `No mailboxKey configured and the key file could not be created: ${err instanceof Error ? err.message : err}`,
      );
    }
  }

  const mailbox = getMailbox();
  await mailbox.ready;
  if (!mailbox.listening) {
    return failure(
      "live_agent_mailbox_unavailable",
      `The live-agent mailbox could not listen on ${mailbox.address} (${mailbox.listenError ?? "unknown error"}).`,
    );
  }

  const baseEnv = buildPaperclipEnv(ctx.agent);
  const apiUrl = asString(ctx.config.paperclipApiUrl, "").trim() || baseEnv.PAPERCLIP_API_URL;
  // Same wake fields the built-in gateway adapters export.
  const taskId = contextString(ctx, "taskId") ?? contextString(ctx, "issueId");
  const wakeReason = contextString(ctx, "wakeReason");
  const optional: Record<string, string | null> = {
    PAPERCLIP_TASK_ID: taskId,
    PAPERCLIP_WAKE_REASON: wakeReason,
    PAPERCLIP_WAKE_COMMENT_ID: contextString(ctx, "wakeCommentId") ?? contextString(ctx, "commentId"),
    PAPERCLIP_APPROVAL_ID: contextString(ctx, "approvalId"),
    PAPERCLIP_APPROVAL_STATUS: contextString(ctx, "approvalStatus"),
    PAPERCLIP_ISSUE_WORK_MODE: readPaperclipIssueWorkModeFromContext(ctx.context) ?? null,
    PAPERCLIP_LINKED_ISSUE_IDS: Array.isArray(ctx.context.issueIds)
      ? ctx.context.issueIds.filter((v): v is string => typeof v === "string" && v.trim().length > 0).join(",") || null
      : null,
    PAPERCLIP_API_KEY: ctx.authToken ?? null,
  };
  const env: Record<string, string> = { ...baseEnv, PAPERCLIP_API_URL: apiUrl, PAPERCLIP_RUN_ID: ctx.runId };
  for (const [name, value] of Object.entries(optional)) if (value) env[name] = value;

  const leaseSec = Math.max(15, asNumber(ctx.config.leaseSec, 120));
  const waitForAgentSec = Math.max(0, asNumber(ctx.config.waitForAgentSec, 600));
  await ctx.onLog(
    "stdout",
    `[live-agent] job queued in ${mailbox.address}; waiting for the agent to pick it up.\n` +
      `[live-agent] no worker yet? start one: ${workerHint}\n`,
  );

  const outcome = await mailbox.submit({
    key,
    leaseSec,
    waitForAgentSec,
    signal: ctx.signal,
    payload: {
      runId: ctx.runId,
      agentId: ctx.agent.id,
      agentName: ctx.agent.name,
      companyId: ctx.agent.companyId,
      taskId,
      wakeReason,
      prompt: buildLivePrompt(ctx, apiUrl, Boolean(ctx.authToken)),
      env,
    },
    onClaim: () => {
      ctx.onDispatch?.();
      void ctx.onLog("stdout", "[live-agent] the agent picked up the job\n");
    },
    onLog: (stream, text) => {
      void ctx.onLog(stream, text);
    },
  });

  switch (outcome.kind) {
    case "done":
      return outcome.ok
        ? { exitCode: 0, signal: null, timedOut: false, summary: outcome.summary, resultJson: outcome.result }
        : failure("live_agent_reported_failure", outcome.error ?? outcome.summary ?? "The live agent reported a failure.", {
            summary: outcome.summary,
            resultJson: outcome.result,
          });
    case "cancelled":
      return failure("live_agent_cancelled", "The run was cancelled before the live agent finished.", { signal: "SIGTERM" });
    case "unclaimed":
      // Nothing left Paperclip, so a retry cannot duplicate work.
      return failure(
        "live_agent_not_awake",
        `No live agent picked up the job within ${outcome.waitedSec}s. Is its worker or session running against ${mailbox.address}?`,
        { timedOut: true, executionRecovery: { kind: "bootstrap", providerWorkStarted: false } },
      );
    case "lost":
      return failure(
        "live_agent_lost",
        `The live agent stopped heartbeating after claiming the job (claims: ${outcome.claims}).`,
        { timedOut: true },
      );
  }
}
