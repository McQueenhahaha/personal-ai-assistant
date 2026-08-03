import { classifyPersonalMessage, classifySchoolMessage, translatePersonalSubject } from "./classifiers.mjs";
import { gamePrefix, translateGameTitle } from "./game-news.mjs";

export function compactLine(value) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim();
}

export function parseField(block, name) {
  const match = block.match(new RegExp(`^- ${name}:\\s*(.+)$`, "im"));
  return match ? match[1].trim() : "";
}

export function formatPersonalSummary(messages, { slotLabel, timeZone, skippedLowPriority }) {
  const lines = [
    `个人 Gmail 检查（${timeZone} ${slotLabel || "手动"}）`,
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

export function formatSchoolSummary(messages, { slotLabel, timeZone }) {
  const lines = [
    `学校检查（${timeZone} ${slotLabel || "手动"}）`,
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

export function formatCombinedDigest({ schoolMessages = [], personalMessages = [], gameItems = [] }, {
  slotLabel,
  timeZone,
  skippedLowPriority = 0,
  maxSchoolItems = 8,
  maxPersonalItems = 8,
  maxGameItems = 8
}) {
  if (schoolMessages.length === 0 && personalMessages.length === 0 && gameItems.length === 0) {
    return "";
  }

  const lines = [`📬 ${slotLabel || "手动"} 检查`];

  if (schoolMessages.length > 0) {
    lines.push("", "【学校】");
    for (const message of schoolMessages.slice(0, maxSchoolItems)) {
      const kind = classifySchoolMessage(message);
      const received = message.date ? `｜${message.date}` : "";
      lines.push(`- [${kind}] ${compactLine(message.subject)}${received}`);
    }
  }

  if (personalMessages.length > 0) {
    lines.push("", "【个人】");
    for (const message of personalMessages.slice(0, maxPersonalItems)) {
      const classification = classifyPersonalMessage(message);
      const received = message.date ? `｜${message.date}` : "";
      lines.push(`- [${classification.kind}] ${translatePersonalSubject(compactLine(message.subject))}｜${compactLine(message.from)}${received}`);
    }
    if (skippedLowPriority > 0) {
      lines.push(`- 已略过 ${skippedLowPriority} 封收据/促销等低优先级新邮件。`);
    }
  }

  if (gameItems.length > 0) {
    lines.push("", "【游戏】");
    for (const item of gameItems.slice(0, maxGameItems)) {
      const date = item.pubDate ? `｜${new Date(item.pubDate).toISOString().slice(0, 10)}` : "";
      const source = item.source ? `｜${item.source}` : "";
      const link = item.link ? `\n  ${item.link}` : "";
      lines.push(`- [${gamePrefix(item)}] ${translateGameTitle(item.title)}${source}${date}${link}`);
    }
  }

  lines.push("", `时区：${timeZone}`);
  return lines.join("\n");
}
