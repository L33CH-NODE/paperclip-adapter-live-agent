import type { AdapterEnvironmentTestContext, AdapterEnvironmentTestResult } from "@paperclipai/adapter-utils";
import { asString } from "@paperclipai/adapter-utils/server-utils";
import { getMailbox } from "./mailbox.js";

type Check = AdapterEnvironmentTestResult["checks"][number];

const AWAKE_WINDOW_MS = 90_000;

export async function testEnvironment(ctx: AdapterEnvironmentTestContext): Promise<AdapterEnvironmentTestResult> {
  const checks: Check[] = [];
  const mailbox = getMailbox();
  await mailbox.ready;

  if (mailbox.listening) {
    checks.push({ code: "live_agent_mailbox_up", level: "info", message: `Mailbox listening on ${mailbox.address}` });
  } else {
    checks.push({
      code: "live_agent_mailbox_unavailable",
      level: "error",
      message: `Mailbox could not listen on ${mailbox.address}: ${mailbox.listenError ?? "unknown error"}`,
      hint: "Set LIVE_AGENT_MAILBOX_PORT (and LIVE_AGENT_MAILBOX_HOST) in Paperclip's environment to a free port, then restart Paperclip.",
    });
  }

  const key = asString(ctx.config.mailboxKey, "").trim();
  if (!key) {
    checks.push({
      code: "live_agent_key_file_mode",
      level: "info",
      message: "No mailboxKey set: the agent gets its own key file on this host at its first run (live-agent/keys/<agentId>.key under the Paperclip home).",
      hint: "Start the agent side on this machine with: live-agent-worker run --driver <claude|grok|...> --agent <agentId>",
    });
  } else if (key.length < 24) {
    checks.push({
      code: "live_agent_mailbox_key_weak",
      level: "warn",
      message: "mailboxKey is short. Whoever holds it receives this agent's jobs and their run-scoped Paperclip API keys.",
      hint: "Use `live-agent-worker keygen` for a 256-bit key.",
    });
  }

  if (key && mailbox.listening) {
    const since = mailbox.sinceLastSeen(key);
    if (since !== null && since <= AWAKE_WINDOW_MS) {
      checks.push({
        code: "live_agent_awake",
        level: "info",
        message: `The live agent is awake (last polled ${Math.round(since / 1000)}s ago).`,
      });
    } else {
      checks.push({
        code: "live_agent_not_polling",
        level: "warn",
        message: since === null
          ? "No live agent has polled this mailbox key yet."
          : `The live agent last polled ${Math.round(since / 1000)}s ago.`,
        hint: `Start it: live-agent-worker run --driver <claude|grok|opencode|hermes|ollama> --mailbox ${mailbox.address} --key-file <file>, or load the paperclip-live-agent skill in a Claude Code session.`,
      });
    }
  }

  return {
    adapterType: ctx.adapterType,
    status: checks.some((c) => c.level === "error") ? "fail" : checks.some((c) => c.level === "warn") ? "warn" : "pass",
    checks,
    testedAt: new Date().toISOString(),
  };
}
