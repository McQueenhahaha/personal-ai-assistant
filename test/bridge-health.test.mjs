import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  checkBridgeHealth,
  decideBridgeHealth,
  formatHealthLines,
  nextHealthAlert,
  summarizeBridgeLog
} from "../src/telegram/bridge-health.mjs";

const NOW_MS = Date.parse("2026-10-04T06:00:00.000Z");
const CONFLICT_MSG = "Telegram 直连拉取失败（连续 1 次）：\nError: Telegram HTTP request failed 409: {\"ok\":false,\"error_code\":409}\n    at IncomingMessage.<anonymous> (file:///D:/x/http.mjs:97:20)";

function record(minutesAgo, level, msg) {
  return JSON.stringify({ at: new Date(NOW_MS - minutesAgo * 60_000).toISOString(), level, msg });
}

function started(minutesAgo) {
  return record(minutesAgo, "info", "OpenClaw Telegram bridge started.");
}

test("summarizeBridgeLog counts recent 409s, starts in the hour, and keeps the last error readable", () => {
  const summary = summarizeBridgeLog([
    started(90),
    record(20, "error", CONFLICT_MSG),
    started(50),
    "not json",
    record(10, "error", CONFLICT_MSG),
    record(5, "info", "Telegram 直连拉取到 1 条新消息（文本 1 条，处理 1 条）。"),
    started(2),
    record(1, "error", CONFLICT_MSG),
    record(-5, "error", CONFLICT_MSG)
  ], NOW_MS);

  assert.equal(summary.conflicts, 2, "only 409s within 15 minutes, none from the future");
  assert.equal(summary.starts, 2, "only starts within 60 minutes");
  assert.equal(
    summary.lastError,
    "Telegram 直连拉取失败（连续 1 次）： Error: Telegram HTTP request failed 409: {\"ok\":false,\"error_code\":409}"
  );
});

test("decideBridgeHealth names the cause: 409 conflict first, then restart flapping", () => {
  const conflict = decideBridgeHealth({ conflicts: 5, starts: 9, lastError: "x" });
  assert.equal(conflict.health, "conflict");
  assert.match(conflict.text, /409/);
  assert.match(conflict.text, /脑裂/);

  const flapping = decideBridgeHealth({ conflicts: 4, starts: 4, lastError: "Error: ECONNRESET" });
  assert.equal(flapping.health, "flapping");
  assert.match(flapping.text, /4 次/);
  assert.match(flapping.text, /ECONNRESET/);

  assert.equal(decideBridgeHealth({ conflicts: 4, starts: 3, lastError: null }).health, "healthy");
});

test("nextHealthAlert alerts once per episode and once on recovery", () => {
  const conflict = { health: "conflict", text: "conflict!" };
  const flapping = { health: "flapping", text: "flapping!" };
  const healthy = { health: "healthy" };

  assert.equal(nextHealthAlert(null, healthy), null);
  assert.equal(nextHealthAlert("healthy", conflict), "conflict!");
  assert.equal(nextHealthAlert("conflict", conflict), null);
  assert.equal(nextHealthAlert("conflict", flapping), "flapping!");
  assert.match(nextHealthAlert("conflict", healthy), /恢复/);
  assert.match(nextHealthAlert("flapping", healthy), /恢复/);
  assert.equal(nextHealthAlert("healthy", healthy), null);
});

function tempFiles() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pai-bridge-health-"));
  return {
    bridgeLogFile: path.join(dir, "openclaw-telegram-bridge.jsonl"),
    healthStateFile: path.join(dir, "state", "bridge-health.json")
  };
}

