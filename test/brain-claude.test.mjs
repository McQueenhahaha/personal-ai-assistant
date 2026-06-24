import { test } from "node:test";
import assert from "node:assert/strict";
import { runClaudeText } from "../src/brain/claude.mjs";

test("runClaudeText throws when Claude CLI cannot be started", async () => {
  await assert.rejects(() => runClaudeText("hello", {
    cliPath: "definitely-not-a-real-cmd-xyz",
    timeoutMs: 3000
  }));
});
