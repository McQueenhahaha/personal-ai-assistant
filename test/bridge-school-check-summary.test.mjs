import { test } from "node:test";
import assert from "node:assert/strict";
import { summarizeSchoolCheck } from "../src/openclaw-telegram-bridge.mjs";

// 2026-08-21 用户实际收到的那条回执：67 封个人邮件全被 seenPersonalKeys 去重挡下，
// 于是没有任何邮件内容，只有 [config] 自检行和一坨 JSON 裸奔过去 —— 看着像坏了。
const REAL_OUTPUT = `[config] Telegram 通知: 在线 ✓
[config] 学校邮件(Outlook): 已配置 ✓，drop dir ./data/school-mail-drop
[config] 个人邮件(Gmail): 已配置 ✓
Exported Gmail snapshot to D:\\AI\\personal-ai-assistant\\data\\personal-mail-drop\\gmail-snapshot.md
{
  "messages": 48,
  "personalMessages": 67,
  "personalUpdatesSent": 0,
  "remindersSent": 0,
  "gameItems": 0,
  "gameUpdatesSent": 0,
  "schoolExportError": "",
  "personalExportError": "",
  "telegramMessagesSent": 0
}`;

test("没有新内容时必须明说，而不是把日志回灌给用户", () => {
  const summary = summarizeSchoolCheck(REAL_OUTPUT);
  assert.match(summary, /没有新内容/);
  assert.match(summary, /个人邮件：67 封/);
  assert.match(summary, /学校邮件：48 封/);
  // 这两样是给控制台看的，不该出现在 Telegram 回执里
  assert.doesNotMatch(summary, /\[config\]/);
  assert.doesNotMatch(summary, /Exported Gmail snapshot/);
});

test("导出失败要显式告警，不能混在数字里被忽略", () => {
  const output = JSON.stringify({
    messages: 0,
    personalMessages: 12,
    personalUpdatesSent: 0,
    remindersSent: 0,
    gameItems: 0,
    gameUpdatesSent: 0,
    schoolExportError: "REGDB_E_CLASSNOTREG",
    personalExportError: "",
    telegramMessagesSent: 0
  });
  const summary = summarizeSchoolCheck(output);
  assert.match(summary, /⚠️ 学校邮件导出失败：REGDB_E_CLASSNOTREG/);
});

test("推送了内容就报条数", () => {
  const summary = summarizeSchoolCheck(JSON.stringify({
    messages: 3,
    personalMessages: 5,
    personalUpdatesSent: 2,
    remindersSent: 1,
    gameItems: 0,
    gameUpdatesSent: 0,
    telegramMessagesSent: 3
  }));
  assert.match(summary, /已推送 3 条。/);
  assert.doesNotMatch(summary, /没有新内容/);
});

// /digest 走的是另一个脚本，输出不是这个结构；认不出就必须退回原样，
// 否则用户发了命令什么回执都收不到。
test("认不出结构时返回 null，由调用方退回原输出", () => {
  assert.equal(summarizeSchoolCheck("Digest sent to Telegram."), null);
  assert.equal(summarizeSchoolCheck(""), null);
  assert.equal(summarizeSchoolCheck(null), null);
  assert.equal(summarizeSchoolCheck("{ 坏掉的 json"), null);
});
