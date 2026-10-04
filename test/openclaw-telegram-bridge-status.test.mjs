import { test } from "node:test";
import assert from "node:assert/strict";
import { summarizeStatus } from "../src/openclaw-telegram-bridge.mjs";

function statusDependencies(selfId, remoteOnline) {
  const remoteId = selfId === "mac" ? "windows" : "mac";
  return {
    selfId,
    dataDir: "test-data",
    localInbox: "local-inbox",
    codexInbox: "codex-inbox",
    existsSync: () => false,
    ensureQueue() {},
    listPendingTasks: () => [],
    loadLease: async () => null,
    readBridgeLogSummary: () => null,
    codeVersion: null,
    probes: {
      [selfId]: async () => {
        throw new Error("summarizeStatus must not probe itself");
      },
      [remoteId]: async () => remoteOnline
    }
  };
}

test("summarizeStatus reports the Mac brain as local and never as offline", async () => {
  const status = await summarizeStatus(statusDependencies("mac", false));
  const remoteAvailable = await summarizeStatus(statusDependencies("mac", true));

  assert.match(status, /当前运行节点：这台 Mac/);
  assert.match(status, /文件 \/ Codex \/ Canvas \/ 图形操控：可用（本机）/);
  assert.match(status, /浏览器 \/ 屏幕查看 \/ Outlook \/ 系统维护：这个功能需要另一台电脑，它当前离线/);
  assert.doesNotMatch(status, /Mac(?:Book)?[^\n]*离线/);
  assert.match(remoteAvailable, /浏览器 \/ 屏幕查看 \/ Outlook \/ 系统维护：需要另一台电脑，当前可用/);
});

test("summarizeStatus keeps every current Windows capability locally available", async () => {
  const status = await summarizeStatus(statusDependencies("windows", false));

  assert.match(status, /当前运行节点：这台 Windows 电脑/);
  assert.match(status, /文件 \/ Codex \/ Canvas \/ 图形操控：可用（本机）/);
  assert.match(status, /浏览器 \/ 屏幕查看 \/ Outlook \/ 系统维护：可用（本机）/);
  assert.doesNotMatch(status, /这台 Windows 电脑[^\n]*离线/);
});

test("summarizeStatus shows the health block right under the running node", async () => {
  const nowMs = Date.parse("2026-10-04T06:00:00.000Z");
  const status = await summarizeStatus({
    ...statusDependencies("windows", true),
    now: () => nowMs,
    loadLease: async () => ({ holder: "windows", heartbeatAt: new Date(nowMs - 5_000).toISOString(), ttlSeconds: 90, reason: "renew" }),
    readBridgeLogSummary: () => ({ conflicts: 12, starts: 1, lastError: "Error: Telegram HTTP request failed 409" }),
    codeVersion: "622fb5c"
  });
  const lines = status.split("\n");
  const nodeLine = lines.indexOf("当前运行节点：这台 Windows 电脑");

  assert.equal(lines[nodeLine + 1], "大脑：Windows（租约心跳 5 秒前）");
  assert.match(lines[nodeLine + 2], /^桥：.*12 次 Telegram 409 冲突/);
  assert.equal(lines[nodeLine + 3], "最近错误：Error: Telegram HTTP request failed 409");
  assert.equal(lines[nodeLine + 4], "代码版本：622fb5c");
});
