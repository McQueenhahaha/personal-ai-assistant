import { pathToFileURL } from "node:url";
import { loadEnv } from "./env.mjs";
import { generateWithOllama } from "./local-ai.mjs";
import { claimTask, ensureQueue, listPendingTasks, readTask, writeFailure, writeResult } from "./queue.mjs";
import { sendTelegramMessage } from "./telegram.mjs";

function buildPrompt(task) {
  return [
    `Task title: ${task.title}`,
    `Task type: ${task.taskType}`,
    `Priority: ${task.priority}`,
    `Source: ${task.source}`,
    "",
    "请默认用简体中文处理这个本地模型任务。英文标题、链接、专有名词可保留原文。",
    "如果任务风险高或太复杂，请明确说明为什么需要升级给 Codex。",
    "",
    task.prompt
  ].join("\n");
}

export async function processLocalQueue({ notify = true } = {}) {
  loadEnv();
  const inboxPath = process.env.LOCAL_QUEUE_INBOX || "./data/queues/local/inbox";
  ensureQueue(inboxPath);
  const pending = listPendingTasks(inboxPath);
  const results = [];

  for (const item of pending) {
    const claimed = claimTask(item, inboxPath);
    let task;
    try {
      task = readTask(claimed);
      const result = await generateWithOllama({ prompt: buildPrompt(task) });
      const outFile = writeResult({ inboxPath, taskFile: claimed, task, result });
      results.push({ task, outFile, ok: true });
      if (notify) {
        await sendTelegramMessage(`本地 AI 已完成：${task.title}\n\n${result}`);
      }
    } catch (error) {
      const outFile = writeFailure({ inboxPath, taskFile: claimed, task, error });
      results.push({ task, outFile, ok: false, error });
      if (notify) {
        await sendTelegramMessage(`本地 AI 处理失败：${task?.title || item.name}\n\n${error.message}`);
      }
    }
  }

  return results;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  processLocalQueue().then((results) => {
    console.log(`Processed ${results.length} local queue task(s).`);
  }).catch((error) => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  });
}
