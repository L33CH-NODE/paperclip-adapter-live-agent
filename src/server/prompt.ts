import type { AdapterExecutionContext } from "@paperclipai/adapter-utils";
import {
  isPaperclipRecoveryWakePayload,
  paperclipWakeCommentsArePromptOwned,
  readPaperclipIssueWorkModeFromContext,
  selectPaperclipPromptSections,
  stringifyPaperclipWakePayload,
} from "@paperclipai/adapter-utils/server-utils";

function nonEmpty(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/**
 * The same brief Paperclip's own gateway adapters send (modelled on the Hermes
 * gateway), plus a short contract for talking back through the mailbox.
 */
export function buildLivePrompt(ctx: AdapterExecutionContext, apiUrl: string, hasApiKey: boolean): string {
  const { taskContextNote, wakePrompt } = selectPaperclipPromptSections(ctx.context, {
    resumedSession: false,
    includeExecutionContract: false,
  });
  const wakePayloadJson = paperclipWakeCommentsArePromptOwned(ctx.context)
    ? null
    : stringifyPaperclipWakePayload(ctx.context.paperclipWake, { omitIssueDescription: Boolean(taskContextNote) });
  const sessionHandoff = nonEmpty(ctx.context.paperclipSessionHandoffMarkdown);
  const issueWorkMode = readPaperclipIssueWorkModeFromContext(ctx.context);
  const skipContract = ctx.context.conversationMode === true || isPaperclipRecoveryWakePayload(ctx.context.paperclipWake);

  const lines: Array<string | null> = [
    `You are ${ctx.agent.name}, an AI agent employee in a Paperclip-managed company.`,
    "You are running in your own harness; Paperclip reached you through the live-agent mailbox.",
    "",
    "Paperclip runtime identity:",
    `- Agent ID: ${ctx.agent.id}`,
    `- Company ID: ${ctx.agent.companyId}`,
    `- Run ID: ${ctx.runId}`,
    `- Paperclip API URL: ${apiUrl}`,
    hasApiKey
      ? "- Paperclip API key: provided as PAPERCLIP_API_KEY (send `Authorization: Bearer $PAPERCLIP_API_KEY` and `X-Paperclip-Run-Id: $PAPERCLIP_RUN_ID`)"
      : "- Paperclip API key: not issued for this run; you cannot update the issue directly, so put your full result in the final summary",
    issueWorkMode ? `- Issue work mode: ${issueWorkMode}` : null,
    "",
    ...(skipContract
      ? []
      : [
          "Execution contract:",
          "- Take concrete action in this run when the task is actionable.",
          "- Do not stop at a plan unless the issue asks for planning only.",
          "- Leave durable progress and update the issue to a clear final disposition.",
          "- Use X-Paperclip-Run-Id on mutating Paperclip API requests.",
          "- End with a one-paragraph summary of what you did; it becomes the run result. A headless worker reports it for you; a live session reports it with `live-agent-worker done <jobId> --summary ...`.",
          "",
        ]),
    wakePrompt,
    sessionHandoff ? `\n${sessionHandoff}` : null,
    taskContextNote ? `\n${taskContextNote}` : null,
    ...(wakePayloadJson ? ["", "Structured wake payload JSON:", "```json", wakePayloadJson, "```"] : []),
  ];
  return lines.filter((line): line is string => line !== null).join("\n").trim();
}
