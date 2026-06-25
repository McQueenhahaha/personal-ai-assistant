import { test } from "node:test";
import assert from "node:assert/strict";
import { runClaudeText, shouldResetChatSession } from "../src/brain/claude.mjs";

test("runClaudeText throws when Claude CLI cannot be started", async () => {
  await assert.rejects(() => runClaudeText("hello", {
    cliPath: "definitely-not-a-real-cmd-xyz",
    timeoutMs: 3000
  }));
});

test("shouldResetChatSession detects missing and idle sessions", () => {
  assert.equal(shouldResetChatSession(null, 1000, 60000), true);
  assert.equal(shouldResetChatSession({ sessionId: "x", lastAtMs: 0 }, 70000, 60000), true);
  assert.equal(shouldResetChatSession({ sessionId: "x", lastAtMs: 50000 }, 70000, 60000), false);
});
