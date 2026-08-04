import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runDirectMode } from "../src/openclaw-telegram-bridge.mjs";

function makeFiles(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pai-telegram-direct-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return {
    stateFile: path.join(root, "bridge-state.json"),
    offsetFile: path.join(root, "offset.json"),
    heartbeatFile: path.join(root, "heartbeat.json")
  };
}

function quietLogger(errors = []) {
  return {
    log() {},
    warn() {},
    error(message) { errors.push(message); }
  };
}

test("runDirectMode continues polling after fetchUpdates throws", async (t) => {
  const files = makeFiles(t);
  const errors = [];
  let calls = 0;

  await runDirectMode({
    token: "test-token",
    chatId: "123",
    ...files,
    dryRun: true,
    processExisting: false,
    once: true,
    retrySeconds: 0,
    failureWarnThreshold: 5,
    logger: quietLogger(errors),
    fetchUpdatesImpl: async () => {
      calls += 1;
      if (calls === 1) throw new Error("simulated fetch failure");
      return [{
        update_id: 41,
        message: { message_id: 7, date: 1, chat: { id: 123 }, text: "old" }
      }];
    }
  });

  assert.equal(calls, 2);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /Error: simulated fetch failure/);
  assert.deepEqual(JSON.parse(fs.readFileSync(files.offsetFile, "utf8")), { offset: 42 });
});

test("offset 文件损坏时桥仍然起得来，而不是被 keepalive 无限重启同一个崩溃", async (t) => {
  const files = makeFiles(t);
  // 断电、蓝屏，或看门狗的 Stop-Process -Force 恰好落在那次写入上，
  // 就会留下这种半截文件。原先 readUpdateOffset 直接 throw，而它在 while 循环之外 ——
  // main() 退出、keepalive 每 30 秒重启同一个必崩的进程，机器人永久失联，
  // 只能人工上机删掉这个文件才救得回来。
  fs.mkdirSync(path.dirname(files.offsetFile), { recursive: true });
  fs.writeFileSync(files.offsetFile, "{");

  await runDirectMode({
    token: "test-token",
    chatId: "123",
    ...files,
    dryRun: true,
    processExisting: false,
    once: true,
    retrySeconds: 0,
    failureWarnThreshold: 5,
    logger: quietLogger(),
    fetchUpdatesImpl: async () => [{
      update_id: 41,
      message: { message_id: 7, date: 1, chat: { id: 123 }, text: "old" }
    }]
  });

  // 起得来，并且把 offset 修回合法值。
  assert.deepEqual(JSON.parse(fs.readFileSync(files.offsetFile, "utf8")), { offset: 42 });
});

test("处理途中崩溃不会让整批消息被 Telegram 重投", async (t) => {
  const files = makeFiles(t);
  const seenOffsets = [];
  let calls = 0;

  await runDirectMode({
    token: "test-token",
    chatId: "123",
    ...files,
    dryRun: true,
    processExisting: true,
    once: true,
    retrySeconds: 0,
    failureWarnThreshold: 5,
    logger: quietLogger(),
    fetchUpdatesImpl: async ({ offset }) => {
      seenOffsets.push(offset);
      calls += 1;
      if (calls > 1) return [];
      return [{
        update_id: 41,
        message: { message_id: 7, date: 1, chat: { id: 123 }, text: "/sfc_scan" }
      }];
    },
    // 模拟看门狗的 Stop-Process -Force：处理途中整个进程没了。
    // 只炸第一轮 —— 第二轮要能正常收尾，否则 once 永远等不到 return。
    processMessagesImpl: async () => {
      if (calls === 1) throw new Error("桥在处理途中被杀");
      return 0;
    }
  });

  // 崩溃发生在 offset 落盘之后，所以下一轮从 42 继续，而不是把 /sfc_scan 再投一遍。
  assert.deepEqual(JSON.parse(fs.readFileSync(files.offsetFile, "utf8")), { offset: 42 });
  assert.equal(seenOffsets[1], 42, "第二轮必须从新 offset 拉，否则就是无限重放");
});

test("runDirectMode does not write an offset when the initial baseline fetch is empty", async (t) => {
  const files = makeFiles(t);

  await runDirectMode({
    token: "test-token",
    chatId: "123",
    ...files,
    dryRun: true,
    processExisting: false,
    once: true,
    retrySeconds: 0,
    failureWarnThreshold: 5,
    logger: quietLogger(),
    fetchUpdatesImpl: async ({ offset }) => {
      assert.equal(offset, -1);
      return [];
    }
  });

  assert.equal(fs.existsSync(files.offsetFile), false);
  const heartbeat = JSON.parse(fs.readFileSync(files.heartbeatFile, "utf8"));
  assert.equal(Number.isFinite(heartbeat.atMs), true);
  assert.equal(heartbeat.offset, -1);
  assert.equal(heartbeat.lastUpdates, 0);
});
