import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
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

test("assist can expose Read without exposing Bash", async (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-args-"));
  const captureScript = path.join(tempDir, "capture-args.mjs");
  const argsFile = path.join(tempDir, "args.json");
  const originalArgsFile = process.env.CLAUDE_TEST_ARGS_FILE;
  fs.writeFileSync(captureScript, [
    'import fs from "node:fs";',
    'fs.writeFileSync(process.env.CLAUDE_TEST_ARGS_FILE, JSON.stringify(process.argv.slice(2)));',
    'process.stdout.write("ok");'
  ].join("\n"));

  let cliPath;
  if (process.platform === "win32") {
    cliPath = path.join(tempDir, "claude-test.cmd");
    fs.writeFileSync(cliPath, `@echo off\r\n"${process.execPath}" "${captureScript}" %*\r\n`);
  } else {
    cliPath = path.join(tempDir, "claude-test");
    fs.writeFileSync(cliPath, `#!/bin/sh\nexec "${process.execPath}" "${captureScript}" "$@"\n`);
    fs.chmodSync(cliPath, 0o755);
  }
  process.env.CLAUDE_TEST_ARGS_FILE = argsFile;
  t.after(() => {
    if (originalArgsFile == null) delete process.env.CLAUDE_TEST_ARGS_FILE;
    else process.env.CLAUDE_TEST_ARGS_FILE = originalArgsFile;
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  await runClaudeText("read the supplied image", {
    cliPath,
    capability: "assist",
    additionalSystemPrompt: "screen context",
    disableBash: true,
    timeoutMs: 5000
  });

  const args = JSON.parse(fs.readFileSync(argsFile, "utf8"));
  const toolsIndex = args.indexOf("--tools");
  const disallowedIndex = args.indexOf("--disallowedTools");
  assert.equal(args[toolsIndex + 1], "Read,Grep,Glob");
  assert.equal(args[disallowedIndex + 1].split(",").includes("Bash"), true);
  assert.equal(args.includes("--allowedTools"), false);
  assert.equal(args[args.indexOf("--append-system-prompt") + 1].includes("screen context"), true);
});
