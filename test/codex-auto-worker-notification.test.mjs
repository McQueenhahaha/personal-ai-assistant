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

test("回执带来源标签 —— 看得出是哪台机器、哪个引擎跑的", async () => {
  const { sourceLabel } = await import("../src/codex-auto-worker.mjs");

  assert.equal(sourceLabel("windows", "codex"), "[Windows · codex]");
  assert.equal(sourceLabel("mac", "gui-control"), "[Mac · gui-control]");
  // 未知节点不该把标签整个吞掉 —— 宁可显示原始值也不要显示空的。
  assert.equal(sourceLabel("", ""), "[本机 · codex]");
});

test("聊天回执必须真的带上这个标签（源码守卫）", () => {
  // 没有它的时候两台机器的回答长得一模一样，出问题时你无从判断该去哪台看日志。
  // 2026-08-04 排查孤儿桥就吃过这个亏：回消息的一直是 Mac 上的桥，
  // 而从消息本身完全看不出来。
  const source = fs.readFileSync(
    new URL("../src/codex-auto-worker.mjs", import.meta.url),
    "utf8"
  );
  const start = source.indexOf('"chat-result"');
  assert.ok(start > 0, "找不到 chat-result 分支");
  const branch = source.slice(start, start + 320);
  assert.match(branch, /sourceLabel\(ranOnNodeId, capability\)/);
});
