import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { loadEnv } from "./env.mjs";
import { sendTelegramMessage } from "./telegram.mjs";
import { fetchCanvasIcs, parseCanvasIcs } from "./canvas/feed.mjs";
import {
  formatReminder,
  formatUpcomingList,
  selectDueReminders
} from "./canvas/reminders.mjs";

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

async function loadAssignments() {
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

export async function runCanvasCheck({ now = Date.now(), send = sendTelegramMessage } = {}) {
  const { assignments, reason } = await loadAssignments();
  if (!assignments) {
    if (reason === "missing-url") {
      console.log("CANVAS_ICS_URL 未配置，跳过 Canvas 检查。");
    } else {
      console.log("Canvas ICS 拉取失败或为空，跳过 Canvas 检查。");
    }
    return 0;
  }

  const sentState = readSentState();
  const selected = selectDueReminders(assignments, now, sentState);
  let sentCount = 0;

  for (const reminder of selected.reminders) {
    try {
      await send(formatReminder(reminder, now));
      sentCount += 1;
    } catch (error) {
      removeSentThreshold(selected.sentState, reminder.uid, reminder.thresholdH);
      console.warn(`Canvas 提醒发送失败：${error.message || String(error)}`);
    }
  }

  writeSentState(pruneSentState(selected.sentState, assignments));
  return sentCount;
}

export async function runCanvasDue({ now = Date.now() } = {}) {
  const { assignments, reason } = await loadAssignments();
  if (!assignments) {
    return reason === "missing-url" ? "CANVAS_ICS_URL 未配置，无法查询 Canvas。" : "查询 Canvas 失败";
  }

  return formatUpcomingList(assignments, now);
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
