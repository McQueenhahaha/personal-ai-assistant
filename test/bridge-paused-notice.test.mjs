import { test } from "node:test";
import assert from "node:assert/strict";
import {
  formatPausedNotice,
  readPausedAt,
  summarizeStatus
} from "../src/openclaw-telegram-bridge.mjs";

// 背景：用户 2026-08-03 15:38 按下 /stop 后忘记恢复，助手停了 6 小时才被发现 ——
// 因为 /status 当时完全不提暂停这件事。这些测试守住"停着一定看得见"。

test("formatPausedNotice stays empty when the assistant is not paused", () => {
  assert.equal(formatPausedNotice({ pausedAt: null }), "");
  assert.equal(formatPausedNotice({}), "");
});

test("formatPausedNotice renders the local time the pause started", () => {
  const notice = formatPausedNotice({
    pausedAt: "2026-08-03T05:38:06.518Z",
    timeZone: "Australia/Melbourne"
  });
  assert.match(notice, /^🛑 已急停（08\/03 15:38 起）/);
  assert.match(notice, /\/resume/);
});

test("formatPausedNotice still warns when the timestamp is unusable", () => {
  // 知道"停着"比知道"何时停的"重要得多，坏时间戳不能让提示消失。
  for (const pausedAt of ["", "garbage", "2026-13-45T99:99:99Z"]) {
    const notice = formatPausedNotice({ pausedAt });
    assert.match(notice, /已急停/, `pausedAt=${JSON.stringify(pausedAt)}`);
    assert.match(notice, /\/resume/);
  }
});

test("readPausedAt distinguishes missing file from unreadable content", () => {
  assert.equal(readPausedAt("whatever", () => false), null);
  assert.equal(readPausedAt("whatever", () => true, () => "2026-08-03T05:38:06.518Z"), "2026-08-03T05:38:06.518Z");
  assert.equal(readPausedAt("whatever", () => true, () => { throw new Error("boom"); }), "");
});

function statusDependencies({ paused }) {
  return {
    selfId: "windows",
    platform: "win32",
    dataDir: "test-data",
    localInbox: "local-inbox",
    codexInbox: "codex-inbox",
    env: { SCHOOL_TIMEZONE: "Australia/Melbourne" },
    existsSync: (file) => paused && String(file).includes("assistant-paused.flag"),
    readFile: () => "2026-08-03T05:38:06.518Z",
    ensureQueue() {},
    listPendingTasks: () => [],
    probes: { windows: async () => true, mac: async () => false }
  };
}

test("summarizeStatus puts the pause notice on the very first line", async () => {
  const text = await summarizeStatus(statusDependencies({ paused: true }));
  const first = text.split("\n")[0];
  assert.match(first, /🛑 已急停/, "暂停提示必须在最开头，混在 flag 列表里不够显眼");
});

test("summarizeStatus omits the pause notice when running normally", async () => {
  const text = await summarizeStatus(statusDependencies({ paused: false }));
  assert.equal(text.includes("已急停"), false);
  assert.match(text.split("\n")[0], /AI 助手状态/);
});
