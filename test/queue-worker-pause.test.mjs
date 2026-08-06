import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { processLocalQueue } from "../src/queue-worker.mjs";

/**
 * local 队列 worker 是最后一个不看暂停态的自动处理入口：按了 /pause 之后
 * 它照样每 60 秒消费任务。这里锁住"暂停就不领新任务"。
 *
 * 断言刻意不是"返回空数组" —— 队列本来就空时也返回空数组，那种测试没有
 * 区分力。改为断言**队列目录压根没被碰过**：ensureQueue 会创建它，所以
 * 目录不存在就证明确实在那之前早返回了。第二个用例是对照组，证明这个
 * 断言真的能区分两种情况。
 */
function withTempRoot(level, run) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "queue-worker-pause-"));
  const inbox = path.join(root, "queues", "local", "inbox");
  fs.mkdirSync(path.join(root, "data", "state"), { recursive: true });
  fs.writeFileSync(
    path.join(root, "data", "state", "assistant-pause-state.json"),
    `${JSON.stringify({ level, at: level === "none" ? "" : "2026-08-06T00:00:00.000Z" })}\n`,
    "utf8"
  );

  const previousRoot = process.env.PROJECT_ROOT;
  const previousInbox = process.env.LOCAL_QUEUE_INBOX;
  process.env.PROJECT_ROOT = root;
  process.env.LOCAL_QUEUE_INBOX = inbox;

  return Promise.resolve(run(inbox)).finally(() => {
    if (previousRoot === undefined) delete process.env.PROJECT_ROOT;
    else process.env.PROJECT_ROOT = previousRoot;
    if (previousInbox === undefined) delete process.env.LOCAL_QUEUE_INBOX;
    else process.env.LOCAL_QUEUE_INBOX = previousInbox;
    fs.rmSync(root, { recursive: true, force: true });
  });
}

test("暂停时 local 队列一个任务都不领", async () => {
  await withTempRoot("pause", async (inbox) => {
    const results = await processLocalQueue({ notify: false });
    assert.deepEqual(results, []);
    assert.equal(fs.existsSync(inbox), false, "暂停时不该走到 ensureQueue");
  });
});

test("急停(stop)同样拦住 local 队列", async () => {
  await withTempRoot("stop", async (inbox) => {
    const results = await processLocalQueue({ notify: false });
    assert.deepEqual(results, []);
    assert.equal(fs.existsSync(inbox), false, "急停时不该走到 ensureQueue");
  });
});

test("未暂停时照常进入队列处理", async () => {
  await withTempRoot("none", async (inbox) => {
    const results = await processLocalQueue({ notify: false });
    assert.deepEqual(results, []);
    assert.equal(fs.existsSync(inbox), true, "未暂停时应当建好队列目录");
  });
});
