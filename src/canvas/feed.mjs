function unfoldIcsLines(icsText) {
  return String(icsText || "")
    .replace(/\r?\n[ \t]/g, "")
    .split(/\r?\n/);
}

function eventBlocks(lines) {
  const blocks = [];
  let current = null;

  for (const line of lines) {
    const normalized = line.trim().toUpperCase();
    if (normalized === "BEGIN:VEVENT") {
      current = [];
      continue;
    }

    if (normalized === "END:VEVENT") {
      if (current) blocks.push(current);
      current = null;
      continue;
    }

    if (current) current.push(line);
  }

  return blocks;
}

function parseProperty(line) {
  const colon = line.indexOf(":");
  if (colon === -1) return null;

  const nameAndParams = line.slice(0, colon);
  const name = nameAndParams.split(";")[0].toUpperCase();
  return {
    name,
    value: line.slice(colon + 1)
  };
}

function parseLocalDateDue(value) {
  const match = /^(\d{4})(\d{2})(\d{2})$/.exec(value);
  if (!match) return null;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const due = new Date(year, month - 1, day, 23, 59, 59);
  if (
    due.getFullYear() !== year ||
    due.getMonth() !== month - 1 ||
    due.getDate() !== day
  ) {
    return null;
  }

  return due.getTime();
}

function parseUtcDateTime(value) {
  const match = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(value);
  if (!match) return null;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const dueMs = Date.UTC(year, month - 1, day, hour, minute, second);
  const due = new Date(dueMs);
  if (
    due.getUTCFullYear() !== year ||
    due.getUTCMonth() !== month - 1 ||
    due.getUTCDate() !== day ||
    due.getUTCHours() !== hour ||
    due.getUTCMinutes() !== minute ||
    due.getUTCSeconds() !== second
  ) {
    return null;
  }

  return dueMs;
}

function parseDtstart(value) {
  return parseLocalDateDue(value) ?? parseUtcDateTime(value);
}

function splitSummary(summary) {
  const trimmed = String(summary || "").trim();
  const match = /\s*\[([^\]]+)\]\s*$/.exec(trimmed);
  if (!match) {
    return { title: trimmed, courseCode: "" };
  }

  return {
    title: trimmed.slice(0, match.index).trim(),
    courseCode: match[1].trim()
  };
}

function parseEvent(lines) {
  const fields = {};

  for (const line of lines) {
    const property = parseProperty(line);
    if (!property) continue;

    if (property.name === "UID" && fields.uid == null) fields.uid = property.value;
    if (property.name === "SUMMARY" && fields.summary == null) fields.summary = property.value;
    if (property.name === "DTSTART" && fields.dtstart == null) fields.dtstart = property.value;
    if (property.name === "URL" && fields.url == null) fields.url = property.value;
  }

  if (!fields.uid?.startsWith("event-assignment-")) return null;

  const dueMs = parseDtstart(fields.dtstart || "");
  if (!Number.isFinite(dueMs)) return null;

  const { title, courseCode } = splitSummary(fields.summary || "");
  return {
    uid: fields.uid,
    title,
    courseCode,
    dueMs,
    url: fields.url || ""
  };
}

export function parseCanvasIcs(icsText) {
  return eventBlocks(unfoldIcsLines(icsText))
    .map(parseEvent)
    .filter(Boolean);
}

export async function fetchCanvasIcs(url, fetchImpl = fetch) {
  try {
    const response = await fetchImpl(url);
    if (!response.ok) return "";
    return await response.text();
  } catch {
    return "";
  }
}
