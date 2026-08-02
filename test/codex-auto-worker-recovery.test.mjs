import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  decideLockState,
  isWorkerPidAlive,
  recoverOrphanedTasks
} from "../src/codex-auto-worker.mjs";
import { ensureQueue } from "../src/queue.mjs";

test("decideLockState covers fallback, live holder, dead holder, and stale locks", () => {
  const base = {
    lockMtimeMs: 900,
    nowMs: 1000,
    staleMs: 200,
    isPidAlive: () => true
  };

  assert.deepEqual(
    decideLockState({ ...base, lockContent: "not-json" }),
    { action: "wait", reason: "unparsable-fallback-wait" }
  );
  assert.deepEqual(
    decideLockState({ ...base, lockContent: "{}", lockMtimeMs: 700 }),
    { action: "proceed", reason: "unparsable-fallback-proceed" }
  );
  assert.deepEqual(
    decideLockState({ ...base, lockContent: JSON.stringify({ pid: 123 }) }),
    { action: "wait", reason: "holder-alive" }
  );
  assert.deepEqual(
    decideLockState({ ...base, lockContent: JSON.stringify({ pid: 123 }), isPidAlive: () => false }),
    { action: "proceed", reason: "holder-dead" }
  );
  assert.deepEqual(
    decideLockState({ ...base, lockContent: JSON.stringify({ pid: 123 }), lockMtimeMs: 700 }),
    { action: "proceed", reason: "stale-mtime" }
  );
});

test("a reused PID belonging to another command is treated as a dead holder", () => {
  const unrelatedProcess = () => ({
    status: 0,
    stdout: '"C:\\Program Files\\nodejs\\node.exe" other-service.mjs',
    stderr: ""
  });

  assert.equal(isWorkerPidAlive(456, unrelatedProcess), false);
  assert.deepEqual(
    decideLockState({
      lockContent: JSON.stringify({ pid: 456 }),
      lockMtimeMs: 900,
      nowMs: 1000,
      staleMs: 200,
      isPidAlive: (pid) => isWorkerPidAlive(pid, unrelatedProcess)
    }),
    { action: "proceed", reason: "holder-dead" }
  );
});

test("recoverOrphanedTasks requeues safe work, fails privileged work, audits, and notifies", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pai-orphan-recovery-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const inbox = path.join(root, "inbox");
  const dirs = ensureQueue(inbox);
  const chatFile = path.join(dirs.processing, "chat.json");
  const privilegedFile = path.join(dirs.processing, "privileged.json");
  fs.writeFileSync(chatFile, JSON.stringify({
    id: "chat",
    title: "Retry chat",
    taskType: "telegram-chat",
    prompt: "answer me"
  }), "utf8");
  fs.writeFileSync(privilegedFile, JSON.stringify({
    id: "privileged",
    title: "Do not retry",
    taskType: "approved-privileged",
    prompt: "click a button"
  }), "utf8");
  const notifications = [];
  const audits = [];

  const recovered = await recoverOrphanedTasks({
    inboxPath: inbox,
    appendAudit: (entry) => { audits.push(entry); },
    sendTelegramMessage: async (message) => { notifications.push(message); }
  });

  assert.equal(recovered.length, 2);
  assert.equal(fs.existsSync(chatFile), false);
  assert.equal(fs.existsSync(path.join(dirs.inbox, "chat.json")), true);
  assert.equal(fs.existsSync(privilegedFile), false);
  assert.equal(fs.existsSync(path.join(dirs.failed, "privileged.json")), true);
  assert.match(fs.readFileSync(path.join(dirs.outbox, "privileged.error.txt"), "utf8"), /任务被中断（进程终止），未完成/);
  assert.equal(notifications.length, 2);
  assert.equal(notifications.some((message) => message.includes("已重新排队")), true);
  assert.equal(notifications.some((message) => message.includes("已标记失败")), true);
  assert.deepEqual(audits.map((entry) => entry.result).sort(), ["failed", "requeued"]);
});
