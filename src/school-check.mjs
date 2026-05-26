import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { collectMailDrops } from "./mail-drop.mjs";
import { envList, envNumber, loadEnv, resolveFromCwd, timestampForFile } from "./env.mjs";
import { fetchGameNews } from "./rss.mjs";
import { sendTelegramMessage } from "./telegram.mjs";

const DEFAULT_TIME_ZONE = "Australia/Melbourne";
const MONTHS = {
  jan: 1,
  january: 1,
  feb: 2,
  february: 2,
  mar: 3,
  march: 3,
  apr: 4,
  april: 4,
  may: 5,
  jun: 6,
  june: 6,
  jul: 7,
  july: 7,
  aug: 8,
  august: 8,
  sep: 9,
  sept: 9,
  september: 9,
  oct: 10,
  october: 10,
  nov: 11,
  november: 11,
  dec: 12,
  december: 12
};

function hasArg(name) {
  return process.argv.includes(name);
}

function statePath() {
  return resolveFromCwd("./data/state/school-check-state.json");
}

function loadState() {
  const file = statePath();
  if (!fs.existsSync(file)) {
    return {
      slots: {},
      seenMessageKeys: [],
      seenPersonalKeys: [],
      seenGameKeys: [],
      remindedDeadlineKeys: [],
      schoolCatchup: null,
      gameCatchup: null
    };
  }

  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return {
      slots: {},
      seenMessageKeys: [],
      seenPersonalKeys: [],
      seenGameKeys: [],
      remindedDeadlineKeys: [],
      schoolCatchup: null,
      gameCatchup: null
    };
  }
}

function saveState(state) {
  const file = statePath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  state.seenMessageKeys = [...new Set(state.seenMessageKeys || [])].slice(-2000);
  state.seenPersonalKeys = [...new Set(state.seenPersonalKeys || [])].slice(-2000);
  state.seenGameKeys = [...new Set(state.seenGameKeys || [])].slice(-2000);
  state.remindedDeadlineKeys = [...new Set(state.remindedDeadlineKeys || [])].slice(-1000);
  fs.writeFileSync(file, JSON.stringify(state, null, 2), "utf8");
}

function zonedParts(date, timeZone) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23"
  }).formatToParts(date);

  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return {
    year: Number(values.year),
    month: Number(values.month),
    day: Number(values.day),
    hour: Number(values.hour),
    minute: Number(values.minute),
    second: Number(values.second)
  };
}

function dateKeyInZone(date, timeZone) {
  const parts = zonedParts(date, timeZone);
  return `${parts.year}-${String(parts.month).padStart(2, "0")}-${String(parts.day).padStart(2, "0")}`;
}

function minutesInZone(date, timeZone) {
  const parts = zonedParts(date, timeZone);
  return parts.hour * 60 + parts.minute;
}

function parseClock(value) {
  const match = value.match(/^(\d{1,2}):(\d{2})$/);
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;
  return { hour, minute, total: hour * 60 + minute, label: `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}` };
}

function dueSlots({ now, timeZone, times, graceMinutes, state }) {
  const today = dateKeyInZone(now, timeZone);
  const current = minutesInZone(now, timeZone);
  const due = [];

  for (const rawTime of times) {
    const clock = parseClock(rawTime);
    if (!clock) continue;
    const key = `${today} ${clock.label}`;
    if (state.slots?.[key]) continue;
    if (current >= clock.total && current <= clock.total + graceMinutes) {
      due.push({ key, label: clock.label });
    }
  }

  return due;
}

function runOutlookExport({ days, maxMessages, syncWaitSeconds }) {
  const script = path.resolve("scripts", "export-outlook-mail.ps1");
  const result = spawnSync(
    "powershell.exe",
    [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      script,
      "-Days",
      String(days),
      "-MaxMessages",
      String(maxMessages),
      "-SyncWaitSeconds",
      String(syncWaitSeconds)
    ],
    {
      cwd: process.cwd(),
      encoding: "utf8"
    }
  );

  if (result.status !== 0) {
    throw new Error((result.stderr || result.stdout || "Outlook export failed").trim());
  }

  return (result.stdout || "").trim();
}

