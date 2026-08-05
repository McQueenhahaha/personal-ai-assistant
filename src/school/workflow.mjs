import fs from "node:fs";
import { createHash } from "node:crypto";
import { formatConfigReport, reportConfig } from "../config-doctor.mjs";
import { envList, envNumber, loadEnv, resolveFromCwd, timestampForFile } from "../env.mjs";
import { fetchGameNews } from "../rss.mjs";
import { sendTelegramMessage } from "../telegram.mjs";
import { isPaused } from "../state/pause.mjs";
import { classifyPersonalMessage, classifySchoolMessage } from "./classifiers.mjs";
import { collectDeadlines } from "./deadlines.mjs";
import { runGmailExport, runOutlookExport } from "./exporters.mjs";
import { countGameSources, gameKey, gamePrefix, translateGameTitle } from "./game-news.mjs";
import { personalMessagesFromDrops, schoolMessagesFromDrops } from "./mail-drops.mjs";
import { sendOrPrint } from "./notifier.mjs";
import { dueSlots, parseClock } from "./schedule.mjs";
import { compactLine, formatCombinedDigest } from "./summaries.mjs";
import { loadState, saveState, statePath } from "./state.mjs";

const DEFAULT_TIME_ZONE = "UTC";
const DIGEST_MIN_INTERVAL_MS = 5 * 60000;

function hasArg(name) {
  return process.argv.includes(name);
}

export function outlookExportThrottled(lastExportIso, nowMs, minMinutes) {
  if (!lastExportIso) return false;
  const last = new Date(lastExportIso).getTime();
  if (!Number.isFinite(last)) return false;
  return (nowMs - last) < minMinutes * 60000;
}

export function shouldAlertGmailFailure(streak, lastAlertIso, nowMs, minStreak = 3, cooldownMs = 24 * 3600000) {
  if (streak < minStreak) return false;
  if (!lastAlertIso) return true;
  const last = new Date(lastAlertIso).getTime();
  if (!Number.isFinite(last)) return true;
  return (nowMs - last) >= cooldownMs;
}

