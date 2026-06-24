import fs from "node:fs";
import { envList, envNumber, loadEnv, resolveFromCwd, timestampForFile } from "../env.mjs";
import { fetchGameNews } from "../rss.mjs";
import { sendTelegramMessage } from "../telegram.mjs";
import { classifyPersonalMessage, classifySchoolMessage } from "./classifiers.mjs";
import { collectDeadlines } from "./deadlines.mjs";
import { runGmailExport, runOutlookExport } from "./exporters.mjs";
import { countGameSources, gameKey, gamePrefix, translateGameTitle } from "./game-news.mjs";
import { personalMessagesFromDrops, schoolMessagesFromDrops } from "./mail-drops.mjs";
import { sendOrPrint } from "./notifier.mjs";
import { dueSlots } from "./schedule.mjs";
import { compactLine, formatPersonalSummary, formatSchoolSummary } from "./summaries.mjs";
import { loadState, saveState, statePath } from "./state.mjs";

const DEFAULT_TIME_ZONE = "Australia/Melbourne";

function hasArg(name) {
  return process.argv.includes(name);
}

export function formatGameSummary(items, { slotLabel, timeZone, maxItems = 8 }) {
  const lines = [
    `游戏资讯检查（墨尔本时间 ${slotLabel || "手动"}）`,
    ""
  ];

  if (items.length === 0) {
    lines.push("- 暂无新的游戏资讯。");
    return lines.join("\n");
  }

  for (const item of items.slice(0, maxItems)) {
    const date = item.pubDate ? `｜${new Date(item.pubDate).toISOString().slice(0, 10)}` : "";
    const source = item.source ? `｜${item.source}` : "";
    const link = item.link ? `\n  ${item.link}` : "";
    lines.push(`- [${gamePrefix(item)}] ${translateGameTitle(item.title)}${source}${date}${link}`);
  }

  lines.push("", `时区：${timeZone}`);
  return lines.join("\n");
}

