import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { processCodexAutoQueue } from "../src/codex-auto-worker.mjs";
import { queueDirs } from "../src/queue.mjs";

function setupTask(t, task) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pai-notification-failure-"));
  const inbox = path.join(tempDir, "queues", "inbox");
  const env = {
    AUDIT_LOG_FILE: path.join(tempDir, "audit.jsonl"),
    BRAIN_NODE_ID: "windows",
    CODEX_AUTO_IGNORE_LOCK: "1",
    CODEX_AUTO_LOCK_FILE: path.join(tempDir, "worker.lock"),
    CODEX_AUTO_MAX_TASKS: "1",
    CODEX_QUEUE_INBOX: inbox,
    PROJECT_ROOT: tempDir
  };
  const previous = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));
  Object.assign(process.env, env);
  fs.mkdirSync(inbox, { recursive: true });
  fs.writeFileSync(path.join(inbox, "task.json"), JSON.stringify(task), "utf8");

  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  return { inbox };
}

test("completed task remains done and returns normally when result notification throws", async (t) => {
  const { inbox } = setupTask(t, {
    id: "notify-failure-task",
    title: "Notification failure",
    taskType: "telegram-chat",
    source: "test",
    prompt: "给我一个简短答案"
  });
  const audits = [];
  const logs = [];
  let results;

  await assert.doesNotReject(async () => {
    results = await processCodexAutoQueue({
      appendAudit: (entry) => { audits.push(entry); },
      logError: (line) => { logs.push(line); },
      pickNode: async () => ({ nodeId: "windows", brainNodeId: "windows" }),
      runClaudeChat: async () => "answer is safely stored",
      sendTelegramMessage: async () => { throw new Error("Telegram 429 test failure"); }
    });
  });

  const dirs = queueDirs(inbox);
  assert.equal(results.length, 1);
  assert.equal(results[0].ok, true);
  assert.equal(fs.existsSync(results[0].outFile), true);
  assert.deepEqual(fs.readdirSync(dirs.done).length, 1);
  assert.deepEqual(fs.readdirSync(dirs.failed), []);
  assert.match(fs.readFileSync(results[0].outFile, "utf8"), /answer is safely stored/);
  assert.equal(audits.length, 2);
  assert.equal(audits.every(({ kind }) => kind === "telegram-notification"), true);
  assert.equal(audits.every(({ reason }) => reason.includes("taskId=notify-failure-task")), true);
  assert.equal(audits.every(({ reason }) => reason.includes("Telegram 429 test failure")), true);
  assert.equal(audits.every(({ reason }) => reason.includes(results[0].outFile)), true);
  assert.equal(logs.every((line) => line.includes(results[0].outFile)), true);
});

test("study distillation stays done when a middle chunk notification fails", async (t) => {
  const { inbox } = setupTask(t, {
    id: "study-chunk-failure",
    title: "Long study result",
    taskType: "study-distill",
    source: "test",
    prompt: "讲解一个主题"
  });
  const answer = `${"a".repeat(3500)}${"b".repeat(3500)}${"c".repeat(10)}`;
  const events = [];
  const audits = [];
  let messageCalls = 0;

  const results = await processCodexAutoQueue({
    appendAudit: (entry) => { audits.push(entry); },
    logError: () => {},
    runClaudeText: async () => answer,
    sendTelegramMessage: async () => {
      messageCalls += 1;
      events.push(`message:${messageCalls}`);
      if (messageCalls === 2) throw new Error("middle chunk rate limited");
    },
    sendTelegramDocument: async (file) => {
      events.push("document");
      assert.equal(fs.existsSync(file), true);
    }
  });

  const dirs = queueDirs(inbox);
  assert.equal(results[0].ok, true);
  assert.deepEqual(fs.readdirSync(dirs.done).length, 1);
  assert.deepEqual(fs.readdirSync(dirs.failed), []);
  assert.deepEqual(events, ["message:1", "message:2", "message:3", "document", "message:4"]);
  assert.equal(audits.length, 1);
  assert.match(audits[0].reason, /phase=study-chunk-2/);
  assert.match(audits[0].reason, /middle chunk rate limited/);
  assert.match(audits[0].reason, /study-chunk-failure/);
  assert.match(audits[0].reason, new RegExp(results[0].outFile.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});
