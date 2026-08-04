import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runClaudeChat, runClaudeText, scrubSecretEnv } from "../src/brain/claude.mjs";

/** 造一个冒充 claude CLI 的脚本，让它把给定文本原样吐到 stdout。 */
function fakeCli(t, stdoutText) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-redact-"));
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  const script = path.join(tempDir, "emit.mjs");
  fs.writeFileSync(script, `process.stdout.write(${JSON.stringify(stdoutText)});`);

  let cliPath;
  if (process.platform === "win32") {
    cliPath = path.join(tempDir, "claude-test.cmd");
    fs.writeFileSync(cliPath, `@echo off\r\n"${process.execPath}" "${script}" %*\r\n`);
  } else {
    cliPath = path.join(tempDir, "claude-test");
    fs.writeFileSync(cliPath, `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`);
    fs.chmodSync(cliPath, 0o755);
  }
  return { cliPath, stateFile: path.join(tempDir, "chat-history.json") };
}

test("runClaudeText throws when Claude CLI cannot be started", async () => {
  await assert.rejects(() => runClaudeText("hello", {
    cliPath: "definitely-not-a-real-cmd-xyz",
    timeoutMs: 3000
  }));
});

test("聊天回复与 chat-history 都必须脱敏", async (t) => {
  // 泄漏一次会同时进两个地方：Telegram 回复，以及 chat-history.json ——
  // 后者在灵魂包里，supervisor 下一轮就 scp 到 Mac，且每次推送前还在对端
  // 留一份 state-backup 快照。也就是说明文会以几十份副本长期躺在另一台机器上，
  // 在 Telegram 里撤回消息也删不掉。codex 那条出口一直是脱敏的，只有聊天这条漏。
  const token = "8012345678:AAH1abcdefghijklmnopqrstuvwxyz012345";
  const { cliPath, stateFile } = fakeCli(t, `你的 token 是 ${token}`);

  const reply = await runClaudeChat("我的 token 是多少", {
    cliPath,
    stateFile,
    timeoutMs: 8000
  });

  assert.equal(reply.includes(token), false, "回复里不应出现明文 token");
  assert.match(reply, /TELEGRAM_BOT_TOKEN|REDACTED/);
  assert.equal(
    fs.readFileSync(stateFile, "utf8").includes(token),
    false,
    "chat-history 里不应出现明文 token —— 它会被同步到对端机器"
  );
});

test("子进程拿不到密钥 —— 脱敏挡不住那个 shell 自己把密钥发出去", async (t) => {
  // assist 档给的是带 Bash 且 --permission-mode dontAsk 的 shell。
  // 密钥留在环境里的话，模型一条 `env` 就拿到，而且可以直接 curl 出去 ——
  // 回复脱敏（G5b）只挡得住回显，挡不住这条路。
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-env-"));
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  const envFile = path.join(tempDir, "child-env.json");
  const script = path.join(tempDir, "dump-env.mjs");
  fs.writeFileSync(script, [
    'import fs from "node:fs";',
    `fs.writeFileSync(${JSON.stringify(envFile)}, JSON.stringify(process.env));`,
    'process.stdout.write("ok");'
  ].join("\n"));

  let cliPath;
  if (process.platform === "win32") {
    cliPath = path.join(tempDir, "claude-test.cmd");
    fs.writeFileSync(cliPath, `@echo off\r\n"${process.execPath}" "${script}" %*\r\n`);
  } else {
    cliPath = path.join(tempDir, "claude-test");
    fs.writeFileSync(cliPath, `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`);
    fs.chmodSync(cliPath, 0o755);
  }

  // 制造前提：CI 上没有 .env，不设的话这条测试会因为"本来就没有"而假绿。
  const original = process.env.TELEGRAM_BOT_TOKEN;
  process.env.TELEGRAM_BOT_TOKEN = "8012345678:must-not-reach-the-child";
  t.after(() => {
    if (original === undefined) delete process.env.TELEGRAM_BOT_TOKEN;
    else process.env.TELEGRAM_BOT_TOKEN = original;
  });

  await runClaudeText("hi", { cliPath, capability: "assist", timeoutMs: 8000 });

  const childEnv = JSON.parse(fs.readFileSync(envFile, "utf8"));
  assert.equal("TELEGRAM_BOT_TOKEN" in childEnv, false, "密钥不该进子进程环境");
  assert.ok(childEnv.PATH || childEnv.Path, "PATH 必须保留，否则子进程连命令都找不到");
});

test("Claude CLI 自己要用的密钥是例外 —— 洗掉它子进程根本起不来", () => {
  const scrubbed = scrubSecretEnv({
    PATH: "/usr/bin",
    TELEGRAM_BOT_TOKEN: "x",
    CANVAS_API_TOKEN: "x",
    MAC_SATELLITE_KEY: "x",
    GOG_KEYRING_PASSWORD: "x",
    ANTHROPIC_API_KEY: "keep-me"
  });

  assert.deepEqual(Object.keys(scrubbed).sort(), ["ANTHROPIC_API_KEY", "PATH"]);
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
