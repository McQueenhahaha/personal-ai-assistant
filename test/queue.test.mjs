import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  claimTask,
  createTask,
  ensureQueue,
  listPendingTasks,
  queueDirs,
  readTask,
  writeFailure,
  writeResult
} from "../src/queue.mjs";
import { timestampForFile } from "../src/env.mjs";

function makeInbox(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pai-queue-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, inbox: path.join(root, "inbox") };
}

test("queueDirs returns the expected queue layout", (t) => {
  const { root, inbox } = makeInbox(t);

  assert.deepEqual(queueDirs(inbox), {
    root,
    inbox,
    processing: path.join(root, "processing"),
    outbox: path.join(root, "outbox"),
    done: path.join(root, "done"),
    failed: path.join(root, "failed")
  });
});

test("ensureQueue recursively creates all queue directories", (t) => {
  const { inbox } = makeInbox(t);
  const dirs = ensureQueue(path.join(inbox, "nested"));

  for (const dir of Object.values(dirs)) {
    assert.equal(fs.statSync(dir).isDirectory(), true);
  }
});

test("listPendingTasks returns supported files sorted by mtime", (t) => {
  const { inbox } = makeInbox(t);
  const dirs = ensureQueue(inbox);
  const files = [
    ["second.json", "2024-01-02T00:00:00.000Z"],
    ["ignored.log", "2024-01-01T00:00:00.000Z"],
    ["third.txt", "2024-01-03T00:00:00.000Z"],
    ["first.md", "2024-01-01T00:00:00.000Z"]
  ];

  for (const [name, isoDate] of files) {
    const file = path.join(dirs.inbox, name);
    fs.writeFileSync(file, name, "utf8");
    const date = new Date(isoDate);
    fs.utimesSync(file, date, date);
  }
  fs.mkdirSync(path.join(dirs.inbox, "directory.json"));

  const tasks = listPendingTasks(inbox);

  assert.deepEqual(
    tasks.map((task) => task.name),
    ["first.md", "second.json", "third.txt"]
  );
});

test("claimTask moves a task from inbox to processing", (t) => {
  const { inbox } = makeInbox(t);
  const dirs = ensureQueue(inbox);
  const original = path.join(dirs.inbox, "task.txt");
  fs.writeFileSync(original, "do work", "utf8");

  const claimed = claimTask({ file: original, name: "task.txt" }, inbox);

  assert.equal(fs.existsSync(original), false);
  assert.equal(fs.existsSync(claimed), true);
  assert.equal(path.dirname(claimed), dirs.processing);
  assert.match(path.basename(claimed), /-task\.txt$/);
});

test("readTask parses json fields, json fallbacks, and plain text tasks", (t) => {
  const { root } = makeInbox(t);
  const completeJson = path.join(root, "complete.json");
  const fallbackJson = path.join(root, "fallback.json");
  const textFile = path.join(root, "plain.txt");

  fs.writeFileSync(
    completeJson,
    JSON.stringify({
      id: "task-1",
      title: "Complete task",
      priority: "high",
      source: "unit",
      taskType: "review",
      prompt: "Review this"
    }),
    "utf8"
  );
  fs.writeFileSync(fallbackJson, JSON.stringify({ body: "Body fallback" }), "utf8");
  fs.writeFileSync(textFile, "Plain task\n", "utf8");

  const complete = readTask(completeJson);
  assert.equal(complete.title, "Complete task");
  assert.equal(complete.priority, "high");
  assert.equal(complete.source, "unit");
  assert.equal(complete.taskType, "review");
  assert.equal(complete.prompt, "Review this");

  const fallback = readTask(fallbackJson);
  assert.equal(fallback.id, "fallback.json");
  assert.equal(fallback.title, "fallback.json");
  assert.equal(fallback.priority, "normal");
  assert.equal(fallback.source, "queue");
  assert.equal(fallback.taskType, "general");
  assert.equal(fallback.prompt, "Body fallback");

  const text = readTask(textFile);
  assert.equal(text.id, "plain.txt");
  assert.equal(text.taskType, "general");
  assert.equal(text.prompt, "Plain task");
  assert.deepEqual(text.metadata, {});
});

test("writeResult moves the task to done and writes a result file with headers", (t) => {
  const { inbox } = makeInbox(t);
  const dirs = ensureQueue(inbox);
  const taskFile = path.join(dirs.processing, "task.txt");
  fs.writeFileSync(taskFile, "task", "utf8");

  const outFile = writeResult({
    inboxPath: inbox,
    taskFile,
    task: {
      id: "task-1",
      title: "Task title",
      source: "unit",
      priority: "high"
    },
    result: "done\n"
  });

  const output = fs.readFileSync(outFile, "utf8");
  assert.equal(path.dirname(outFile), dirs.outbox);
  assert.equal(path.basename(outFile), "task.result.txt");
  assert.match(output, /^Task: Task title/m);
  assert.match(output, /^ID: task-1/m);
  assert.match(output, /^Completed: /m);
  assert.match(output, /done\n$/);
  assert.equal(fs.existsSync(taskFile), false);
  assert.equal(fs.existsSync(path.join(dirs.done, "task.txt")), true);
});

test("writeFailure moves the task to failed and writes an error file with stack text", (t) => {
  const { inbox } = makeInbox(t);
  const dirs = ensureQueue(inbox);
  const taskFile = path.join(dirs.processing, "task.txt");
  fs.writeFileSync(taskFile, "task", "utf8");

  const outFile = writeFailure({
    inboxPath: inbox,
    taskFile,
    task: { title: "Failing task" },
    error: new Error("boom")
  });

  const output = fs.readFileSync(outFile, "utf8");
  assert.equal(path.dirname(outFile), dirs.outbox);
  assert.equal(path.basename(outFile), "task.error.txt");
  assert.match(output, /^Task: Failing task/m);
  assert.match(output, /^Failed: /m);
  assert.match(output, /Error: boom/);
  assert.equal(fs.existsSync(taskFile), false);
  assert.equal(fs.existsSync(path.join(dirs.failed, "task.txt")), true);
});

test("createTask sanitizes long titles and writes JSON that readTask can read", (t) => {
  const { inbox } = makeInbox(t);
  const title = `Needs review: ${"x".repeat(100)} / final`;

  const file = createTask({
    inboxPath: inbox,
    title,
    prompt: "Check it",
    taskType: "analysis",
    source: "test",
    priority: "low"
  });

  const safeTitle = path.basename(file, ".json").slice(timestampForFile(new Date(0)).length + 1);
  assert.equal(path.dirname(file), queueDirs(inbox).inbox);
  assert.equal(safeTitle.length, 80);
  assert.match(safeTitle, /^[a-z0-9_-]+$/i);

  const task = readTask(file);
  assert.equal(task.title, title);
  assert.equal(task.prompt, "Check it");
  assert.equal(task.taskType, "analysis");
  assert.equal(task.source, "test");
  assert.equal(task.priority, "low");
});