function runGmailExport({ maxMessages, query, account }) {
  const script = path.resolve("scripts", "export-gmail-mail.ps1");
  const args = [
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    script,
    "-MaxMessages",
    String(maxMessages)
  ];

  if (query) args.push("-Query", query);
  if (account) args.push("-Account", account);

  const result = spawnSync("powershell.exe", args, {
    cwd: process.cwd(),
    encoding: "utf8"
  });

  if (result.status !== 0) {
    throw new Error((result.stderr || result.stdout || "Gmail export failed").trim());
  }

  return (result.stdout || "").trim();
}

function parseField(block, name) {
  const match = block.match(new RegExp(`^- ${name}:\\s*(.+)$`, "im"));
  return match ? match[1].trim() : "";
}

function parseOutlookSnapshot(file) {
  const content = fs.readFileSync(file, "utf8");
  const sections = content.split(/^## /m).slice(1);
  const messages = [];

  for (const section of sections) {
    const [firstLine, ...restLines] = section.split(/\r?\n/);
    const block = restLines.join("\n");
    const subject = firstLine.trim();
    const from = parseField(block, "From") || "unknown sender";
    const received = parseField(block, "Received") || "";
    const bodyStart = block.search(/\r?\n\r?\n/);
    const body = bodyStart >= 0 ? block.slice(bodyStart).trim() : block.trim();
    const key = `${received}|${from}|${subject}`.toLowerCase();

    messages.push({
      category: "school",
      file,
      subject,
      from,
      date: received,
      body,
      key
    });
  }

  return messages;
}

function schoolMessagesFromDrops(maxFiles) {
  const drops = collectMailDrops({
    schoolDir: process.env.SCHOOL_MAIL_DROP_DIR || "./data/school-mail-drop",
    personalDir: "./data/__no-personal-for-school-check",
    maxFiles
  }).filter((item) => item.category === "school");

  const messages = [];
  for (const drop of drops) {
    if (path.basename(drop.file).startsWith("outlook-rmit-snapshot-")) {
      messages.push(...parseOutlookSnapshot(drop.file));
    } else {
      messages.push({
        ...drop,
        key: `${drop.date}|${drop.from}|${drop.subject}`.toLowerCase()
      });
    }
  }

  const byKey = new Map();
  for (const message of messages) {
    if (!byKey.has(message.key)) {
      byKey.set(message.key, message);
    }
  }

  return [...byKey.values()]
    .filter((message) => message.subject && !message.subject.startsWith("Could not read"))
    .sort((a, b) => String(b.date).localeCompare(String(a.date)));
}

function parseGmailSnapshot(file) {
  const content = fs.readFileSync(file, "utf8");
  const codeBlock = content.match(/```text\r?\n([\s\S]*?)```/);
  const body = codeBlock ? codeBlock[1] : content;
  const messages = [];

  for (const rawLine of body.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("ID\t")) continue;
    const [id, date, from, subject, labels = ""] = line.split("\t");
    if (!id || !date || !from || !subject) continue;
    if (String(labels).toUpperCase().includes("DRAFT")) continue;

    messages.push({
      category: "personal",
      file,
      id,
      date,
      from,
      subject,
      labels,
      key: `gmail|${id}`.toLowerCase()
    });
  }

  return messages;
}

function personalMessagesFromDrops(maxFiles) {
  const drops = collectMailDrops({
    schoolDir: "./data/__no-school-for-personal-check",
    personalDir: process.env.PERSONAL_MAIL_DROP_DIR || "./data/personal-mail-drop",
    maxFiles
  }).filter((item) => item.category === "personal");

  const messages = [];
  for (const drop of drops) {
    if (path.basename(drop.file).startsWith("gmail-snapshot-")) {
      messages.push(...parseGmailSnapshot(drop.file));
    } else if (/^gmail inbox snapshot/i.test(drop.subject) || /codex gmail connector/i.test(drop.from)) {
      continue;
    } else {
      messages.push({
        ...drop,
        key: `${drop.date}|${drop.from}|${drop.subject}`.toLowerCase()
      });
    }
  }

  const byKey = new Map();
  for (const message of messages) {
    if (!byKey.has(message.key)) {
      byKey.set(message.key, message);
    }
  }

  return [...byKey.values()]
    .filter((message) => message.subject && !message.subject.startsWith("Could not read"))
    .sort((a, b) => String(b.date).localeCompare(String(a.date)));
}

