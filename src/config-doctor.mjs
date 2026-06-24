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

export function reportConfig(env = process.env) {
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
      feature: "学校邮件(Outlook/RMIT)",
      ok: schoolTimesReady,
      detail: schoolTimesReady ? `已配置 ✓，drop dir ${schoolDropDir}` : "未配置定时学校检查"
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
