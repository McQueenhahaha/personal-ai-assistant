import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CANCEL_REQUEST_RELATIVE,
  clearCancelRequest,
  isCancelRequestedFor,
  readCancelRequest,
  requestCancel
} from "../src/state/cancel.mjs";
import { SOUL_FILES } from "../src/brain/soul-sync.mjs";

function tempRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pai-cancel-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

test("取消是点名的 —— 只掐被指名的那个任务", (t) => {
  const root = tempRoot(t);
  requestCancel("task-A", root);

  assert.equal(isCancelRequestedFor("task-A", root), true);
  assert.equal(isCancelRequestedFor("task-B", root), false, "别的任务不该被误伤");
});

test("空 taskId 一律不算取消 —— 否则陈旧请求会掐掉之后随便哪个任务", (t) => {
  const root = tempRoot(t);
  requestCancel("", root);

  assert.equal(isCancelRequestedFor("", root), false);
  assert.equal(isCancelRequestedFor("task-A", root), false);
});

test("清除后同一个任务不再被取消，且文件仍然存在", (t) => {
  const root = tempRoot(t);
  requestCancel("task-A", root);
  clearCancelRequest(root);

  assert.equal(isCancelRequestedFor("task-A", root), false);
  assert.equal(readCancelRequest(root).taskId, "");
  // 用内容置空而非删文件，与 pause.mjs 同一理由。
  assert.equal(fs.existsSync(path.join(root, CANCEL_REQUEST_RELATIVE)), true);
});

test("文件损坏时退化为「没有取消请求」，而不是把正在跑的活掐掉", (t) => {
  const root = tempRoot(t);
  fs.mkdirSync(path.join(root, "data", "state"), { recursive: true });
  fs.writeFileSync(path.join(root, CANCEL_REQUEST_RELATIVE), "{坏掉的");

  assert.deepEqual(readCancelRequest(root), { taskId: "", at: "" });
  assert.equal(isCancelRequestedFor("task-A", root), false);
});

test("取消请求不进灵魂包", () => {
  // 取消是即时动作，隔一台机器再执行已经没有意义 ——
  // 接管方拿到一条旧请求，只会掐掉一个不相干的新任务。
  assert.equal(
    SOUL_FILES.includes(CANCEL_REQUEST_RELATIVE),
    false,
    "cancel-request 不该跨机同步"
  );
});