function compactLine(value) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim();
}

function gameKey(item) {
  return `${item.game || "game"}|${item.title}|${item.link || ""}`.toLowerCase();
}

function countGameSources(items) {
  const counts = {};
  for (const item of items) {
    const key = `${item.game || "unknown"}:${item.sourceType || "unknown"}`;
    counts[key] = (counts[key] || 0) + 1;
  }
  return counts;
}

function translateGameTitle(title) {
  return String(title || "")
    .replace(/\s+-\s+Bilibili$/i, "")
    .replace(/\s+-\s+[^-]+$/g, "")
    .replace(/^Development\s+/i, "开发日志：")
    .replace(/^Event\s+/i, "活动：")
    .replace(/^Special\s+/i, "特别活动：")
    .replace(/Community Update No\.?(\d+)/i, "社区更新第 $1 期")
    .replace(/Pre Order/gi, "预购")
    .replace(/Jean Bart The Last French Battleship/gi, "Jean Bart，最后的法国战列舰")
    .replace(/Legend Of Victory Kv 8/gi, "胜利传奇 KV-8")
    .replace(/A Decal Trophy For Us Armed Forces Day/gi, "美国武装部队日贴花奖杯")
    .replace(/Nuclear Escalation/gi, "核升级")
    .replace(/Sound Mods/gi, "声音 Mod")
    .replace(/More/gi, "更多内容")
    .replace(/Tropic Storm Division #(\d+)/gi, "Tropic Storm 师级预览 #$1")
    .replace(/TROPIC Division #(\d+)/gi, "Tropic 师级预览 #$1")
    .trim();
}

function gamePrefix(item) {
  if (item.sourceType === "tarkov-official") return "塔科夫官方";
  if (item.sourceType === "tarkov-bilibili") return "塔科夫/B站纱雾";
  if (item.game === "WARNO") return "WARNO 官方";
  if (item.sourceType === "war-thunder-bilibili") return "战雷/B站 SwordXue";
  if (item.sourceType === "official-site") return "战雷官方";
  if (item.sourceType === "google-news" && item.game === "War Thunder") return "战雷论坛/传闻";
  if (item.game === "Escape from Tarkov") return "塔科夫";
  return item.game || "游戏";
}

function formatGameSummary(items, { slotLabel, timeZone }) {
  const lines = [
    `游戏资讯检查（墨尔本时间 ${slotLabel || "手动"}）`,
    ""
  ];

  if (items.length === 0) {
    lines.push("- 暂无新的游戏资讯。");
    return lines.join("\n");
  }

  for (const item of items.slice(0, envNumber("GAME_CHECK_MAX_ITEMS", 8))) {
    const date = item.pubDate ? `｜${new Date(item.pubDate).toISOString().slice(0, 10)}` : "";
    const source = item.source ? `｜${item.source}` : "";
    const link = item.link ? `\n  ${item.link}` : "";
    lines.push(`- [${gamePrefix(item)}] ${translateGameTitle(item.title)}${source}${date}${link}`);
  }

  lines.push("", `时区：${timeZone}`);
  return lines.join("\n");
}

function classifySchoolMessage(message) {
  const subject = String(message.subject || "").toLowerCase();
  const text = `${message.subject}\n${message.body}`.toLowerCase();
  if (/\bces\b|survey|questionnaire|complete your .*feedback|give your feedback/.test(subject)) return "问卷/反馈";
  if (/graded|feedback|marks?|score/.test(text)) return "成绩/反馈";
  if (/assignment|quiz|assessment|due|deadline|submission/.test(text)) return "作业/测验";
  if (/exam|test/.test(text)) return "考试";
  if (/lecture|lector|seminar|event|workshop|social|scholarship|opportunit/.test(subject)) return "课程/活动";
  if (/canvas|lms/.test(text)) return "Canvas";
  return "通知";
}

function classifyPersonalMessage(message) {
  const text = `${message.subject}\n${message.from}\n${message.labels || ""}`.toLowerCase();

  if (/security alert|2-step|verification|password|sign-?in|account/.test(text)) {
    return { kind: "账号安全", important: true };
  }
  if (/xref|survey|questionnaire|form|complete the survey/.test(text)) {
    return { kind: "问卷/需确认", important: true };
  }
  if (/anz|bank|interest|statement|payment|invoice|bill/.test(text)) {
    return { kind: "财务", important: true };
  }
  if (/seek|indeed|job|application|interview|recruit/.test(text)) {
    return { kind: "求职", important: true };
  }
  if (/kaggle|course|workshop|webinar|challenge|capstone/.test(text)) {
    return { kind: "学习/活动", important: true };
  }
  if (/gaijin|war thunder|golden eagles|activated a code/.test(text)) {
    return { kind: "游戏账户/消费", important: true };
  }
  if (/order confirmation|receipt|uber|revolut|afterpay|discount|sale|offer|promotion/.test(text)) {
    return { kind: "低优先级", important: false };
  }

  return { kind: "个人邮件", important: true };
}

function translatePersonalSubject(subject) {
  return String(subject || "")
    .replace(/^Security alert$/i, "Google 安全提醒")
    .replace(/^2-Step Verification turned on$/i, "Google 两步验证已开启")
    .replace(/^We’re updating our interest rates$/i, "ANZ 利率更新")
    .replace(/^We'?re updating our Terms and Privacy Policy$/i, "条款和隐私政策更新")
    .replace(/^Machida Shoten Order Confirmation$/i, "Machida Shoten 订单确认")
    .replace(/^Gaijin\.Net Store: You acquired/i, "Gaijin 商店：你获得了")
    .replace(/^Gaijin\.Net Store: You have activated a code$/i, "Gaijin 商店：你已激活兑换码")
    .replace(/^Fw:\s*/i, "转发：")
    .trim();
}

function formatPersonalSummary(messages, { slotLabel, timeZone, skippedLowPriority }) {
  const lines = [
    `个人 Gmail 检查（墨尔本时间 ${slotLabel || "手动"}）`,
    ""
  ];

  const shownMessages = messages.slice(0, 8);
  if (messages.length === 0) {
    lines.push("- 暂无新的重要个人邮件。");
  } else {
    for (const message of shownMessages) {
      const classification = classifyPersonalMessage(message);
      const received = message.date ? `｜${message.date}` : "";
      lines.push(`- [${classification.kind}] ${translatePersonalSubject(compactLine(message.subject))}｜${compactLine(message.from)}${received}`);
    }
  }

  if (messages.length > shownMessages.length) {
    lines.push(`- 另有 ${messages.length - shownMessages.length} 封新的重要个人邮件，已保留在 Gmail 快照里。`);
  }

  if (skippedLowPriority > 0) {
    lines.push(`- 已略过 ${skippedLowPriority} 封收据/促销等低优先级新邮件。`);
  }

  lines.push("", `时区：${timeZone}`);
  return lines.join("\n");
}

function formatSchoolSummary(messages, { slotLabel, timeZone }) {
  const lines = [
    `RMIT 学校检查（墨尔本时间 ${slotLabel || "手动"}）`,
    ""
  ];

  if (messages.length === 0) {
    lines.push("- 暂无新的学校事项。");
    return lines.join("\n");
  }

  for (const message of messages.slice(0, 8)) {
    const kind = classifySchoolMessage(message);
    const received = message.date ? `｜${message.date}` : "";
    lines.push(`- [${kind}] ${compactLine(message.subject)}${received}`);
  }

  lines.push("", `时区：${timeZone}`);
  return lines.join("\n");
}

function monthNumber(value) {
  return MONTHS[String(value || "").toLowerCase()];
}

function to24Hour(hour, meridiem) {
  let value = Number(hour);
  if (!meridiem) return value;
  const normalized = meridiem.toLowerCase();
  if (normalized === "pm" && value < 12) value += 12;
  if (normalized === "am" && value === 12) value = 0;
  return value;
}

function localTimeToUtc({ year, month, day, hour, minute }, timeZone) {
  const targetUtcLike = Date.UTC(year, month - 1, day, hour, minute, 0);
  let guess = targetUtcLike;

  for (let i = 0; i < 4; i++) {
    const parts = zonedParts(new Date(guess), timeZone);
    const actualUtcLike = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, 0);
    guess += targetUtcLike - actualUtcLike;
  }

  return new Date(guess);
}

function extractYearFallback(message, now, timeZone) {
  const fromDate = String(message.date || "").match(/\b(20\d{2})\b/);
  if (fromDate) return Number(fromDate[1]);
  return zonedParts(now, timeZone).year;
}

function extractDeadlinesFromMessage(message, { now, timeZone }) {
  const text = `${message.subject}\n${message.body}`;
  const deadlines = [];
  const fallbackYear = extractYearFallback(message, now, timeZone);

  const patterns = [
    {
      reverse: false,
      regex: /(?:due|deadline|closes?|until|submission|available until|截止|到期)[^\n.]{0,120}?\b(january|jan|february|feb|march|mar|april|apr|may|june|jun|july|jul|august|aug|september|sept|sep|october|oct|november|nov|december|dec)\s+(\d{1,2})(?:,\s*(20\d{2}))?(?:\s*(?:at|@)?\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm)?)?/gi
    },
    {
      reverse: true,
      regex: /\b(\d{1,2})\s+(january|jan|february|feb|march|mar|april|apr|may|june|jun|july|jul|august|aug|september|sept|sep|october|oct|november|nov|december|dec)(?:\s+(20\d{2}))?(?:\s*(?:at|@)?\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm)?)?[^\n.]{0,80}?(?:due|deadline|closes?|截止|到期)/gi
    }
  ];

  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern.regex)) {
      const reverse = pattern.reverse;
      const month = reverse ? monthNumber(match[2]) : monthNumber(match[1]);
      const day = Number(reverse ? match[1] : match[2]);
      const year = Number(reverse ? match[3] : match[3]) || fallbackYear;
      const hourRaw = reverse ? match[4] : match[4];
      const minuteRaw = reverse ? match[5] : match[5];
      const meridiem = reverse ? match[6] : match[6];
      const hour = hourRaw ? to24Hour(hourRaw, meridiem) : 23;
      const minute = minuteRaw ? Number(minuteRaw) : (hourRaw ? 0 : 59);

      if (!month || !day || hour > 23 || minute > 59) continue;
      const dueAt = localTimeToUtc({ year, month, day, hour, minute }, timeZone);
      deadlines.push({
        key: `${message.key}|${dueAt.toISOString()}`,
        title: message.subject,
        from: message.from,
        dueAt,
        dueLocal: `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")} ${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`,
        sourceDate: message.date
      });
    }
  }

  return deadlines;
}

function collectDeadlines(messages, { now, timeZone }) {
  const byKey = new Map();
  for (const message of messages) {
    for (const deadline of extractDeadlinesFromMessage(message, { now, timeZone })) {
      byKey.set(deadline.key, deadline);
    }
  }
  return [...byKey.values()].sort((a, b) => a.dueAt - b.dueAt);
}

async function sendOrPrint(text, dryRun) {
  if (dryRun) {
    console.log(text);
    return;
  }
  await sendTelegramMessage(text);
}

async function main() {
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
      await sendOrPrint(formatGameSummary(newGameItems, { slotLabel, timeZone }), dryRun);
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

main().catch(async (error) => {
  console.error(error.stack || error.message);
  try {
    loadEnv();
    await sendTelegramMessage(`RMIT 学校检查失败：${error.message}`);
  } catch {
    // Keep the original failure visible in stderr.
  }
  process.exitCode = 1;
});
