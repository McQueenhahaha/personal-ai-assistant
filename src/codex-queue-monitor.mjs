import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { loadEnv, resolveFromCwd } from "./env.mjs";
import { ensureQueue, listPendingTasks, readTask } from "./queue.mjs";
import { sendTelegramMessage } from "./telegram.mjs";

const DEFAULT_STATE_FILE = "./data/state/codex-queue-monitor-state.json";
const MAX_SEEN = 2000;
const DEFAULT_REMINDER_MINUTES = 5;

function hasArg(name) {
  return process.argv.includes(name);
}

function readJson(file, fallback) {
  if (!fs.existsSync(file)) return fallback;
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2), "utf8");
}

function taskKey(item) {
  return `${path.basename(item.file)}:${Math.trunc(item.stat.mtimeMs)}:${item.stat.size}`;
}

function reminderMinutes() {
  const value = Number(process.env.CODEX_QUEUE_MONITOR_REMINDER_MINUTES);
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_REMINDER_MINUTES;
}

function taskText(task, item, { reminder = false } = {}) {
  const prompt = String(task.prompt || "").trim();
  const shortPrompt = prompt.length > 500 ? `${prompt.slice(0, 500).trim()}...` : prompt;
  return [
    reminder ? "Codex 队列仍有未处理任务。" : "检测到新的 Codex 队列任务。",
    "",
    `标题：${task.title || item.name}`,
    `来源：${task.source || "queue"}`,
    `优先级：${task.priority || "normal"}`,
    `文件：${item.name}`,
    "",
    "任务内容：",
    shortPrompt,
    "",
    "本地检测器已捕获该任务并保留在 inbox。需要 Codex 介入处理；如果一段时间没有结果，请在电脑上打开当前 Codex 会话。"
  ].join("\n");
}

export async function monitorCodexQueue({ notify = true, persist = true } = {}) {
  loadEnv();

  const inboxPath = process.env.CODEX_QUEUE_INBOX || "./data/queues/codex/inbox";
  const stateFile = resolveFromCwd(process.env.CODEX_QUEUE_MONITOR_STATE_FILE || DEFAULT_STATE_FILE);
  ensureQueue(inboxPath);

  const pending = listPendingTasks(inboxPath);
  const state = readJson(stateFile, { seen: [] });
  const seen = new Set(Array.isArray(state.seen) ? state.seen : []);
  const lastNotified = state.lastNotified && typeof state.lastNotified === "object" ? state.lastNotified : {};
  const pendingKeys = new Set(pending.map((item) => taskKey(item)));
  const reminderMs = reminderMinutes() * 60 * 1000;
  const now = Date.now();
  const results = [];
  let newCount = 0;
  let notifiedCount = 0;

  for (const item of pending) {
    const key = taskKey(item);
    const isNew = !seen.has(key);
    const last = Number(lastNotified[key] || 0);
    const shouldNotify = isNew || (now - last >= reminderMs);
    if (isNew) newCount += 1;

    let task;
    try {
      task = readTask(item.file);
      if (notify && shouldNotify) {
        await sendTelegramMessage(taskText(task, item, { reminder: !isNew }));
        lastNotified[key] = now;
        notifiedCount += 1;
      }
      seen.add(key);
      results.push({ ok: true, file: item.file, title: task.title, isNew, notified: notify && shouldNotify });
    } catch (error) {
      seen.add(key);
      results.push({ ok: false, file: item.file, error: error.message || String(error), isNew, notified: notify && shouldNotify });
      if (notify && shouldNotify) {
        await sendTelegramMessage([
          "Codex 队列检测到任务，但读取失败。",
          "",
          `文件：${item.name}`,
          `错误：${error.message || String(error)}`
        ].join("\n"));
        lastNotified[key] = now;
        notifiedCount += 1;
      }
    }
  }

  for (const key of Object.keys(lastNotified)) {
    if (!pendingKeys.has(key)) delete lastNotified[key];
  }

  if (persist) {
    writeJson(stateFile, {
      updatedAt: new Date().toISOString(),
      pendingCount: pending.length,
      newCount,
      notifiedCount,
      pending: pending.map((item) => item.name),
      lastNotified,
      seen: [...seen].slice(-MAX_SEEN)
    });
  }

  return { pendingCount: pending.length, newCount, notifiedCount, results };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  monitorCodexQueue({
    notify: !hasArg("--no-notify") && !hasArg("--dry-run"),
    persist: !hasArg("--dry-run")
  }).then((summary) => {
    console.log(
      `Codex queue monitor pending=${summary.pendingCount} new=${summary.newCount} notified=${summary.notifiedCount}.`
    );
  }).catch((error) => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  });
}
