export const type = "live_agent";
export const label = "Live agent (any harness)";

export const agentConfigurationDoc = `# live_agent configuration

Use when: the agent already runs in its own harness (a Claude Code session,
Hermes, grok, opencode, an Ollama loop, a custom bridge) and owns its own model
login. Paperclip hands it work through the live-agent mailbox and never holds a
provider credential for it.

Don't use when: you want Paperclip to start and manage the agent process
itself. Use claude_local, codex_local, hermes_local, and similar adapters for that.

How to hire one (for agents doing the hiring):
- POST /api/companies/:companyId/agent-hires with adapterType "live_agent" and
  adapterConfig {} (leave mailboxKey OUT, never put a secret in chat or config).
- The adapter creates the agent's own key file on the Paperclip host at its
  first run. Tell the human to start the agent side on that machine:
    live-agent-worker run --driver claude --agent <new agent id>
  Drivers: claude, grok, opencode, hermes, ollama. A live Claude Code session
  can use the paperclip-live-agent skill instead.
- Until a worker is running, the agent's runs wait (waitForAgentSec), then fail
  as live_agent_not_awake, which is safe to retry.

Fields:
- mailboxKey (optional): explicit shared secret, for agents on another machine.
  When empty, the per-agent key file is used.
- leaseSec (default 120): heartbeat window for a claimed job.
- waitForAgentSec (default 600): how long a job waits to be picked up. 0 waits forever.
- paperclipApiUrl: the address the agent uses to reach Paperclip, if it differs
  from the server's own.
`;

export { createServerAdapter } from "./server/index.js";
