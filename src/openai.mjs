import { generateWithOllama } from "./local-ai.mjs";
import { buildDeterministicDigest } from "./digest/deterministic.mjs";
import { DIGEST_SECTION_LIMIT, REQUIRED_SECTIONS } from "./digest/constants.mjs";
import { compactLine } from "./digest/text.mjs";
import { classifyPersonalMessage, formatPersonalItem, rankedPersonalMessages } from "./digest/personal.mjs";
import { buildTodoItems } from "./digest/todos.mjs";
import { classifySchoolMessage, formatSchoolItem, translateSchoolTitle } from "./digest/school.mjs";
import { formatGameItem, gamePrefix, translateGameTitle } from "./digest/games.mjs";
import {
  fieldValue,
  readMessageSource,
  parseGmailSnapshot,
  parseOutlookSnapshot,
  messageDateMs,
  normalizeMailMessages
} from "./digest/mail.mjs";

export { buildDeterministicDigest };

export {
  DIGEST_SECTION_LIMIT,
  REQUIRED_SECTIONS,
  compactLine,
  classifyPersonalMessage,
  formatPersonalItem,
  rankedPersonalMessages,
  buildTodoItems,
  classifySchoolMessage,
  formatSchoolItem,
  translateSchoolTitle,
  formatGameItem,
  gamePrefix,
  translateGameTitle,
  fieldValue,
  readMessageSource,
  parseGmailSnapshot,
  parseOutlookSnapshot,
  messageDateMs,
  normalizeMailMessages
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
