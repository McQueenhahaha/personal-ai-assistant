import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { processMessageList } from "../src/openclaw-telegram-bridge.mjs";
import { readPauseState } from "../src/state/pause.mjs";

// 桥是全仓改动最频繁的文件、所有命令的入口，却一直零覆盖 —— 每次改都在赌。
// 这里只装五条，不追覆盖率：每一条都对应一种"坏了你未必看得出来"的故障。

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pai-bridge-cmd-"));
  const inbox = path.join(root, "queues", "codex", "inbox");
  const localInbox = path.join(root, "queues", "local", "inbox");
  const previous = {
    PROJECT_ROOT: process.env.PROJECT_ROOT,
    CODEX_QUEUE_INBOX: process.env.CODEX_QUEUE_INBOX,
    LOCAL_QUEUE_INBOX: process.env.LOCAL_QUEUE_INBOX,
    PENDING_APPROVALS_FILE: process.env.PENDING_APPROVALS_FILE
  };
  process.env.PROJECT_ROOT = root;
  process.env.CODEX_QUEUE_INBOX = inbox;
  process.env.LOCAL_QUEUE_INBOX = localInbox;
  process.env.PENDING_APPROVALS_FILE = path.join(root, "pending-approvals.json");
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { root, inbox, stateFile: path.join(root, "bridge-state.json") };
}

function message(overrides = {}) {
  return {
    key: "chat:1",
    chatId: "123",
    messageId: 1,
    date: 1,
    text: "帮我看看今天有什么作业",
    ...overrides
  };
}

function queuedCount(inbox) {
  try {
    return fs.readdirSync(inbox).length;
  } catch {
    return 0;
  }
}

test("别人的 chat 发来的消息一律不执行", async (t) => {
  // 这是五条里唯一有安全含义的：机器人 token 泄漏或被拉进别的群时，
  // 唯一挡着的就是这个 chatId 比对。
  const { inbox, stateFile } = fixture(t);

  const handled = await processMessageList({
    messages: [message({ chatId: "999", text: "/sfc_scan" })],
    stateFile,
    token: "t",
    chatId: "123",
    dryRun: true,
    processExisting: true
  });

  assert.equal(handled, 0, "别人的消息不该被执行");
  assert.equal(queuedCount(inbox), 0, "更不该因此入队任何任务");
});

test("同一条消息出现两次只执行一次", async (t) => {
  // 没有去重的话，一次重投就是 /sfc_scan 跑两遍。
  const { stateFile } = fixture(t);
  const twice = [message({ key: "chat:7" }), message({ key: "chat:7" })];

  const handled = await processMessageList({
    messages: twice,
    stateFile,
    token: "t",
    chatId: "123",
    dryRun: true,
    processExisting: true
  });

  assert.equal(handled, 1);
});

test("单条消息处理抛错时不中断整批，后面的消息照常处理", async (t) => {
  // 没有这层 catch 的话，一条坏消息会让整批静默中断 —— 后面的消息你永远
  // 等不到，而且没有任何提示（异常只落在本机日志里）。
  //
  // 触发方式要真能抛：把 codex 队列目录指到一个「父路径是文件」的位置，
  // 于是入队时 mkdir 失败 —— 磁盘满、权限不足是同一种形状。
  const { root, stateFile } = fixture(t);
  const blocker = path.join(root, "blocker");
  fs.writeFileSync(blocker, "not a directory", "utf8");
  process.env.CODEX_QUEUE_INBOX = path.join(blocker, "inbox");

  const handled = await processMessageList({
    messages: [
      // 自由文本会走 createChatTask —— 入队必然失败
      message({ key: "chat:a", text: "帮我看看今天有什么作业" }),
      // 第二条要选不碰队列的命令：/status 会 ensureQueue，同样撞在坏路径上，
      // 那样测的就不是"隔离"而是"两条都失败"了。
      message({ key: "chat:b", text: "/help" })
    ],
    stateFile,
    token: "t",
    chatId: "123",
    dryRun: true,
    processExisting: true
  });

  assert.ok(handled >= 1, "第一条抛错之后，第二条必须仍被处理到");
});

test("每处理一条就把 seenKeys 落盘", async (t) => {
  // 整批处理完才写的话，中途被杀重启后这些消息又成了"没见过"，
  // 已经执行过的命令会再执行一遍。
  const { stateFile } = fixture(t);

  await processMessageList({
    messages: [message({ key: "chat:x", text: "/status" })],
    stateFile,
    token: "t",
    chatId: "123",
    dryRun: true,
    processExisting: true
  });

  const saved = JSON.parse(fs.readFileSync(stateFile, "utf8"));
  assert.ok(saved.seenKeys.includes("chat:x"), "seenKeys 必须已经落盘");
});

test("/cancel 在没有在跑任务时只回一句话，绝不写暂停状态", async (t) => {
  // 回归护栏：/cancel 退化成 /stop 是最贵的一种回归 —— 用户以为只掐了
  // 一个任务，实际整个助手停了，而且要等到他想起来 /resume 才恢复。
  // 2026-08-04 就这么静默停了两个小时。
  const { root, stateFile } = fixture(t);

  await processMessageList({
    messages: [message({ key: "chat:c", text: "/cancel" })],
    stateFile,
    token: "t",
    chatId: "123",
    dryRun: true,
    processExisting: true
  });

  assert.equal(readPauseState(root).level, "none", "/cancel 绝不能把助手停掉");
});
