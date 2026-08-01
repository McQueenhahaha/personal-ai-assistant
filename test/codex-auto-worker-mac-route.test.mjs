import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { processCodexAutoQueue } from "../src/codex-auto-worker.mjs";

test("worker gives full Mac access only to approved privileged tasks", async (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pai-mac-route-"));
  const inbox = path.join(tempDir, "queues", "inbox");
  const env = {
    AUDIT_LOG_FILE: path.join(tempDir, "audit.jsonl"),
    CODEX_AUTO_IGNORE_LOCK: "1",
    CODEX_AUTO_LOCK_FILE: path.join(tempDir, "worker.lock"),
    CODEX_AUTO_MAX_TASKS: "2",
    CODEX_QUEUE_INBOX: inbox,
    PROJECT_ROOT: tempDir
  };
  const previous = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));
  Object.assign(process.env, env);
  fs.mkdirSync(inbox, { recursive: true });

  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  const generalPrompt = "看看 Mac 上下载文件夹有什么";
  const approvedPrompt = "在 Mac 上点击提交按钮";
  fs.writeFileSync(path.join(inbox, "1-general.json"), JSON.stringify({
    id: "general",
    title: "Mac read-only",
    taskType: "telegram-chat",
    source: "test",
    prompt: generalPrompt
  }), "utf8");
  fs.writeFileSync(path.join(inbox, "2-approved.json"), JSON.stringify({
    id: "approved",
    title: "Mac approved GUI",
    taskType: "approved-privileged",
    source: "test",
    prompt: approvedPrompt,
    approvalId: "ABC123"
  }), "utf8");

  const dispatched = [];
  const results = await processCodexAutoQueue({
    notify: false,
    async dispatchToMac(task) {
      dispatched.push(task);
      return { ok: true, result: "done" };
    }
  });

  assert.equal(results.length, 2);
  assert.equal(results.every((result) => result.ok), true);
  assert.deepEqual(dispatched, [
    { prompt: generalPrompt, kind: "mac-general" },
    { prompt: approvedPrompt, kind: "mac-computer-use" }
  ]);
});
