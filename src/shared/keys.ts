/**
 * Per-agent mailbox key files, so hiring needs no secret in chat or in the
 * agent's config.
 *
 * When an agent's adapter config has no `mailboxKey`, both sides fall back to
 * `<paperclip home>/live-agent/keys/<agentId>.key` on the Paperclip host.
 * Whichever side gets there first (the first run, or the worker starting with
 * `--agent <agentId>`) creates it with an exclusive write; the other reads it.
 * An agent on another machine gets a copy of the file, or `--key-file`.
 */
import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export function paperclipHome(): string {
  return process.env.PAPERCLIP_HOME?.trim() || path.join(os.homedir(), ".paperclip");
}

export function keyFileForAgent(agentId: string): string {
  if (!/^[0-9a-zA-Z-]{8,64}$/.test(agentId)) throw new Error(`not an agent id: ${agentId}`);
  return path.join(paperclipHome(), "live-agent", "keys", `${agentId}.key`);
}

export function newMailboxKey(): string {
  return randomBytes(32).toString("base64url");
}

/** Read the agent's key file, creating it (owner-only) when it doesn't exist yet. */
export function ensureAgentKey(agentId: string): { key: string; file: string; created: boolean } {
  const file = keyFileForAgent(agentId);
  mkdirSync(path.dirname(file), { recursive: true });
  try {
    const key = newMailboxKey();
    writeFileSync(file, key, { encoding: "utf8", mode: 0o600, flag: "wx" });
    return { key, file, created: true };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    return { key: readFileSync(file, "utf8").trim(), file, created: false };
  }
}
