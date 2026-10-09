import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { ensureAgentKey, keyFileForAgent } from "../shared/keys.js";

test("an agent's key file is created once and then reused by both sides", () => {
  const home = mkdtempSync(path.join(os.tmpdir(), "live-agent-home-"));
  const previous = process.env.PAPERCLIP_HOME;
  process.env.PAPERCLIP_HOME = home;
  try {
    const agentId = "11111111-2222-4333-8444-555555555555";
    const first = ensureAgentKey(agentId);
    const second = ensureAgentKey(agentId);
    assert.equal(first.created, true);
    assert.equal(second.created, false);
    assert.equal(first.key, second.key);
    assert.ok(first.key.length >= 40);
    assert.equal(readFileSync(keyFileForAgent(agentId), "utf8"), first.key);
    assert.ok(first.file.startsWith(home));
  } finally {
    if (previous === undefined) delete process.env.PAPERCLIP_HOME;
    else process.env.PAPERCLIP_HOME = previous;
    rmSync(home, { recursive: true, force: true });
  }
});

test("rejects things that are not agent ids (no path tricks)", () => {
  assert.throws(() => keyFileForAgent("../../etc/passwd"));
  assert.throws(() => keyFileForAgent("a b"));
});
