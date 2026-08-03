import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  clearInFlight,
  describeInterrupted,
  readInFlight,
  writeInFlight
} from "../src/state/in-flight.mjs";
import { SOUL_FILES } from "../src/brain/soul-sync.mjs";

// 凤凰计划第一半。用户的原话点出了心跳机制的局限：
// "消失的时候没有信息传进来，另外一台电脑不知道现在助手到什么程度了"。
// 队列(data/queues/**)不在灵魂包里，所以死在另一台的任务本机完全看不见。

function tempRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pai-inflight-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

test("in-flight record travels with the brain", () => {
  assert.ok(
    SOUL_FILES.includes("data/state/in-flight.json"),
    "不进灵魂包的话接管方看不到，等于没做"
  );
});

test("write then read round-trips, and clearing keeps the file present", (t) => {
  const root = tempRoot(t);
  assert.equal(readInFlight(root), null);

  writeInFlight({ taskId: "t-1", title: "帮我查 XXX", taskType: "telegram-chat", nodeId: "windows" }, root);
  assert.equal(readInFlight(root).taskId, "t-1");

  clearInFlight(root);
  assert.equal(readInFlight(root), null, "清空后应视为没有在飞任务");
  // 用内容置空而非删文件：灵魂包只搬运存在的文件、删除不传播，
  // 删了对端会永远以为还有任务在飞。
  assert.equal(fs.existsSync(path.join(root, "data", "state", "in-flight.json")), true);
});

test("only another node's record counts as an interruption", () => {
  const record = {
    taskId: "t-2",
    title: "长任务",
    taskType: "telegram-chat",
    nodeId: "windows",
    startedAt: "2026-08-03T10:00:00.000Z"
  };
  const nowMs = Date.parse("2026-08-03T10:04:00.000Z");

  // 本机自己的在飞任务由本地 processing/ 恢复流程处理；两边都报会重复通知用户。
  assert.equal(describeInterrupted({ record, selfId: "windows", nowMs }), null);

  const seen = describeInterrupted({ record, selfId: "mac", nowMs });
  assert.equal(seen.fromNode, "windows");
  assert.match(seen.text, /Windows 在处理《长任务》时中断了/);
  assert.match(seen.text, /约 4 分钟/);
});

test("a record with no task, or no node, is not an interruption", () => {
  const nowMs = Date.now();
  assert.equal(describeInterrupted({ record: null, selfId: "mac", nowMs }), null);
  assert.equal(describeInterrupted({ record: { taskId: "" }, selfId: "mac", nowMs }), null);
  assert.equal(describeInterrupted({ record: { taskId: "x", nodeId: "" }, selfId: "mac", nowMs }), null);
});

test("an unusable startedAt still produces a warning", () => {
  // 说不出跑了多久也要告诉用户"这件事被中断了" —— 静默丢失才是要消灭的东西。
  const seen = describeInterrupted({
    record: { taskId: "t-3", title: "X", nodeId: "windows", startedAt: "garbage" },
    selfId: "mac",
    nowMs: Date.now()
  });
  assert.match(seen.text, /中断了/);
});

test("corrupt in-flight state never breaks the worker", (t) => {
  const root = tempRoot(t);
  fs.mkdirSync(path.join(root, "data", "state"), { recursive: true });
  fs.writeFileSync(path.join(root, "data", "state", "in-flight.json"), "{broken");
  assert.equal(readInFlight(root), null);
});
