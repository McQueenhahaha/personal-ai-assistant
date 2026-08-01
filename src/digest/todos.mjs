import { compactLine } from "./text.mjs";
import { DIGEST_SECTION_LIMIT } from "./constants.mjs";
import { rankedPersonalMessages } from "./personal.mjs";
import { classifySchoolMessage, translateSchoolTitle } from "./school.mjs";

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
      add(`检查学校截止事项：${translateSchoolTitle(message.subject)}${message.date ? `｜${message.date}` : ""}`);
    } else if (kind === "问卷/反馈") {
      add(`如有空，完成学校问卷/反馈：${translateSchoolTitle(message.subject)}`);
    }
  }

  if (items.length === 0) {
    items.push("- 暂无明确待办。");
  }
  return items.slice(0, DIGEST_SECTION_LIMIT);
}
