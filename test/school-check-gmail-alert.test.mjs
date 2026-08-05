import fs from "node:fs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { shouldAlertGmailFailure } from "../src/school/workflow.mjs";

test("gmail failure alert waits for the minimum streak", () => {
  assert.equal(shouldAlertGmailFailure(2, null, 0), false);
});

test("gmail failure alert allows the first alert at the minimum streak", () => {
  assert.equal(shouldAlertGmailFailure(3, null, 0), true);
});

test("gmail failure alert is blocked during cooldown", () => {
  assert.equal(shouldAlertGmailFailure(3, new Date(0).toISOString(), 1 * 3600000), false);
});

test("gmail failure alert is allowed after cooldown", () => {
  assert.equal(shouldAlertGmailFailure(3, new Date(0).toISOString(), 25 * 3600000), true);
});

test("Outlook 连续失败也要告警 —— 接线必须在（源码守卫）", () => {
  // 这条守的是**接线**，不是判定逻辑：判定复用的就是上面那个
  // shouldAlertGmailFailure，已经被测过了。而接线（累计 streak、到阈值发消息、
  // 记冷却时间）走的是 runSchoolCheckCli 全流程，进程内没法便宜地跑起来。
  //
  // 它守的东西很具体：Outlook 失败原先只写 schoolExportError 并 console.warn，
  // 之后再没人读 —— 学校邮件可以连着几天读不出来而你完全不知道，
  // 唯一的迹象是"最近怎么没学校邮件"，而那和"确实没有新邮件"长得一样。
  const source = fs.readFileSync(
    new URL("../src/school/workflow.mjs", import.meta.url),
    "utf8"
  );
  assert.match(source, /state\.outlookFailStreak \|\|= 0/, "缺少 streak 初始化");
  assert.match(source, /state\.outlookFailStreak \+= 1/, "失败时没有累计");
  assert.match(source, /state\.outlookFailStreak = 0/, "成功时没有清零");
  assert.match(
    source,
    /shouldAlertGmailFailure\(state\.outlookFailStreak/,
    "没有接上告警判定"
  );
  assert.match(source, /state\.lastOutlookAlertAt = /, "没有记录冷却时间");
});
