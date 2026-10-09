# paperclip-adapter-live-agent

Hire **any agent that is already awake in its own harness** into
[Paperclip](https://github.com/paperclipai/paperclip): a live Claude Code
session, Hermes, grok, opencode, an Ollama loop, or your own bridge. Anything
that can make an HTTP request qualifies.

Paperclip **holds no provider login** for these agents. Each harness keeps its
own auth: your Claude Code login refreshes itself, Hermes keeps its keys, and so
on. Paperclip just puts work in a mailbox, and the agent takes it out.

```
Paperclip wakes agent ──▶ live_agent adapter queues the job in its mailbox
                                   │   (brief + task id + run-scoped API key)
agent in its own harness ◀── long-polls the mailbox, claims the job
   └─ works with ITS OWN model login, updates the issue through Paperclip's API
   └─ heartbeats while busy, then posts done + summary ──▶ the run closes
```

Why this instead of the built-in `claude_local` and friends: no AI-connection
setup, no expiring copied tokens, no Paperclip-managed process. The agent can
live on another machine on your tailnet, and if it's offline the job waits.

## Install

```sh
git clone https://github.com/L33CH-NODE/paperclip-adapter-live-agent
cd paperclip-adapter-live-agent && npm install && npm run build

# register it with a running Paperclip (instance admin)
curl -X POST http://127.0.0.1:3100/api/adapters/install \
  -H "Content-Type: application/json" -H "Origin: http://127.0.0.1:3100" \
  -d '{"packageName": "/path/to/paperclip-adapter-live-agent", "isLocalPath": true}'
```

The mailbox starts inside the Paperclip process on `127.0.0.1:3199`. Override it
with `LIVE_AGENT_MAILBOX_HOST` / `LIVE_AGENT_MAILBOX_PORT` in Paperclip's
environment, for example binding to your tailnet IP for agents on other machines.

## Hire an agent

1. Hire it in Paperclip with adapter **Live agent (any harness)** and leave
   **Mailbox key** empty. You can do this in the UI, or let your CEO agent do it
   through `POST /api/companies/:id/agent-hires` with `adapterType: "live_agent"`.
   Paperclip's agent-facing docs (`/llms/agent-configuration/live_agent.txt`)
   explain how.
2. The agent gets its own key file on the Paperclip host,
   `~/.paperclip/live-agent/keys/<agentId>.key`. No secret ever goes through
   chat or config.
3. Start the agent side on that machine (pick one):

| Harness | Command |
|---|---|
| Claude Code (headless) | `live-agent-worker run --driver claude --agent <agentId> --cwd <workdir>` |
| grok CLI | `live-agent-worker run --driver grok --agent <agentId> --cwd <workdir>` |
| opencode | `live-agent-worker run --driver opencode --agent <agentId> --cwd <workdir>` |
| Hermes agent | `live-agent-worker run --driver hermes --agent <agentId>` |
| Ollama (answer-only) | `live-agent-worker run --driver ollama --model qwen3:14b --agent <agentId>` |
| **A live Claude Code session** | `live-agent-worker watch --agent <agentId>` under a Monitor; the session does the work and calls `done` |

Several workers can share one agent: they form a pool, and each job goes to
exactly one of them. For an agent on another machine, copy its key file over
(or set an explicit `mailboxKey`) and bind the mailbox to an address it can reach.

Headless drivers run each CLI in its auto-approve mode by default (Paperclip's
own `claude_local` does the same), because nobody is there to click "allow".
Pass `--no-auto-approve` if your harness uses an allowlist instead.

## Adapter config

| Field | Default | Meaning |
|---|---|---|
| `mailboxKey` | per-agent key file | Explicit shared secret, for agents on another machine. Whoever holds the key (or the key file) receives this agent's jobs **and their run-scoped Paperclip API keys**, so treat it like a password. |
| `leaseSec` | 120 | A claimed job must see a heartbeat, a log line, or a result within this window. |
| `waitForAgentSec` | 600 | How long a job waits to be picked up before the run fails as `live_agent_not_awake` (marked safe to retry). 0 waits forever. |
| `paperclipApiUrl` | server's own | The URL the agent should use to reach Paperclip, if different. |

When a lease expires, `src/server/lease-policy.ts` decides between requeueing the
job and failing the run.

## Mailbox protocol (`paperclip-live-agent/1`)

All routes except health take `Authorization: Bearer <mailboxKey>`.

| Route | Purpose |
|---|---|
| `GET /v1/health` | liveness |
| `GET /v1/next?wait=25` | long-poll; `200` job JSON or `204` |
| `POST /v1/jobs/:id/heartbeat` | extend the lease → `{cancel, settled}` |
| `POST /v1/jobs/:id/log` | `{stream, text}` streamed into the Paperclip run log |
| `POST /v1/jobs/:id/done` | `{ok, summary?, error?, result?}` closes the run |

A job carries `prompt` (the standard Paperclip brief) and `env`
(`PAPERCLIP_API_URL`, `PAPERCLIP_API_KEY` (run-scoped), `PAPERCLIP_RUN_ID`,
`PAPERCLIP_TASK_ID`, …). That is enough for any agent to follow Paperclip's own
`skills/paperclip/SKILL.md`.

## License

MIT
