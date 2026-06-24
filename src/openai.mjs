import fs from "node:fs";
import path from "node:path";
import { generateWithOllama } from "./local-ai.mjs";

const DIGEST_SECTION_LIMIT = 4;
const REQUIRED_SECTIONS = ["RMIT / 学校", "个人邮件", "游戏资讯", "待办"];

export function outputText(responseJson) {
  if (typeof responseJson.output_text === "string") {
    return responseJson.output_text.trim();
  }

  const pieces = [];
  for (const item of responseJson.output || []) {
    for (const content of item.content || []) {
      if (typeof content.text === "string") pieces.push(content.text);
      if (typeof content.output_text === "string") pieces.push(content.output_text);
    }
  }
  return pieces.join("\n").trim();
}

export function fieldValue(block, name) {
  const match = block.match(new RegExp(`^- ${name}:\\s*(.+)$`, "im"));
  return match ? match[1].trim() : "";
}

function readMessageSource(message) {
  if (message.file && fs.existsSync(message.file)) {
    return fs.readFileSync(message.file, "utf8");
  }
  return message.body || "";
}

function parseGmailSnapshot(message) {
  const source = readMessageSource(message);
  const codeBlock = source.match(/```text\r?\n([\s\S]*?)```/);
  const body = codeBlock ? codeBlock[1] : source;
  const messages = [];

  for (const rawLine of body.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("ID\t")) continue;
    const [id, date, from, subject, labels = "", thread = ""] = line.split("\t");
    if (!id || !date || !from || !subject) continue;

    const normalizedLabels = labels.toUpperCase();
    if (/\b(?:DRAFT|TRASH|SPAM)\b/.test(normalizedLabels)) continue;

    messages.push({
      category: "personal",
      file: message.file,
      id,
      date,
      from,
      subject,
      labels,
      thread,
      key: `gmail|${id}`.toLowerCase(),
      body: [subject, from, labels].join("\n")
    });
  }

  return messages;
}

