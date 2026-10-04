import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { formatLogLine, installFileLogging } from "../src/logging.mjs";

const NOW = new Date("2026-10-04T06:00:00.000Z");

function parse(line) {
  assert.ok(line.endsWith("\n"), "each record must be one newline-terminated line");
  return JSON.parse(line);
}

test("formatLogLine writes one JSON record with time, level and util.format message", () => {
  const record = parse(formatLogLine("info", ["拉取到 %d 条", 3, { a: 1 }], NOW));

  assert.deepEqual(record, { at: NOW.toISOString(), level: "info", msg: "拉取到 3 条 { a: 1 }" });
});

test("formatLogLine keeps multi-line errors inside a single record", () => {
  const line = formatLogLine("error", [new Error("409 Conflict")], NOW);

  assert.equal(line.trimEnd().split("\n").length, 1);
  assert.match(parse(line).msg, /^Error: 409 Conflict\n\s+at /);
});

test("formatLogLine lifts a legacy '[iso] LEVEL ' prefix into the record", () => {
  const record = parse(formatLogLine("info", ["[2026-10-04T05:00:00.000Z] WARN 推送灵魂包失败"], NOW));

  assert.equal(record.level, "warn");
  assert.equal(record.msg, "推送灵魂包失败");
  assert.equal(record.at, NOW.toISOString());
});

test("installFileLogging routes console methods to UTF-8 JSONL by level", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pai-logging-"));
  const file = path.join(dir, "logs", "bridge.jsonl");
  const target = {};

  installFileLogging(file, { target });
  target.log("当前模式：Telegram 直连模式");
  target.warn("警告");
  target.error("失败");

  const bytes = fs.readFileSync(file);
  assert.equal(bytes.includes(0), false, "no UTF-16 NUL bytes");
  const records = bytes.toString("utf8").trimEnd().split("\n").map((line) => JSON.parse(line));
  assert.deepEqual(records.map(({ level, msg }) => [level, msg]), [
    ["info", "当前模式：Telegram 直连模式"],
    ["warn", "警告"],
    ["error", "失败"]
  ]);
});

test("installFileLogging rotates to .1 once the file would exceed maxBytes", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pai-logging-"));
  const file = path.join(dir, "bridge.jsonl");
  const rotated = path.join(dir, "bridge.1.jsonl");
  fs.writeFileSync(file, "x".repeat(150));
  fs.writeFileSync(rotated, "stale");
  const target = {};

  installFileLogging(file, { target, maxBytes: 200 });
  target.log("a".repeat(80));

  assert.equal(fs.readFileSync(rotated, "utf8"), "x".repeat(150));
  assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).msg, "a".repeat(80));
});
