import { pathToFileURL } from "node:url";
import { loadEnv } from "./env.mjs";
import { ensureQueue, listPendingTasks, readTask } from "./queue.mjs";
import { sendTelegramMessage } from "./telegram.mjs";

function codexInstructions(task) {
  return [
    "这个任务从 OpenClaw 升级给 Codex 处理。",
    "请默认用简体中文回复，除非任务明确要求其他语言。",
    "仔细阅读任务，必要时使用本地工具，输出适合 Telegram 阅读的简洁答案。",
    "除非用户明确确认，不要发送邮件、提交表单、删除文件或修改账号。",
    "如果任务需要不可用的凭据或外部授权，请说明阻塞点和最安全的下一步。",
    "",
    `Task title: ${task.title}`,
    `Task type: ${task.taskType}`,
    `Priority: ${task.priority}`,
    `Source: ${task.source}`,
    "",
    task.prompt
  ].join("\n");
}

export async function stageCodexQueue({ notify = true } = {}) {
  loadEnv();
  const inboxPath = process.env.CODEX_QUEUE_INBOX || "./data/queues/codex/inbox";
  ensureQueue(inboxPath);
  const pending = listPendingTasks(inboxPath);
  const results = [];

  for (const item of pending) {
    try {
      const task = readTask(item.file);
      results.push({ task, file: item.file, prompt: codexInstructions(task), ok: true });
      if (notify) {
        await sendTelegramMessage(`Codex 任务等待处理：${task.title}\n\nCodex 会从队列中处理这个复杂任务。`);
      }
    } catch (error) {
      results.push({ file: item.file, ok: false, error });
    }
  }

  return results;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  stageCodexQueue().then((results) => {
    console.log(`Staged ${results.length} Codex queue task(s).`);
  }).catch((error) => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  });
}
