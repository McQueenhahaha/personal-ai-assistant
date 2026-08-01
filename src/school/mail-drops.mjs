import fs from "node:fs";
import path from "node:path";
import { collectMailDrops } from "../mail-drop.mjs";
import { parseField } from "./summaries.mjs";

export function parseOutlookSnapshot(file) {
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

export function schoolMessagesFromDrops(maxFiles) {
  const drops = collectMailDrops({
    schoolDir: process.env.SCHOOL_MAIL_DROP_DIR || "./data/school-mail-drop",
    personalDir: "./data/__no-personal-for-school-check",
    maxFiles
  }).filter((item) => item.category === "school");

  const messages = [];
  for (const drop of drops) {
    if (/^outlook-[^-]+-snapshot-/i.test(path.basename(drop.file))) {
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
    .sort((a, b) => {
      const ta = Date.parse(a.date) || 0;
      const tb = Date.parse(b.date) || 0;
      return tb - ta;
    });
}

export function parseGmailSnapshot(file) {
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

export function personalMessagesFromDrops(maxFiles) {
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
    .sort((a, b) => {
      const ta = Date.parse(a.date) || 0;
      const tb = Date.parse(b.date) || 0;
      return tb - ta;
    });
}