export function digestContentKey({ schoolMessages = [], personalMessages = [], gameItems = [] }) {
  const identities = [
    ...schoolMessages.map((message) => `school:${message.key || JSON.stringify([message.subject, message.from, message.date, message.body])}`),
    ...personalMessages.map((message) => `personal:${message.key || JSON.stringify([message.subject, message.from, message.date, message.body])}`),
    ...gameItems.map((item) => `game:${gameKey(item)}`)
  ];
  const canonical = [...new Set(identities)].sort();
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

export function shouldSendDigest({ contentKey, lastSentKey, lastSentAtMs, nowMs, minIntervalMs }) {
  if (contentKey === lastSentKey) {
    return { send: false, reason: "same-content" };
  }

  const previousSentAt = lastSentAtMs === null || lastSentAtMs === undefined ? Number.NaN : Number(lastSentAtMs);
  if (Number.isFinite(previousSentAt) && (nowMs - previousSentAt) < minIntervalMs) {
    return { send: false, reason: "too-soon" };
  }

  return { send: true, reason: lastSentKey ? "new-content" : "first-send" };
}

export function updateGameCatchup({ activeCatchup, slots, newItemCount, catchupMinutes, nowMs, force }) {
  if (activeCatchup && newItemCount > 0) {
    return null;
  }

  if (!force && slots.length > 0 && newItemCount === 0 && catchupMinutes > 0) {
    return {
      slotKey: slots.map((slot) => slot.key).join(","),
      slotLabel: slots.map((slot) => slot.label).join(", "),
      startedAt: new Date(nowMs).toISOString(),
      until: new Date(nowMs + catchupMinutes * 60000).toISOString()
    };
  }

  return activeCatchup || null;
}

export function formatGameSummary(items, { slotLabel, timeZone, maxItems = 8 }) {
  const lines = [
    `游戏资讯检查（${timeZone} ${slotLabel || "手动"}）`,
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
  if (isPaused()) {
    console.log("[school-check] 已暂停, 跳过本次。");
    return;
  }

  console.log(formatConfigReport(reportConfig()));

  const now = new Date();
  const dryRun = hasArg("--dry-run");
  const forceSchool = hasArg("--force-school") || hasArg("--school");
  const forceGame = hasArg("--force-game") || hasArg("--game");
  const forcePersonal = hasArg("--force-personal") || hasArg("--personal") || hasArg("--mail");
  const includeSeen = hasArg("--include-seen");
  const checkOnly = hasArg("--check-only");
  const timeZone = process.env.SCHOOL_TIMEZONE || DEFAULT_TIME_ZONE;
  const times = envList("SCHOOL_CHECK_TIMES", ["10:30", "14:00", "20:00"]);
  const gameNewsTimes = envList("GAME_NEWS_SLOTS", ["20:00"]);
  const graceMinutes = envNumber("SCHOOL_CHECK_GRACE_MINUTES", 25);
  const exportDays = envNumber("SCHOOL_EXPORT_DAYS", 14);
  const exportMaxMessages = envNumber("SCHOOL_EXPORT_MAX_MESSAGES", 60);
  const outlookSyncWaitSeconds = envNumber("OUTLOOK_SYNC_WAIT_SECONDS", 45);
  const outlookMinMinutes = envNumber("OUTLOOK_MIN_EXPORT_MINUTES", 30);
  const gmailExportMaxMessages = envNumber("GMAIL_EXPORT_MAX_MESSAGES", 30);
  const gmailExportQuery = process.env.GMAIL_EXPORT_QUERY || "in:inbox newer_than:7d -category:promotions -category:social -in:drafts";
  const gmailAccount = process.env.GOG_ACCOUNT || "";
  const maxFiles = envNumber("MAIL_DROP_MAX_FILES", 20);
  const reminderMinutes = envNumber("SCHOOL_REMINDER_MINUTES_BEFORE_DUE", 60);
  const sendEmptyCheckSummary = (process.env.SEND_EMPTY_CHECK_SUMMARY || "false").toLowerCase() === "true";
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
  state.lastOutlookExportAt ||= null;
  state.gmailFailStreak ||= 0;
  state.lastGmailAuthAlertAt ||= null;
  // Outlook 一直没有告警：它失败只写 schoolExportError 并 console.warn，
  // 之后再没人读它 —— 学校邮件可以连着几天读不出来而你完全不知道，
  // 唯一的迹象是"最近怎么没学校邮件"，而那恰好和"确实没有新邮件"长得一样。
  state.outlookFailStreak ||= 0;
  state.lastOutlookAlertAt ||= null;
  state.lastDigestKey ||= null;
  state.lastDigestSentAt ||= null;

  const slots = dueSlots({ now, timeZone, times, graceMinutes, state });
  const gameSlots = dueSlots({ now, timeZone, times: gameNewsTimes, graceMinutes, state });
  const scheduledSlots = [...new Map([...slots, ...gameSlots].map((slot) => [slot.key, slot])).values()];
  const gameNewsSlotLabels = new Set(gameNewsTimes.map((time) => parseClock(time)?.label).filter(Boolean));
  const activeSchoolCatchup = state.schoolCatchup?.until && new Date(state.schoolCatchup.until) > now
    ? state.schoolCatchup
    : null;
  if (state.schoolCatchup && !activeSchoolCatchup) {
    state.schoolCatchup = null;
  }
  const activeGameCatchupCandidate = state.gameCatchup?.until && new Date(state.gameCatchup.until) > now
    ? state.gameCatchup
    : null;
  const activeGameCatchup = activeGameCatchupCandidate
    && String(activeGameCatchupCandidate.slotLabel || "").split(",").some((label) => gameNewsSlotLabels.has(label.trim()))
    ? activeGameCatchupCandidate
    : null;
  if (state.gameCatchup && !activeGameCatchup) {
    state.gameCatchup = null;
  }

  const shouldExport = forceSchool || slots.length > 0 || Boolean(activeSchoolCatchup);
  const throttleOutlook = !forceSchool && outlookExportThrottled(state.lastOutlookExportAt, now.getTime(), outlookMinMinutes);
  let exportOutput = "";
  let schoolExportError = "";
  let telegramMessagesSent = 0;
  let emptyCheckSent = false;
  let digestSchoolMessages = [];
  let digestPersonalMessages = [];
  let digestGameItems = [];
  let digestSkippedLowPriority = 0;
  let digestSendReason = "empty-content";

  // 与下面 Gmail 那段对齐：单个导出器失败不该把整次检查带走。
  // 原先这里没有包裹，于是 Outlook 一抛异常，Gmail、Canvas、游戏资讯全都收不到。
  // Mac 上必然触发（Outlook 走 COM，没有 powershell.exe），Windows 上则会在
  // Outlook COM 打嗝时触发 —— 那是有前科的。
  if (shouldExport && !checkOnly && !throttleOutlook) {
    try {
      exportOutput = runOutlookExport({ days: exportDays, maxMessages: exportMaxMessages, syncWaitSeconds: outlookSyncWaitSeconds });
      // 只有真导出成功才记时间戳，否则失败会被当成"刚导过"而触发节流。
      state.lastOutlookExportAt = now.toISOString();
      console.log(exportOutput);
    } catch (error) {
      schoolExportError = error.message || String(error);
      console.warn(`Outlook export skipped: ${schoolExportError}`);
    }

    // 连续失败才告警，且有冷却 —— 直接复用 Gmail 那套判定（它的三个参数
    // streak / lastAlertIso / nowMs 本来就是通用的，不必另写一份逻辑）。
    if (schoolExportError) {
      state.outlookFailStreak += 1;
    } else {
      state.outlookFailStreak = 0;
    }
    if (schoolExportError && shouldAlertGmailFailure(state.outlookFailStreak, state.lastOutlookAlertAt, now.getTime())) {
      await sendOrPrint(
        `⚠️ Outlook 学校邮件读取连续失败，已经 ${state.outlookFailStreak} 次。\n`
        + "Outlook 走的是本机 COM，常见原因是 Outlook 没开、或它卡在登录/同步。\n"
        + "先去电脑上打开 Outlook 看一眼；仍然不行就发 /school 手动重试。\n\n"
        + `错误：${schoolExportError.slice(0, 200)}`,
        dryRun
      );
      telegramMessagesSent += 1;
      state.lastOutlookAlertAt = now.toISOString();
    }
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

      if (personalExportError) {
        state.gmailFailStreak += 1;
      } else {
        state.gmailFailStreak = 0;
      }
    }

    if (personalExportError && shouldAlertGmailFailure(state.gmailFailStreak, state.lastGmailAuthAlertAt, now.getTime())) {
      const authAccount = gmailAccount || "<your-gmail>@gmail.com";
      const configHint = gmailAccount ? "" : "\nGOG_ACCOUNT 未配置，请先在 .env 填写。";
      await sendOrPrint(`⚠️ Gmail 邮件读取连续失败（可能授权过期）。\n请在电脑上用 PowerShell 运行（必须带项目环境）：\ncd \"${process.cwd()}\"; . .\\scripts\\openclaw-env.ps1; gog auth add ${authAccount}${configHint}\n\n错误：${personalExportError.slice(0, 200)}`, dryRun);
      telegramMessagesSent += 1;
      state.lastGmailAuthAlertAt = now.toISOString();
    }

    personalMessages = personalMessagesFromDrops(maxFiles);
    const seenPersonal = new Set(state.seenPersonalKeys);
    const newPersonalMessages = includeSeen
      ? personalMessages
      : personalMessages.filter((message) => !seenPersonal.has(message.key));
    const importantPersonalMessages = newPersonalMessages.filter((message) => classifyPersonalMessage(message).important);
    const skippedLowPriority = Math.max(0, newPersonalMessages.length - importantPersonalMessages.length);
    digestPersonalMessages = importantPersonalMessages;
    digestSkippedLowPriority = skippedLowPriority;

    for (const message of personalMessages) {
      seenPersonal.add(message.key);
    }
    state.seenPersonalKeys = [...seenPersonal].slice(-2000);
  }

  if (shouldExport) {
    const seen = new Set(state.seenMessageKeys);
    const newMessages = includeSeen ? messages : messages.filter((message) => !seen.has(message.key));
    digestSchoolMessages = newMessages;

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

  const shouldCheckGames = forceGame || gameSlots.length > 0 || Boolean(activeGameCatchup);
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
    digestGameItems = newGameItems;

    for (const item of gameItems) {
      seenGames.add(gameKey(item));
    }
    state.seenGameKeys = [...seenGames].slice(-2000);

    state.gameCatchup = updateGameCatchup({
      activeCatchup: activeGameCatchup,
      slots: gameSlots,
      newItemCount: newGameItems.length,
      catchupMinutes: gameCatchupMinutes,
      nowMs: now.getTime(),
      force: forceGame
    });

    for (const slot of gameSlots) {
      state.slots[slot.key] = now.toISOString();
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
      "学校临期提醒",
      "",
      `- ${compactLine(deadline.title)}`,
      `- 截止：${deadline.dueLocal}（${timeZone}）`,
      `- 来源：${compactLine(deadline.from)}${deadline.sourceDate ? `｜${deadline.sourceDate}` : ""}`
    ].join("\n");
    await sendOrPrint(text, dryRun);
    telegramMessagesSent += 1;
    reminded.add(deadline.key);
  }

  const forceDigest = forceSchool || forcePersonal || forceGame;
  const catchupLabels = [
    digestSchoolMessages.length > 0 ? activeSchoolCatchup?.slotLabel : null,
    digestGameItems.length > 0 ? activeGameCatchup?.slotLabel : null
  ].filter(Boolean);
  const digestSlotLabel = forceDigest
    ? "手动"
    : (scheduledSlots.length > 0
        ? scheduledSlots.map((slot) => slot.label).join(", ")
        : `${[...new Set(catchupLabels)].join(", ") || "定时"} 补查`);
  const digestText = formatCombinedDigest({
    schoolMessages: digestSchoolMessages,
    personalMessages: digestPersonalMessages,
    gameItems: digestGameItems
  }, {
    slotLabel: digestSlotLabel,
    timeZone,
    skippedLowPriority: digestSkippedLowPriority,
    maxGameItems: envNumber("GAME_CHECK_MAX_ITEMS", 8)
  });

  if (digestText) {
    const contentKey = digestContentKey({
      schoolMessages: digestSchoolMessages,
      personalMessages: digestPersonalMessages,
      gameItems: digestGameItems
    });
    const decision = shouldSendDigest({
      contentKey,
      lastSentKey: state.lastDigestKey,
      lastSentAtMs: state.lastDigestSentAt ? new Date(state.lastDigestSentAt).getTime() : null,
      nowMs: now.getTime(),
      minIntervalMs: DIGEST_MIN_INTERVAL_MS
    });
    digestSendReason = decision.reason;

    if (decision.send) {
      await sendOrPrint(digestText, dryRun);
      telegramMessagesSent += 1;
      personalUpdatesSent = Math.min(digestPersonalMessages.length, 8);
      gameUpdatesSent = digestGameItems.length;
      state.lastDigestKey = contentKey;
      state.lastDigestSentAt = now.toISOString();
    } else {
      console.log(`[school-check] 摘要未发送：${decision.reason}`);
    }
  }

  if (sendEmptyCheckSummary && scheduledSlots.length > 0 && telegramMessagesSent === 0) {
    const slotLabel = scheduledSlots.map((slot) => slot.label).join(", ");
    const lines = [
      `定时检查完成（${timeZone} ${slotLabel}）`,
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
    schoolExportError,
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
    digestSendReason,
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
      await sendTelegramMessage(`学校检查失败：${error.message}`);
    } catch {
      // Keep the original failure visible in stderr.
    }
    process.exitCode = 1;
}
