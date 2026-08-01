import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { loadEnv } from "./env.mjs";
import { sendTelegramMessage } from "./telegram.mjs";
import { CanvasApiError, listUpcomingAssignments } from "./canvas/api.mjs";
import { fetchCanvasIcs, parseCanvasIcs } from "./canvas/feed.mjs";
import {
  formatApiUpcomingList,
  formatReminder,
  formatUpcomingList,
  selectDueReminders
} from "./canvas/reminders.mjs";
import {
  sendCanvasUnauthorizedAlert,
  sendTokenExpiryAlertIfNeeded
} from "./canvas/token-alert.mjs";
import { redactSensitive } from "./security/redact.mjs";

const SENT_STATE_FILE = "data/state/canvas-reminders-sent.json";

function sentStatePath() {
  return path.resolve(process.cwd(), SENT_STATE_FILE);
}

function readSentState() {
  const file = sentStatePath();
  if (!fs.existsSync(file)) return {};

  try {
    const state = JSON.parse(fs.readFileSync(file, "utf8"));
    return state && typeof state === "object" && !Array.isArray(state) ? state : {};
  } catch {
    return {};
  }
}

function writeSentState(state) {
  const file = sentStatePath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

function pruneSentState(sentState, assignments) {
  const currentUids = new Set(assignments.map(({ uid }) => uid));
  const pruned = {};

  for (const [uid, thresholds] of Object.entries(sentState || {})) {
    if (!currentUids.has(uid) || !Array.isArray(thresholds) || thresholds.length === 0) continue;
    pruned[uid] = thresholds;
  }

  return pruned;
}

function removeSentThreshold(sentState, uid, thresholdH) {
  const thresholds = Array.isArray(sentState[uid]) ? sentState[uid] : [];
  const nextThresholds = thresholds.filter((threshold) => threshold !== thresholdH);
  if (nextThresholds.length > 0) {
    sentState[uid] = nextThresholds;
  } else {
    delete sentState[uid];
  }
}

function toReminderAssignment(assignment) {
  return {
    uid: `event-assignment-${assignment.id}`,
    title: assignment.name,
    courseCode: assignment.courseCode,
    dueMs: assignment.dueAtMs,
    url: assignment.url
  };
}

async function loadIcsAssignments() {
  loadEnv();
  const url = process.env.CANVAS_ICS_URL;
  if (!url) return { assignments: null, reason: "missing-url" };

  const icsText = await fetchCanvasIcs(url);
  if (!icsText) return { assignments: null, reason: "fetch-failed" };

  return {
    assignments: parseCanvasIcs(icsText),
    reason: ""
  };
}

async function loadAssignments({
  now,
  listUpcoming = listUpcomingAssignments,
  loadIcs = loadIcsAssignments,
  onApiError
} = {}) {
  try {
    const apiAssignments = await listUpcoming({ withinDays: 21, nowMs: now });
    return {
      assignments: apiAssignments.map(toReminderAssignment),
      apiAssignments,
      mode: "api",
      reason: "",
      apiError: null
    };
  } catch (apiError) {
    await onApiError?.(apiError);
    const fallback = await loadIcs();
    return {
      ...fallback,
      apiAssignments: null,
      mode: fallback.assignments ? "ics" : "none",
      apiError
    };
  }
}

async function sendExpiryAlert({ now, send, stateFile }) {
  let sentCount = 0;
  loadEnv();

  try {
    if (await sendTokenExpiryAlertIfNeeded({
      expiresAtIso: process.env.CANVAS_TOKEN_EXPIRES_AT,
      nowMs: now,
      send,
      stateFile
    })) {
      sentCount += 1;
    }
  } catch (error) {
    console.warn(`Canvas token 到期提醒发送失败：${redactSensitive(error.message || String(error))}`);
  }

  return sentCount;
}

async function sendUnauthorizedAlertIfNeeded({ error, now, send, stateFile }) {
  if (!(error instanceof CanvasApiError) || error.status !== 401) return 0;
  try {
    return await sendCanvasUnauthorizedAlert({ nowMs: now, send, stateFile }) ? 1 : 0;
  } catch (sendError) {
    console.warn(`Canvas token 失效提醒发送失败：${redactSensitive(sendError.message || String(sendError))}`);
    return 0;
  }
}

export async function runCanvasCheck({
  now = Date.now(),
  send = sendTelegramMessage,
  listUpcoming = listUpcomingAssignments,
  loadIcs = loadIcsAssignments,
  tokenAlertStateFile
} = {}) {
  let sentCount = 0;
  const { assignments, reason, mode } = await loadAssignments({
    now,
    listUpcoming,
    loadIcs,
    onApiError: async (error) => {
      sentCount += await sendUnauthorizedAlertIfNeeded({
        error,
        now,
        send,
        stateFile: tokenAlertStateFile
      });
    }
  });
  sentCount += await sendExpiryAlert({ now, send, stateFile: tokenAlertStateFile });
  if (!assignments) {
    if (reason === "missing-url") {
      console.log("Canvas API 不可用且 CANVAS_ICS_URL 未配置，跳过 Canvas 作业检查。");
    } else {
      console.log("Canvas API 与 ICS 均拉取失败，跳过 Canvas 作业检查。");
    }
    return sentCount;
  }

  const sentState = readSentState();
  const selected = selectDueReminders(assignments, now, sentState);

  for (const reminder of selected.reminders) {
    try {
      const suffix = mode === "ics" ? "\n（降级模式：Canvas API 不可用，数据来自 ICS）" : "";
      await send(`${formatReminder(reminder, now)}${suffix}`);
      sentCount += 1;
    } catch (error) {
      removeSentThreshold(selected.sentState, reminder.uid, reminder.thresholdH);
      console.warn(`Canvas 提醒发送失败：${error.message || String(error)}`);
    }
  }

  writeSentState(pruneSentState(selected.sentState, assignments));
  return sentCount;
}

export async function runCanvasDue({
  now = Date.now(),
  send = sendTelegramMessage,
  listUpcoming = listUpcomingAssignments,
  loadIcs = loadIcsAssignments,
  tokenAlertStateFile
} = {}) {
  const { assignments, apiAssignments, reason, mode } = await loadAssignments({
    now,
    listUpcoming,
    loadIcs,
    onApiError: async (error) => {
      await sendUnauthorizedAlertIfNeeded({
        error,
        now,
        send,
        stateFile: tokenAlertStateFile
      });
    }
  });
  if (!assignments) {
    return reason === "missing-url"
      ? "Canvas API 不可用，且 CANVAS_ICS_URL 未配置，无法查询 Canvas。"
      : "查询 Canvas 失败";
  }

  if (mode === "api") return formatApiUpcomingList(apiAssignments, now);
  return `${formatUpcomingList(assignments, now)}\n（降级模式：Canvas API 不可用，数据来自 ICS）`;
}

async function main() {
  if (process.argv.includes("--due")) {
    console.log(await runCanvasDue());
    return;
  }

  const sentCount = await runCanvasCheck();
  console.log(`Canvas reminders sent: ${sentCount}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.warn(`Canvas check failed: ${error.message || String(error)}`);
  });
}
