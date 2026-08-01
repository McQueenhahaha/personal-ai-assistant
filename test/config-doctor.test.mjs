import { test } from "node:test";
import assert from "node:assert/strict";
import { formatConfigReport, reportConfig } from "../src/config-doctor.mjs";

test("reportConfig marks configured features as online", () => {
  const report = reportConfig({
    TELEGRAM_BOT_TOKEN: " token ",
    TELEGRAM_CHAT_ID: " chat ",
    ENABLE_AI_DIGEST: "yes",
    LOCAL_MODEL: " qwen3:8b ",
    ENABLE_OPENAI_FALLBACK: "on",
    OPENAI_API_KEY: " sk-test ",
    SCHOOL_CHECK_TIMES: "10:30,14:00",
    SCHOOL_MAIL_DROP_DIR: " ./tmp/school ",
    GOG_ACCOUNT: " user@gmail.com ",
    CODEX_QUEUE_INBOX: " ./tmp/codex-inbox "
  });

  assert.deepEqual(report, [
    {
      feature: "Telegram 通知",
      ok: true,
      detail: "在线 ✓"
    },
    {
      feature: "AI 摘要(本地 Ollama)",
      ok: true,
      detail: "在线 ✓，模型 qwen3:8b，OpenAI fallback 已配置"
    },
    {
      feature: "学校邮件(Outlook)",
      ok: true,
      detail: "已配置 ✓，drop dir ./tmp/school"
    },
    {
      feature: "个人邮件(Gmail)",
      ok: true,
      detail: "已配置 ✓"
    },
    {
      feature: "Codex 队列 worker",
      ok: true,
      detail: "启用 ✓，inbox ./tmp/codex-inbox"
    }
  ]);

  assert.equal(
    formatConfigReport(report),
    [
      "[config] Telegram 通知: 在线 ✓",
      "[config] AI 摘要(本地 Ollama): 在线 ✓，模型 qwen3:8b，OpenAI fallback 已配置",
      "[config] 学校邮件(Outlook): 已配置 ✓，drop dir ./tmp/school",
      "[config] 个人邮件(Gmail): 已配置 ✓",
      "[config] Codex 队列 worker: 启用 ✓，inbox ./tmp/codex-inbox"
    ].join("\n")
  );
});

test("reportConfig marks missing optional config as degraded without throwing", () => {
  const report = reportConfig({
    TELEGRAM_BOT_TOKEN: "token",
    TELEGRAM_CHAT_ID: " ",
    ENABLE_AI_DIGEST: "true",
    LOCAL_MODEL: " ",
    ENABLE_OPENAI_FALLBACK: "1",
    OPENAI_API_KEY: "",
    SCHOOL_CHECK_TIMES: "",
    GOG_ACCOUNT: "\t",
    CODEX_QUEUE_INBOX: ""
  });

  assert.deepEqual(report, [
    {
      feature: "Telegram 通知",
      ok: false,
      detail: "降级 → 打印到控制台"
    },
    {
      feature: "AI 摘要(本地 Ollama)",
      ok: false,
      detail: "降级 → 确定性摘要，OpenAI fallback 未配置"
    },
    {
      feature: "学校邮件(Outlook)",
      ok: false,
      detail: "未配置定时学校检查"
    },
    {
      feature: "个人邮件(Gmail)",
      ok: false,
      detail: "未配置 → 跳过个人邮件"
    },
    {
      feature: "Codex 队列 worker",
      ok: true,
      detail: "启用 ✓，inbox ./data/queues/codex/inbox"
    }
  ]);
});
