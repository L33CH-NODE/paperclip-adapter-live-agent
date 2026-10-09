import type { AdapterConfigSchema, ServerAdapterModule } from "@paperclipai/adapter-utils";
import { agentConfigurationDoc, type } from "../index.js";
import { execute } from "./execute.js";
import { getMailbox } from "./mailbox.js";
import { testEnvironment } from "./test.js";

const configSchema: AdapterConfigSchema = {
  fields: [
    {
      key: "mailboxKey",
      label: "Mailbox key (optional)",
      type: "text",
      hint: "Leave empty to use this agent's own key file on the Paperclip host (start the worker with --agent <agentId>). Set it only for agents on another machine.",
    },
    {
      key: "leaseSec",
      label: "Lease (seconds)",
      type: "number",
      default: 120,
      hint: "The agent must heartbeat, log, or finish within this window, or the lease policy decides the job's fate.",
    },
    {
      key: "waitForAgentSec",
      label: "Wait for agent (seconds)",
      type: "number",
      default: 600,
      hint: "How long a job waits for the agent to pick it up before the run fails as not awake. 0 waits forever.",
    },
    {
      key: "paperclipApiUrl",
      label: "Paperclip API URL for the agent",
      type: "text",
      hint: "Override when the agent runs on another machine and reaches Paperclip at a different address.",
    },
  ],
};

export function createServerAdapter(): ServerAdapterModule {
  // Start listening as soon as the adapter loads, so agents can connect
  // before the first job arrives.
  getMailbox();
  return {
    type,
    execute,
    testEnvironment,
    // Paperclip mints a run-scoped API key and passes it to execute(); the
    // mailbox hands it to the agent with the job. No long-lived Paperclip key,
    // no provider login.
    supportsLocalAgentJwt: true,
    models: [],
    agentConfigurationDoc,
    getConfigSchema: () => configSchema,
  };
}