test("replaying a split-brain episode sends exactly two alerts, the first naming 409", async () => {
  const files = tempFiles();
  const sent = [];
  const logs = [];
  const dependencies = {
    ...files,
    sendTelegramMessage: async (text) => { sent.push(text); return { sent: true }; },
    appendLog: (entry) => logs.push(entry)
  };
  const storm = [started(30)];
  for (let minute = 12; minute >= 0; minute -= 0.5) storm.push(record(minute, "error", CONFLICT_MSG));
  fs.writeFileSync(files.bridgeLogFile, `${storm.join("\n")}\n`);

  for (let round = 0; round < 3; round += 1) {
    await checkBridgeHealth({ nowMs: NOW_MS + round * 300_000 }, dependencies);
  }
  fs.writeFileSync(files.bridgeLogFile, `${started(30)}\n${record(1, "info", "直连轮询存活（offset=1）")}\n`);
  for (let round = 0; round < 3; round += 1) {
    await checkBridgeHealth({ nowMs: NOW_MS + round * 300_000 }, dependencies);
  }

  assert.equal(sent.length, 2);
  assert.match(sent[0], /409/);
  assert.match(sent[1], /恢复/);
  assert.ok(logs.every((entry) => !("state" in entry)), "must not disturb readLastLoggedState");
});

test("a failed alert is not recorded as delivered and is retried next round", async () => {
  const files = tempFiles();
  const lines = [];
  for (let minute = 10; minute >= 0; minute -= 1) lines.push(record(minute, "error", CONFLICT_MSG));
  fs.writeFileSync(files.bridgeLogFile, `${lines.join("\n")}\n`);
  const attempts = [];
  const logs = [];
  const base = { ...files, appendLog: (entry) => logs.push(entry) };

  await checkBridgeHealth({ nowMs: NOW_MS }, {
    ...base,
    sendTelegramMessage: async (text) => { attempts.push(text); return { sent: false, reason: "offline" }; }
  });
  await checkBridgeHealth({ nowMs: NOW_MS }, {
    ...base,
    sendTelegramMessage: async (text) => { attempts.push(text); return { sent: true }; }
  });

  assert.equal(attempts.length, 2);
  assert.deepEqual(logs.map((entry) => entry.event), ["health-alert-failed", "health-alert-sent"]);
});

test("no JSONL log yet means no judgement and no alert", async () => {
  const files = tempFiles();
  const result = await checkBridgeHealth({ nowMs: NOW_MS }, {
    ...files,
    sendTelegramMessage: async () => assert.fail("no alert without a log"),
    appendLog: () => assert.fail("nothing to log")
  });

  assert.deepEqual(result, { checked: false });
});

test("formatHealthLines shows who holds the brain, bridge health, last error and code version", () => {
  const lease = { holder: "windows", heartbeatAt: new Date(NOW_MS - 12_000).toISOString(), ttlSeconds: 90, reason: "renew" };

  assert.deepEqual(formatHealthLines({
    lease,
    nowMs: NOW_MS,
    bridgeLog: { conflicts: 0, starts: 1, lastError: null },
    codeVersion: "622fb5c"
  }), [
    "大脑：Windows（租约心跳 12 秒前）",
    "桥：正常（近 1 小时启动 1 次）",
    "最近错误：近 1 小时无",
    "代码版本：622fb5c"
  ]);

  const troubled = formatHealthLines({
    lease: { ...lease, holder: "mac", heartbeatAt: new Date(NOW_MS - 300_000).toISOString() },
    nowMs: NOW_MS,
    bridgeLog: { conflicts: 9, starts: 1, lastError: "Error: Telegram HTTP request failed 409" },
    codeVersion: null
  });
  assert.equal(troubled[0], "大脑：Mac（⚠️ 租约已过期 5 分钟）");
  assert.match(troubled[1], /^桥：.*409/);
  assert.equal(troubled[2], "最近错误：Error: Telegram HTTP request failed 409");
  assert.equal(troubled[3], "代码版本：未知");
});

test("formatHealthLines degrades gracefully without a lease or a JSONL log", () => {
  assert.deepEqual(formatHealthLines({ lease: null, nowMs: NOW_MS, bridgeLog: null, codeVersion: "abc1234（含未提交改动）" }), [
    "大脑：⚠️ 没有有效租约",
    "代码版本：abc1234（含未提交改动）"
  ]);
});