function parseOutlookSnapshot(message) {
  const source = readMessageSource(message);
  if (!source.includes("## ")) return [];
  const messages = [];

  for (const section of source.split(/^## /m).slice(1)) {
    const [firstLine, ...restLines] = section.split(/\r?\n/);
    const subject = firstLine.trim();
    if (!subject) continue;

    const block = restLines.join("\n");
    const from = fieldValue(block, "From") || "unknown sender";
    const received = fieldValue(block, "Received") || message.date;
    const bodyStart = block.search(/\r?\n\r?\n/);
    const body = bodyStart >= 0 ? block.slice(bodyStart).trim() : block.trim();
    const key = `school|${received}|${from}|${subject}`.toLowerCase();

    messages.push({
      category: "school",
      file: message.file,
      subject,
      from,
      date: received,
      key,
      body
    });
  }

  return messages;
}

export function messageDateMs(message) {
  const date = new Date(message.date || message.modifiedAt || 0);
  return Number.isNaN(date.getTime()) ? 0 : date.getTime();
}

function normalizeMailMessages(mailMessages) {
  const expanded = [];

  for (const message of mailMessages) {
    const fileName = message.file ? path.basename(message.file) : "";
    const subject = String(message.subject || "");
    if (message.category === "personal" && (/^gmail-snapshot-/i.test(fileName) || /^Gmail snapshot$/i.test(subject))) {
      const parsed = parseGmailSnapshot(message);
      expanded.push(...(parsed.length > 0 ? parsed : [message]));
      continue;
    }
    if (message.category === "school" && /^outlook-rmit-snapshot-/i.test(fileName)) {
      const parsed = parseOutlookSnapshot(message);
      expanded.push(...(parsed.length > 0 ? parsed : [message]));
      continue;
    }
    expanded.push({
      ...message,
      key: message.key || `${message.category}|${message.date}|${message.from}|${message.subject}`.toLowerCase()
    });
  }

  const byKey = new Map();
  for (const message of expanded) {
    if (!message.subject || String(message.subject).startsWith("Could not read")) continue;
    if (!byKey.has(message.key)) byKey.set(message.key, message);
  }

  return [...byKey.values()].sort((a, b) => messageDateMs(b) - messageDateMs(a));
}

export function translateSchoolTitle(title) {
  return title
    .replace(/^Recent Canvas notifications$/i, "Canvas 近期通知")
    .replace(/^Assignment Graded:\s*/i, "作业/测验已评分：")
    .replace(/^Assignment graded:\s*/i, "作业/测验已评分：")
    .replace(/^Assignment Due Date Changed:\s*/i, "作业截止日期已更改：")
    .replace(/^Submission posted:\s*/i, "提交记录已发布：")
    .replace(/^You have been added to a class team/i, "你已被加入课程 Microsoft Teams")
    .replace(/^Update:\s*/i, "更新：")
    .replace(/^Reminder:\s*/i, "提醒：")
    .replace(/^All engineering students are invited to/i, "工程学生邀请：")
    .replace(/a STEM social\/industry event on 18 May\s+12-?\s*3pm in Storey Hall/i, "5 月 18 日 12:00-15:00 在 Storey Hall 的 STEM 社交/行业活动")
    .replace(/^New Colombo Plan Scholarships Opportunities/i, "New Colombo Plan 奖学金机会")
    .replace(/^Assessment support edition/i, "评估/作业支持专期")
    .replace(/^Week ten:/i, "第 10 周：")
    .replace(/^Wrapping up week/i, "本周总结：第")
    .replace(/\bjust sent you a message in Canvas\b/i, "刚在 Canvas 给你发了消息")
    .replace(/\bis due tonight\b/i, "今晚截止")
    .replace(/\bis due on\b/i, "截止于")
    .replace(/\bFeedback Quiz\b/gi, "反馈测验")
    .replace(/\bQuiz\b/gi, "测验")
    .replace(/\bAssignment\b/gi, "作业")
    .trim();
}

export function compactLine(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

export function classifySchoolMessage(message) {
  const subject = String(message.subject || "").toLowerCase();
  const text = `${message.subject}\n${message.body || ""}`.toLowerCase();
  if (/\bces\b|survey|questionnaire|complete your .*feedback|give your feedback/.test(subject)) return "问卷/反馈";
  if (/graded|feedback|marks?|score/.test(text)) return "成绩/反馈";
  if (/assignment|quiz|assessment|due|deadline|submission/.test(text)) return "作业/测验";
  if (/exam|test/.test(text)) return "考试";
  if (/message for|canvas|lms/.test(text)) return "Canvas";
  if (/lecture|seminar|event|workshop|social|scholarship|opportunit/.test(subject)) return "课程/活动";
  return "通知";
}

export function classifyPersonalMessage(message) {
  const text = `${message.subject}\n${message.from}\n${message.labels || ""}`.toLowerCase();

  if (/security alert|verification code|2-step|password|sign-?in|logged in|someone signed|verify your device|identity was just linked|third-party .*application/.test(text)) {
    return {
      kind: "Urgent",
      important: true,
      rank: 0,
      action: "核对账号安全"
    };
  }
  if (/please review|review and confirm|confirm repayment|completion required|required|please .*sign|direct debit|upcoming payment|claim details|form|questionnaire|complete the survey|action required/.test(text)) {
    return {
      kind: "Needs reply",
      important: true,
      rank: 1,
      action: "需要处理/确认"
    };
  }
  if (/application|interview|recruit|residential advisor|seek recommendations|new jobs|job alert/.test(text)) {
    return {
      kind: "FYI",
      important: true,
      rank: 2,
      action: "留意求职/机会信息"
    };
  }
  if (/document|academic statement|accounts successfully linked|finalised|receipt|statement|payment receipt|wifi login|rental agreement/.test(text)) {
    return {
      kind: "FYI",
      important: true,
      rank: 3,
      action: "留档或查看"
    };
  }
  if (/order confirmation|discount|sale|offer|promotion|uber|yakiniku|machida|afterpay|revolut|epic games|优惠|促销|折扣|订餐|生鲜|最多可省/.test(text)) {
    return {
      kind: "Noise",
      important: false,
      rank: 9,
      action: "低优先级"
    };
  }

  return {
    kind: "FYI",
    important: true,
    rank: 4,
    action: "留意"
  };
}

export function formatSchoolItem(message) {
  const kind = classifySchoolMessage(message);
  const subject = translateSchoolTitle(compactLine(message.subject));
  const from = compactLine(message.from);
  const date = compactLine(message.date);
  return `- [${kind}] ${subject}${from ? `｜${from}` : ""}${date ? `｜${date}` : ""}`;
}

export function formatPersonalItem(message) {
  const classification = classifyPersonalMessage(message);
  const subject = compactLine(message.subject);
  const from = compactLine(message.from);
  const date = compactLine(message.date);
  return `- [${classification.kind}] ${classification.action}：${subject}${from ? `｜${from}` : ""}${date ? `｜${date}` : ""}`;
}

export function rankedPersonalMessages(messages) {
  return messages
    .map((message) => ({ message, classification: classifyPersonalMessage(message) }))
    .sort((a, b) => {
      if (a.classification.rank !== b.classification.rank) return a.classification.rank - b.classification.rank;
      return messageDateMs(b.message) - messageDateMs(a.message);
    });
}

export function buildTodoItems({ schoolMessages, personalMessages }) {
  const items = [];
  const seen = new Set();
  const add = (value) => {
    const text = compactLine(value);
    const key = text.toLowerCase();
    if (!text || seen.has(key) || items.length >= DIGEST_SECTION_LIMIT) return;
    seen.add(key);
    items.push(`- ${text}`);
  };

  for (const { message, classification } of rankedPersonalMessages(personalMessages)) {
    if (!classification.important) continue;
    if (classification.kind === "Urgent") {
      add(`先核对账号/登录安全：${message.subject}`);
    } else if (classification.kind === "Needs reply") {
      add(`处理个人邮件：${message.subject}`);
    }
  }

  for (const message of schoolMessages) {
    const kind = classifySchoolMessage(message);
    if (kind === "作业/测验" || kind === "考试") {
      add(`检查 RMIT 截止事项：${translateSchoolTitle(message.subject)}${message.date ? `｜${message.date}` : ""}`);
    } else if (kind === "问卷/反馈") {
      add(`如有空，完成 RMIT 问卷/反馈：${translateSchoolTitle(message.subject)}`);
    }
  }

  if (items.length === 0) {
    items.push("- 暂无明确待办。");
  }
  return items.slice(0, DIGEST_SECTION_LIMIT);
}

export function translateGameTitle(title) {
  return title
    .replace(/\s+-\s+[^-]+$/g, "")
    .replace(/^Community Update No\.(\d+):\s*/i, "社区更新第 $1 期：")
    .replace(/Community Update No\.?(\d+)/i, "社区更新第 $1 期")
    .replace(/^Development\s+/i, "开发日志：")
    .replace(/^Event\s+/i, "活动：")
    .replace(/^Special\s+/i, "特别活动：")
    .replace(/^Pre-order:\s*/i, "预购：")
    .replace(/Pre Order/gi, "预购")
    .replace(/Jean Bart The Last French Battleship/gi, "Jean Bart，最后的法国战列舰")
    .replace(/Legend Of Victory Kv 8/gi, "胜利传奇 KV-8")
    .replace(/A Decal Trophy For Us Armed Forces Day/gi, "美国武装部队日贴花奖杯")
    .replace(/Nuclear Escalation/gi, "核升级")
    .replace(/Tropic Storm Division #(\d+)/gi, "Tropic Storm 师级预览 #$1")
    .replace(/TROPIC Division #(\d+)/gi, "Tropic 师级预览 #$1")
    .replace(/^Monthly Decals/i, "每月贴花")
    .replace(/^Special:\s*/i, "特别活动：")
    .replace(/^Event:\s*/i, "活动：")
    .replace(/^Development:\s*/i, "开发日志：")
    .replace(/^Fixed! /i, "修复日志：")
    .replace(/Patch notes/i, "更新说明")
    .replace(/Major Update/i, "大型更新")
    .replace(/Sound Mods/i, "声音 Mod")
    .replace(/More/i, "更多内容")
    .replace(/discounts?/gi, "折扣")
    .replace(/trophy/gi, "奖杯/箱子")
    .replace(/decal/gi, "贴花")
    .replace(/vehicle event/gi, "载具活动")
    .replace(/event vehicle/gi, "活动载具")
    .replace(/rumor round-up/gi, "传闻汇总")
    .replace(/leaked/gi, "泄露")
    .trim();
}

export function gamePrefix(item) {
  if (item.sourceType === "tarkov-official") return "塔科夫官方";
  if (item.sourceType === "tarkov-bilibili") return "塔科夫/B站纱雾";
  if (item.game === "WARNO") return "WARNO 官方";
  if (item.sourceType === "war-thunder-bilibili") return "战雷/B站 SwordXue";
  if (item.sourceType === "official-site") return "战雷官方";
  if (item.sourceType === "google-news" && item.game === "War Thunder") return "战雷论坛/传闻";
  if (item.game === "Escape from Tarkov") return "塔科夫";
  return item.game || "游戏";
}

export function formatGameItem(item) {
  const title = translateGameTitle(item.title);
  const source = item.source ? `｜${item.source}` : "";
  const link = item.link ? `\n  ${item.link}` : "";
  return `- [${gamePrefix(item)}] ${title}${source}${link}`;
}

export function buildDeterministicDigest({ title, gameNews, schoolMessages, personalMessages }) {
  const lines = [title, ""];

  lines.push("RMIT / 学校");
  if (schoolMessages.length === 0) {
    lines.push("- 暂无学校邮件文件。把 RMIT 邮件导出到 `data/school-mail-drop` 后，我会在这里整理课程、截止日期和重要通知。");
  } else {
    for (const message of schoolMessages.slice(0, DIGEST_SECTION_LIMIT)) {
      lines.push(formatSchoolItem(message));
    }
  }

  lines.push("", "个人邮件");
  if (personalMessages.length === 0) {
    lines.push("- 暂无个人邮件文件。");
  } else {
    const ranked = rankedPersonalMessages(personalMessages);
    const shown = ranked.filter((item) => item.classification.important).slice(0, DIGEST_SECTION_LIMIT);
    const visible = shown.length > 0 ? shown : ranked.slice(0, DIGEST_SECTION_LIMIT);
    for (const { message } of visible) {
      lines.push(formatPersonalItem(message));
    }
    const skippedLowPriority = ranked.filter((item) => !item.classification.important).length;
    if (skippedLowPriority > 0 && visible.length < DIGEST_SECTION_LIMIT) {
      lines.push(`- 已略过 ${skippedLowPriority} 封促销/收据等低优先级邮件。`);
    }
  }

  lines.push("", "游戏资讯");
  if (gameNews.length === 0) {
    lines.push("- 暂无游戏资讯。");
  } else {
    for (const item of gameNews.slice(0, DIGEST_SECTION_LIMIT)) {
      lines.push(formatGameItem(item));
    }
  }

  lines.push("", "待办");
  for (const item of buildTodoItems({ schoolMessages, personalMessages })) {
    lines.push(item);
  }

  return lines.join("\n");
}

export function sectionBulletCount(text, section) {
  const sectionIndex = text.indexOf(section);
  if (sectionIndex < 0) return 0;

  let endIndex = text.length;
  for (const nextSection of REQUIRED_SECTIONS) {
    if (nextSection === section) continue;
    const nextIndex = text.indexOf(nextSection, sectionIndex + section.length);
    if (nextIndex >= 0 && nextIndex < endIndex) endIndex = nextIndex;
  }

  return text
    .slice(sectionIndex + section.length, endIndex)
    .split(/\r?\n/)
    .filter((line) => line.trim().startsWith("- "))
    .length;
}

export function digestLooksReasonable(text) {
  if (!text || REQUIRED_SECTIONS.some((section) => !text.includes(section))) return false;
  if (/\b(?:gmail-snapshot|outlook-rmit-snapshot)-\d{4}/i.test(text)) return false;
  return REQUIRED_SECTIONS.every((section) => sectionBulletCount(text, section) <= DIGEST_SECTION_LIMIT);
}

export async function buildDigest({ title, gameNews, mailMessages }) {
  const openaiFallbackEnabled = (process.env.ENABLE_OPENAI_FALLBACK || "false").toLowerCase() === "true";
  const normalizedMailMessages = normalizeMailMessages(mailMessages);
  const schoolMessages = normalizedMailMessages.filter((item) => item.category === "school");
  const personalMessages = normalizedMailMessages.filter((item) => item.category === "personal");
  const compactGameNews = gameNews.slice(0, DIGEST_SECTION_LIMIT).map((item) => ({
    title: item.title,
    source: item.source,
    pubDate: item.pubDate,
    link: item.link,
    query: item.query,
    game: item.game,
    sourceType: item.sourceType
  }));
  const compactSchoolMessages = schoolMessages.slice(0, DIGEST_SECTION_LIMIT).map((item) => ({
    subject: item.subject,
    from: item.from,
    date: item.date,
    kind: classifySchoolMessage(item),
    summary: formatSchoolItem(item).replace(/^- /, "")
  }));
  const compactPersonalMessages = rankedPersonalMessages(personalMessages)
    .filter((item) => item.classification.important)
    .slice(0, DIGEST_SECTION_LIMIT)
    .map(({ message, classification }) => ({
      subject: message.subject,
      from: message.from,
      date: message.date,
      kind: classification.kind,
      suggestedAction: classification.action
    }));
  const deterministicDigest = buildDeterministicDigest({ title, gameNews, schoolMessages, personalMessages });

  if ((process.env.ENABLE_AI_DIGEST || "false").toLowerCase() !== "true") {
    return deterministicDigest;
  }

  const prompt = [
    "你是 RMIT 学生的个人 AI 助手。必须严格按下面规则输出。",
    "",
    "硬性规则：",
    "1. 除英文标题、课程名、发件人、链接外，解释和待办必须使用简体中文。",
    "2. 必须使用固定栏目：RMIT / 学校、个人邮件、游戏资讯、待办。",
    "3. 不要使用 Markdown 表格，不要写开场白，不要写结尾寒暄。",
    "4. 不要编造输入里没有的游戏、日期、课程或优惠。",
    "5. 邮件优先于游戏资讯；如果有个人邮件，必须总结个人邮件。",
    "6. 每个栏目最多 4 条，每条 1-2 行，适合 Telegram 手机阅读。",
    "7. 不确定就写“不确定”，不要猜。",
    "8. 输入里的 Gmail/Outlook 快照已经解析成真实邮件；不要输出 gmail-snapshot 或 outlook-rmit-snapshot 文件名。",
    "9. 个人邮件按 Urgent / Needs reply / Waiting / FYI / Noise 取重点；Noise 默认略过或只统计。",
    "10. 待办只能来自账号安全、需要确认/回复、课程截止事项或明确问卷；不要因为旧快照里出现 survey 就猜 Xref。",
    "",
    "输出模板：",
    "RMIT / 学校",
    "- ...",
    "",
    "个人邮件",
    "- ...",
    "",
    "游戏资讯",
    "- ...",
    "",
    "待办",
    "- ...",
    "",
    JSON.stringify(
      {
        title,
        schoolMessages: compactSchoolMessages,
        personalMessages: compactPersonalMessages,
        personalLowPriorityCount: rankedPersonalMessages(personalMessages).filter((item) => !item.classification.important).length,
        todoCandidates: buildTodoItems({ schoolMessages, personalMessages }).map((item) => item.replace(/^- /, "")),
        gameNews: compactGameNews
      },
      null,
      2
    )
  ].join("\n");

  if ((process.env.LOCAL_AI_PROVIDER || "ollama").toLowerCase() === "ollama") {
    try {
      const text = await generateWithOllama({ prompt });
      return digestLooksReasonable(text) ? text : deterministicDigest;
    } catch (error) {
      if (!openaiFallbackEnabled || !process.env.OPENAI_API_KEY) {
        return [
          deterministicDigest,
          "",
          `本地 AI 提示：Ollama 暂时不可用（${error.message}）。`
        ].join("\n");
      }
    }
  }

  if (!openaiFallbackEnabled || !process.env.OPENAI_API_KEY) {
    return deterministicDigest;
  }

  const model = process.env.OPENAI_MODEL || "gpt-5-mini";

  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model,
      input: prompt
    })
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`OpenAI request failed ${response.status}: ${body}`);
  }

  const json = await response.json();
  const text = outputText(json);
  return digestLooksReasonable(text) ? text : deterministicDigest;
}
