export function zonedParts(date, timeZone) {
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

export function dateKeyInZone(date, timeZone) {
  const parts = zonedParts(date, timeZone);
  return `${parts.year}-${String(parts.month).padStart(2, "0")}-${String(parts.day).padStart(2, "0")}`;
}

export function minutesInZone(date, timeZone) {
  const parts = zonedParts(date, timeZone);
  return parts.hour * 60 + parts.minute;
}

export function parseClock(value) {
  const match = value.match(/^(\d{1,2}):(\d{2})$/);
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;
  return { hour, minute, total: hour * 60 + minute, label: `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}` };
}

export function dueSlots({ now, timeZone, times, graceMinutes, state }) {
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