export async function runSchoolCheckCli() {
  loadEnv();

  const now = new Date();
  const dryRun = hasArg("--dry-run");
  const forceSchool = hasArg("--force-school") || hasArg("--school");
  const forceGame = hasArg("--force-game") || hasArg("--game");
  const forcePersonal = hasArg("--force-personal") || hasArg("--personal") || hasArg("--mail");
  const includeSeen = hasArg("--include-seen");
  const checkOnly = hasArg("--check-only");
  const timeZone = process.env.SCHOOL_TIMEZONE || DEFAULT_TIME_ZONE;
  const times = envList("SCHOOL_CHECK_TIMES", ["10:30", "14:00", "20:00"]);
  const graceMinutes = envNumber("SCHOOL_CHECK_GRACE_MINUTES", 25);
  const exportDays = envNumber("SCHOOL_EXPORT_DAYS", 14);
  const exportMaxMessages = envNumber("SCHOOL_EXPORT_MAX_MESSAGES", 60);
  const outlookSyncWaitSeconds = envNumber("OUTLOOK_SYNC_WAIT_SECONDS", 45);
  const gmailExportMaxMessages = envNumber("GMAIL_EXPORT_MAX_MESSAGES", 30);
  const gmailExportQuery = process.env.GMAIL_EXPORT_QUERY || "in:inbox newer_than:7d -category:promotions -category:social -in:drafts";
  const gmailAccount = process.env.GOG_ACCOUNT || "";
  const maxFiles = envNumber("MAIL_DROP_MAX_FILES", 20);
  const reminderMinutes = envNumber("SCHOOL_REMINDER_MINUTES_BEFORE_DUE", 60);
  const sendEmptyCheckSummary = (process.env.SEND_EMPTY_CHECK_SUMMARY || "true").toLowerCase() === "true";
  const schoolCatchupMinutes = envNumber("SCHOOL_SYNC_CATCHUP_MINUTES", 90);
  const gameCatchupMinutes = envNumber("GAME_SYNC_CATCHUP_MINUTES", 120);
  const state = loadState();
  state.slots ||= {};
  state.seenMessageKeys ||= [];
  state.seenPersonalKeys ||= [];
  state.seenGameKeys ||= [];
  state.remindedDeadlineKeys ||= [];
  state.schoolCatchup ||= null;
  state.gameCatchup ||= null;

  const slots = dueSlots({ now, timeZone, times, graceMinutes, state });
  const activeSchoolCatchup = state.schoolCatchup?.until && new Date(state.schoolCatchup.until) > now
    ? state.schoolCatchup
    : null;
  if (state.schoolCatchup && !activeSchoolCatchup) {
    state.schoolCatchup = null;
  }
  const activeGameCatchup = state.gameCatchup?.until && new Date(state.gameCatchup.until) > now
    ? state.gameCatchup
    : null;
  if (state.gameCatchup && !activeGameCatchup) {
    state.gameCatchup = null;
  }

  const shouldExport = forceSchool || slots.length > 0 || Boolean(activeSchoolCatchup);
  let exportOutput = "";
  let telegramMessagesSent = 0;
  let emptyCheckSent = false;

  if (shouldExport && !checkOnly) {
    exportOutput = runOutlookExport({ days: exportDays, maxMessages: exportMaxMessages, syncWaitSeconds: outlookSyncWaitSeconds });
    console.log(exportOutput);
  }

  const messages = schoolMessagesFromDrops(maxFiles);

  const shouldCheckPersonal = forcePersonal || slots.length > 0;
  let personalMessages = [];
  let personalUpdatesSent = 0;
  let personalExportError = "";
  if (shouldCheckPersonal) {
    if (!checkOnly) {
      try {
        const gmailOutput = runGmailExport({
          maxMessages: gmailExportMaxMessages,
          query: gmailExportQuery,
          account: gmailAccount
        });
        console.log(gmailOutput);
      } catch (error) {
        personalExportError = error.message || String(error);
        console.warn(`Gmail export skipped: ${personalExportError}`);
      }
    }

    personalMessages = personalMessagesFromDrops(maxFiles);
    const seenPersonal = new Set(state.seenPersonalKeys);
    const newPersonalMessages = includeSeen
      ? personalMessages
      : personalMessages.filter((message) => !seenPersonal.has(message.key));
    const importantPersonalMessages = newPersonalMessages.filter((message) => classifyPersonalMessage(message).important);
    const skippedLowPriority = Math.max(0, newPersonalMessages.length - importantPersonalMessages.length);
    const slotLabel = forcePersonal ? "手动" : slots.map((slot) => slot.label).join(", ");

    if (importantPersonalMessages.length > 0 || forcePersonal) {
      await sendOrPrint(formatPersonalSummary(importantPersonalMessages, { slotLabel, timeZone, skippedLowPriority }), dryRun);
      telegramMessagesSent += 1;
      personalUpdatesSent = Math.min(importantPersonalMessages.length, 8);
    }

    for (const message of personalMessages) {
      seenPersonal.add(message.key);
    }
    state.seenPersonalKeys = [...seenPersonal].slice(-2000);
  }

  if (shouldExport) {
    const seen = new Set(state.seenMessageKeys);
    const newMessages = includeSeen ? messages : messages.filter((message) => !seen.has(message.key));
    const slotLabel = forceSchool
      ? "手动"
      : (slots.length > 0 ? slots.map((slot) => slot.label).join(", ") : `${activeSchoolCatchup?.slotLabel || "定时"} 补查`);

    if (newMessages.length > 0 || forceSchool) {
      await sendOrPrint(formatSchoolSummary(newMessages, { slotLabel, timeZone }), dryRun);
      telegramMessagesSent += 1;
    }

    for (const message of messages) {
      seen.add(message.key);
    }
    state.seenMessageKeys = [...seen].slice(-2000);

    for (const slot of slots) {
      state.slots[slot.key] = now.toISOString();
    }

    if (!forceSchool && slots.length > 0 && newMessages.length === 0 && schoolCatchupMinutes > 0) {
      const slotLabelForCatchup = slots.map((slot) => slot.label).join(", ");
      state.schoolCatchup = {
        slotKey: slots.map((slot) => slot.key).join(","),
        slotLabel: slotLabelForCatchup,
        startedAt: now.toISOString(),
        until: new Date(now.getTime() + schoolCatchupMinutes * 60000).toISOString()
      };
    }

    if (activeSchoolCatchup && newMessages.length > 0) {
      state.schoolCatchup = null;
    }
  }

  const shouldCheckGames = forceGame || slots.length > 0 || Boolean(activeGameCatchup);
  let gameItems = [];
  let gameUpdatesSent = 0;
  if (shouldCheckGames) {
    gameItems = await fetchGameNews({
      queries: envList("GAME_QUERIES", []),
      excludeTerms: envList("GAME_NEWS_EXCLUDE_TERMS", []),
      maxPerQuery: envNumber("GAME_NEWS_MAX_PER_QUERY", 2),
      locale: process.env.GAME_NEWS_LOCALE || "en-AU",
      ceid: process.env.GAME_NEWS_CEID || "AU:en"
    });

    const seenGames = new Set(state.seenGameKeys);
    const newGameItems = includeSeen ? gameItems : gameItems.filter((item) => !seenGames.has(gameKey(item)));
    const slotLabel = forceGame
      ? "手动"
      : (slots.length > 0 ? slots.map((slot) => slot.label).join(", ") : `${activeGameCatchup?.slotLabel || "定时"} 补查`);

    if (newGameItems.length > 0 || forceGame) {
      await sendOrPrint(formatGameSummary(newGameItems, { slotLabel, timeZone, maxItems: envNumber("GAME_CHECK_MAX_ITEMS", 8) }), dryRun);
      telegramMessagesSent += 1;
      gameUpdatesSent = newGameItems.length;
    }

    for (const item of gameItems) {
      seenGames.add(gameKey(item));
    }
    state.seenGameKeys = [...seenGames].slice(-2000);

    if (!forceGame && slots.length > 0 && gameCatchupMinutes > 0) {
      const slotLabelForCatchup = slots.map((slot) => slot.label).join(", ");
      state.gameCatchup = {
        slotKey: slots.map((slot) => slot.key).join(","),
        slotLabel: slotLabelForCatchup,
        startedAt: now.toISOString(),
        until: new Date(now.getTime() + gameCatchupMinutes * 60000).toISOString()
      };
    }
  }

  const deadlines = collectDeadlines(messages, { now, timeZone });
  const reminded = new Set(state.remindedDeadlineKeys);
  const dueSoon = deadlines.filter((deadline) => {
    const minutesToDue = (deadline.dueAt.getTime() - now.getTime()) / 60000;
    return minutesToDue > 0 && minutesToDue <= reminderMinutes && !reminded.has(deadline.key);
  });

  for (const deadline of dueSoon.slice(0, 5)) {
    const text = [
      "RMIT 临期提醒",
      "",
      `- ${compactLine(deadline.title)}`,
      `- 截止：${deadline.dueLocal}（${timeZone}）`,
      `- 来源：${compactLine(deadline.from)}${deadline.sourceDate ? `｜${deadline.sourceDate}` : ""}`
    ].join("\n");
    await sendOrPrint(text, dryRun);
    telegramMessagesSent += 1;
    reminded.add(deadline.key);
  }

  if (sendEmptyCheckSummary && slots.length > 0 && telegramMessagesSent === 0) {
    const slotLabel = slots.map((slot) => slot.label).join(", ");
    const lines = [
      `定时检查完成（墨尔本时间 ${slotLabel}）`,
      "",
      "- 学校邮件：暂无新的未推送事项。",
      "- 个人 Gmail：暂无新的重要邮件。",
      "- 游戏资讯：暂无新的未推送资讯。",
      ""
    ];

    if (messages.length > 0) {
      lines.push("最近学校事项（非新增）：");
      for (const message of messages.slice(0, 5)) {
        const kind = classifySchoolMessage(message);
        const received = message.date ? `｜${message.date}` : "";
        lines.push(`- [${kind}] ${compactLine(message.subject)}${received}`);
      }
      lines.push("");
    }

    lines.push(`时区：${timeZone}`);
    const text = lines.join("\n");
    await sendOrPrint(text, dryRun);
    telegramMessagesSent += 1;
    emptyCheckSent = true;
  }

  state.remindedDeadlineKeys = [...reminded].slice(-1000);
  if (!dryRun) {
    saveState(state);
  }

  const summary = {
    timezone: timeZone,
    dueSlots: slots.map((slot) => slot.label),
    exported: shouldExport && !checkOnly,
    messages: messages.length,
    deadlines: deadlines.length,
    remindersSent: dueSoon.length,
    personalMessages: personalMessages.length,
    personalUpdatesSent,
    personalExportError,
    gameItems: gameItems.length,
    gameUpdatesSent,
    gameSourceCounts: countGameSources(gameItems),
    latestGameTitles: gameItems.slice(0, 8).map((item) => `${item.game || "游戏"}: ${item.title}`),
    emptyCheckSent,
    telegramMessagesSent,
    schoolCatchupActive: Boolean(state.schoolCatchup),
    schoolCatchupUntil: state.schoolCatchup?.until || null,
    gameCatchupActive: Boolean(state.gameCatchup),
    gameCatchupUntil: state.gameCatchup?.until || null,
    stateFile: statePath()
  };
  fs.mkdirSync(resolveFromCwd("./data/logs"), { recursive: true });
  fs.writeFileSync(
    resolveFromCwd(`./data/logs/school-check-${timestampForFile(now)}.json`),
    JSON.stringify(summary, null, 2),
    "utf8"
  );
  console.log(JSON.stringify(summary, null, 2));
}

export async function reportFatalSchoolCheckError(error) {
    console.error(error.stack || error.message);
    try {
      loadEnv();
      await sendTelegramMessage(`RMIT 学校检查失败：${error.message}`);
    } catch {
      // Keep the original failure visible in stderr.
    }
    process.exitCode = 1;
}
