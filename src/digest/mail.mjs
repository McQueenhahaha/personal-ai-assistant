import fs from "node:fs";
import path from "node:path";

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
    if (message.category === "school" && /^outlook-[^-]+-snapshot-/i.test(fileName)) {
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
