const DEFAULT_SCHOOL_MAIL_DROP_DIR = "./data/school-mail-drop";
const DEFAULT_CODEX_QUEUE_INBOX = "./data/queues/codex/inbox";
const TRUE_VALUES = new Set(["1", "true", "yes", "on"]);

function envText(env, name) {
  const value = env?.[name];
  if (value == null) return "";
  return String(value).trim();
}

function envFlag(env, name) {
  return TRUE_VALUES.has(envText(env, name).toLowerCase());
}

function fallbackStatus(env) {
  return envFlag(env, "ENABLE_OPENAI_FALLBACK") && envText(env, "OPENAI_API_KEY")
    ? "OpenAI fallback 已配置"
    : "OpenAI fallback 未配置";
}

/**
 * `state` 可选：传入 school-check 的运行状态后，学校邮件那行才会反映**真实**结果
 * 而不只是「.env 填了没」。不传则退化成纯配置检查（index.mjs 就是这么调的）。
 *
 * 为什么需要它（2026-08-21 实测）：Outlook 走 COM，重装系统后没装桌面版 Office，
 * COM 直接 REGDB_E_CLASSNOTREG，学校邮件从 8-18 起再没进来过。可这一行始终显示
 * 「已配置 ✓」—— 因为它只看 SCHOOL_CHECK_TIMES 填没填。用户盯着一片绿，
 * 而真实故障被盖了两天。这正是下面 outlookFailStreak 那条注释警告的情形：
 * 「读不出来」和「确实没有新邮件」长得一模一样。
 */
export function reportConfig(env = process.env, state = null) {
  const outlookFailStreak = Number(state?.outlookFailStreak) || 0;
  const lastOutlookExportAt = state?.lastOutlookExportAt || null;
  const telegramReady = Boolean(envText(env, "TELEGRAM_BOT_TOKEN") && envText(env, "TELEGRAM_CHAT_ID"));
  const localModel = envText(env, "LOCAL_MODEL");
  const aiReady = envFlag(env, "ENABLE_AI_DIGEST") && Boolean(localModel);
  const schoolTimesReady = Boolean(envText(env, "SCHOOL_CHECK_TIMES"));
  const schoolDropDir = envText(env, "SCHOOL_MAIL_DROP_DIR") || DEFAULT_SCHOOL_MAIL_DROP_DIR;
  const gmailReady = Boolean(envText(env, "GOG_ACCOUNT"));
  const codexInbox = envText(env, "CODEX_QUEUE_INBOX") || DEFAULT_CODEX_QUEUE_INBOX;

  return [
    {
      feature: "Telegram 通知",
      ok: telegramReady,
      detail: telegramReady ? "在线 ✓" : "降级 → 打印到控制台"
    },
    {
      feature: "AI 摘要(本地 Ollama)",
      ok: aiReady,
      detail: aiReady
        ? `在线 ✓，模型 ${localModel}，${fallbackStatus(env)}`
        : `降级 → 确定性摘要，${fallbackStatus(env)}`
    },
    {
      feature: "学校邮件(Outlook)",
      ok: schoolTimesReady && outlookFailStreak === 0,
      detail: !schoolTimesReady
        ? "未配置定时学校检查"
        : outlookFailStreak > 0
          ? `导出失败 ${outlookFailStreak} 次 ✗，最后成功：${lastOutlookExportAt || "从未"}`
          : `已配置 ✓，drop dir ${schoolDropDir}`
    },
    {
      feature: "个人邮件(Gmail)",
      ok: gmailReady,
      detail: gmailReady ? "已配置 ✓" : "未配置 → 跳过个人邮件"
    },
    {
      feature: "Codex 队列 worker",
      ok: true,
      detail: `启用 ✓，inbox ${codexInbox}`
    }
  ];
}

export function formatConfigReport(report) {
  return report.map((item) => `[config] ${item.feature}: ${item.detail}`).join("\n");
}
