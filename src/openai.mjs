import fs from "node:fs";
import path from "node:path";
import { generateWithOllama } from "./local-ai.mjs";
import { DIGEST_SECTION_LIMIT, REQUIRED_SECTIONS } from "./digest/constants.mjs";
import { compactLine } from "./digest/text.mjs";
import { classifyPersonalMessage, formatPersonalItem } from "./digest/personal.mjs";
import { classifySchoolMessage, formatSchoolItem, translateSchoolTitle } from "./digest/school.mjs";
import { formatGameItem, gamePrefix, translateGameTitle } from "./digest/games.mjs";

export {
  DIGEST_SECTION_LIMIT,
  REQUIRED_SECTIONS,
  compactLine,
  classifyPersonalMessage,
  formatPersonalItem,
  classifySchoolMessage,
  formatSchoolItem,
  translateSchoolTitle,
  formatGameItem,
  gamePrefix,
  translateGameTitle
};

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

export function readMessageSource(message) {
  if (message.file && fs.existsSync(message.file)) {
    return fs.readFileSync(message.file, "utf8");
  }
  return message.body || "";
}

export function parseGmailSnapshot(message) {
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

export function parseOutlookSnapshot(message) {
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

export function normalizeMailMessages(mailMessages) {
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
