import { zonedParts } from "./schedule.mjs";

export const MONTHS = {
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

export function monthNumber(value) {
  return MONTHS[String(value || "").toLowerCase()];
}

export function to24Hour(hour, meridiem) {
  let value = Number(hour);
  if (!meridiem) return value;
  const normalized = meridiem.toLowerCase();
  if (normalized === "pm" && value < 12) value += 12;
  if (normalized === "am" && value === 12) value = 0;
  return value;
}

export function localTimeToUtc({ year, month, day, hour, minute }, timeZone) {
  const targetUtcLike = Date.UTC(year, month - 1, day, hour, minute, 0);
  let guess = targetUtcLike;

  for (let i = 0; i < 4; i++) {
    const parts = zonedParts(new Date(guess), timeZone);
    const actualUtcLike = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, 0);
    guess += targetUtcLike - actualUtcLike;
  }

  return new Date(guess);
}

export function extractYearFallback(message, now, timeZone) {
  const fromDate = String(message.date || "").match(/\b(20\d{2})\b/);
  if (fromDate) return Number(fromDate[1]);
  return zonedParts(now, timeZone).year;
}

export function extractDeadlinesFromMessage(message, { now, timeZone }) {
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

export function collectDeadlines(messages, { now, timeZone }) {
  const byKey = new Map();
  for (const message of messages) {
    for (const deadline of extractDeadlinesFromMessage(message, { now, timeZone })) {
      byKey.set(deadline.key, deadline);
    }
  }
  return [...byKey.values()].sort((a, b) => a.dueAt - b.dueAt);
}
