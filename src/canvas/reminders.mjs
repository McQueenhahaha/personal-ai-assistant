function cloneSentState(sentState) {
  if (!sentState || typeof sentState !== "object" || Array.isArray(sentState)) return {};

  const next = {};
  for (const [uid, thresholds] of Object.entries(sentState)) {
    next[uid] = Array.isArray(thresholds) ? [...thresholds] : [];
  }
  return next;
}

function selectThreshold(hoursUntilDue, thresholdsH) {
  const matches = thresholdsH
    .filter((threshold) => Number.isFinite(threshold) && hoursUntilDue <= threshold)
    .sort((a, b) => a - b);
  return matches.length > 0 ? matches[0] : null;
}

function formatLocalDateTime(ms) {
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  }).format(new Date(ms));
}

function formatLocalDate(ms) {
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(new Date(ms));
}

function formatDuration(dueMs, nowMs) {
  const totalHours = Math.max(1, Math.ceil((dueMs - nowMs) / 3600000));
  const days = Math.floor(totalHours / 24);
  const hours = totalHours % 24;

  if (days > 0 && hours > 0) return `${days}天${hours}小时`;
  if (days > 0) return `${days}天`;
  return `${totalHours}小时`;
}

export function selectDueReminders(assignments, nowMs, sentState, thresholdsH = [72, 24, 6]) {
  const nextState = cloneSentState(sentState);
  const reminders = [];

  for (const assignment of assignments) {
    if (!Number.isFinite(assignment.dueMs) || assignment.dueMs <= nowMs) continue;

    const hoursUntilDue = (assignment.dueMs - nowMs) / 3600000;
    const thresholdH = selectThreshold(hoursUntilDue, thresholdsH);
    if (thresholdH == null) continue;

    const sentThresholds = new Set(Array.isArray(nextState[assignment.uid]) ? nextState[assignment.uid] : []);
    if (sentThresholds.has(thresholdH)) continue;

    reminders.push({
      uid: assignment.uid,
      title: assignment.title,
      courseCode: assignment.courseCode,
      dueMs: assignment.dueMs,
      url: assignment.url,
      thresholdH
    });

    sentThresholds.add(thresholdH);
    nextState[assignment.uid] = [...sentThresholds].sort((a, b) => a - b);
  }

  return { reminders, sentState: nextState };
}

export function formatReminder(reminder, nowMs) {
  const lines = [
    "⏰ Canvas 作业提醒",
    `作业：${reminder.title}`,
    `课程：${reminder.courseCode || "未识别"}`,
    `剩余：还有${formatDuration(reminder.dueMs, nowMs)}`,
    `到期：${formatLocalDateTime(reminder.dueMs)}`
  ];

  if (reminder.url) lines.push(`链接：${reminder.url}`);
  return lines.join("\n");
}

export function formatUpcomingList(assignments, nowMs, limit = 10) {
  const upcoming = assignments
    .filter((assignment) => Number.isFinite(assignment.dueMs) && assignment.dueMs > nowMs)
    .sort((a, b) => a.dueMs - b.dueMs)
    .slice(0, limit);

  if (upcoming.length === 0) return "近期没有待交作业。";

  return [
    "📚 近期 Canvas 作业 due",
    ...upcoming.map((assignment, index) => {
      const courseCode = assignment.courseCode || "未识别";
      return `${index + 1}. ${assignment.title} [${courseCode}] — 还有${formatDuration(assignment.dueMs, nowMs)} (${formatLocalDate(assignment.dueMs)})`;
    })
  ].join("\n");
}
