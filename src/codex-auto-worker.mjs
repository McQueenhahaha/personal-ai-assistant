import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import { loadEnv, resolveFromCwd, timestampForFile } from "./env.mjs";
import { claimTask, ensureQueue, listPendingTasks, readTask, writeFailure, writeResult } from "./queue.mjs";
import { sendTelegramMessage } from "./telegram.mjs";

function envNumber(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function boolEnv(name, fallback = false) {
  const value = process.env[name];
  if (value == null || value === "") return fallback;
  return ["1", "true", "yes", "on"].includes(String(value).toLowerCase());
}

function codexEntrypoint(root) {
  return path.join(root, "node_modules", "@openai", "codex", "bin", "codex.js");
}

function buildPrompt(task) {
  return [
    "你是通过本地 Codex 自动 worker 运行的 Codex。",
    "任务来自用户的 Telegram /codex 指令。请自动完成任务，并在最后输出适合 Telegram 阅读的简体中文结果。",
    "",
    "安全边界：",
    "- 不要泄露、打印或转发 .env、token、密码、cookie、OAuth 凭据等秘密。",
    "- 不要发送邮件、提交表单、付款、改账号安全设置，除非任务文本明确要求且风险可控。",
    "- 不要执行大范围删除、格式化磁盘、清空用户资料、破坏系统恢复能力等不可逆操作。",
    "- 如果任务含糊或风险过高，请不要执行危险动作，改为说明需要用户确认什么。",
    "- 对卸载指定软件、清理明确指定软件残留、修改本项目代码/脚本，可以在合理范围内直接执行。",
    "",
    "执行要求：",
    "- 默认工作目录是 D:\\AI\\personal-ai-assistant。",
    "- 需要验证实际结果，不要只报告计划。",
    "- 最终回答要短，说明做了什么、验证了什么、是否还有残留风险。",
    "",
    `Task title: ${task.title}`,
    `Task type: ${task.taskType}`,
    `Priority: ${task.priority}`,
    `Source: ${task.source}`,
    "",
    "用户任务：",
    task.prompt
  ].join("\n");
}

function formatDuration(seconds) {
  const safeSeconds = Math.max(0, Number(seconds) || 0);
  const minutes = Math.floor(safeSeconds / 60);
  const rest = safeSeconds % 60;
  if (minutes < 1) return `${rest} 秒`;
  if (minutes < 60) return `${minutes} 分 ${rest} 秒`;
  const hours = Math.floor(minutes / 60);
  return `${hours} 小时 ${minutes % 60} 分`;
}

function oneLine(text) {
  return String(text || "").replace(/\s+/g, " ").trim();
}

function truncate(text, maxLength = 260) {
  const clean = oneLine(text);
  if (clean.length <= maxLength) return clean;
  return `${clean.slice(0, Math.max(0, maxLength - 3))}...`;
}

function redactSensitive(text) {
  return String(text || "")
    .replace(/\/bot\d+:[A-Za-z0-9_-]+/g, "/bot[REDACTED]")
    .replace(/\b\d{6,}:[A-Za-z0-9_-]{20,}\b/g, "[TELEGRAM_BOT_TOKEN]")
    .replace(/\bAIza[0-9A-Za-z_-]{20,}\b/g, "[GOOGLE_API_KEY]")
    .replace(/\bGOCSPX-[A-Za-z0-9_-]+\b/g, "[GOOGLE_CLIENT_SECRET]")
    .replace(/\bya29\.[0-9A-Za-z._-]+\b/g, "[GOOGLE_ACCESS_TOKEN]")
    .replace(/\bsk-[A-Za-z0-9_-]{20,}\b/g, "[OPENAI_API_KEY]")
    .replace(/\bsk-proj-[A-Za-z0-9_-]{20,}\b/g, "[OPENAI_API_KEY]")
    .replace(
      /(\\?"(?:client_secret|refresh_token|access_token|id_token|api_key|token|password|pass|cookie|secret)\\?"\s*:\s*\\?")[^"\\]+(\\?")/gi,
      "$1[REDACTED]$2"
    )
    .replace(/(Authorization:\s*Bearer\s+)[A-Za-z0-9._~+/=-]+/gi, "$1[REDACTED]")
    .replace(/(TOKEN|KEY|SECRET|PASSWORD|PASS|COOKIE)\s*=\s*["']?[^"'\s;]+/gi, "$1=[REDACTED]");
}

function summarizeCommand(command) {
  const limit = envNumber("CODEX_AUTO_STATUS_COMMAND_CHARS", 260);
  const clean = redactSensitive(oneLine(command));
  const lower = clean.toLowerCase();

  const knownSteps = [
    ["start-mpscan", "Windows Defender 快速扫描"],
    ["get-mpcomputerstatus", "读取 Defender 状态"],
    ["get-mpthreat", "检查 Defender 当前威胁"],
    ["dism.exe /online /cleanup-image /restorehealth", "DISM 修复 Windows 组件存储"],
    ["dism.exe /online /cleanup-image /scanhealth", "DISM 扫描 Windows 组件存储"],
    ["dism.exe /online /cleanup-image /checkhealth", "DISM 检查 Windows 组件存储"],
    ["sfc.exe /scannow", "SFC 扫描并修复系统文件"],
    ["sfc.exe /verifyonly", "SFC 复查系统文件"],
    ["repair-volume", "扫描磁盘卷文件系统"],
    ["get-winevent", "读取 Windows 事件日志"],
    ["get-volume", "检查磁盘卷状态"],
    ["get-physicaldisk", "检查物理磁盘状态"],
    ["get-storagereliabilitycounter", "读取磁盘可靠性计数器"],
    ["npm run check", "检查 AI 助手项目脚本语法"],
    ["openclaw gateway health", "检查 OpenClaw gateway 状态"]
  ];

  for (const [needle, label] of knownSteps) {
    if (lower.includes(needle)) return label;
  }

  return truncate(clean, limit);
}

function readLogTail(file, maxBytes = 512 * 1024) {
  if (!file || !fs.existsSync(file)) return "";
  const stat = fs.statSync(file);
  const length = Math.min(stat.size, maxBytes);
  const start = Math.max(0, stat.size - length);
  const buffer = Buffer.alloc(length);
  const fd = fs.openSync(file, "r");
  try {
    fs.readSync(fd, buffer, 0, length, start);
  } finally {
    fs.closeSync(fd);
  }
  return buffer.toString("utf8");
}

function createRedactingLogWriter(file) {
  const stream = fs.createWriteStream(file, { flags: "a", encoding: "utf8" });
  let pending = "";

  return {
    write(chunk) {
      pending += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk || "");
      const lines = pending.split(/\r?\n/);
      pending = lines.pop() ?? "";
      for (const line of lines) {
        stream.write(`${redactSensitive(line)}\n`);
      }
    },
    end() {
      if (pending) stream.write(redactSensitive(pending));
      stream.end();
      pending = "";
    }
  };
}

function summarizeCodexProgress(jsonLogFile) {
  const text = readLogTail(jsonLogFile);
  const activeCommands = new Map();
  let lastCompletedCommand = "";
  let lastAgentMessage = "";
  let lastTodo = "";

  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;

    let event;
    try {
      event = JSON.parse(trimmed);
    } catch {
      continue;
    }

    const item = event.item;
    if (!item || !item.id) continue;

    if (item.type === "command_execution") {
      if (event.type === "item.started") {
        activeCommands.set(item.id, item.command || "");
      } else if (event.type === "item.completed") {
        activeCommands.delete(item.id);
        const suffix = typeof item.exit_code === "number" ? `，退出码 ${item.exit_code}` : "";
        lastCompletedCommand = `${summarizeCommand(item.command)}${suffix}`;
      }
    }

    if (item.type === "agent_message" && item.text) {
      lastAgentMessage = truncate(item.text, 220);
    }

    if (item.type === "todo_list" && Array.isArray(item.items)) {
      const done = item.items.filter((entry) => entry.completed).length;
      lastTodo = `清单进度 ${done}/${item.items.length}`;
    }
  }

  const active = Array.from(activeCommands.values()).filter(Boolean);
  const currentStep = active.length > 0
    ? `正在执行：${summarizeCommand(active.at(-1))}`
    : lastAgentMessage
      ? `正在整理：${lastAgentMessage}`
      : lastCompletedCommand
        ? `最近完成：${lastCompletedCommand}`
        : "已启动，等待 Codex 输出第一个步骤";

  return {
    currentStep,
    activeCount: active.length,
    lastCompletedCommand,
    lastAgentMessage,
    lastTodo
  };
}

function buildProgressMessage({ task, elapsedSeconds, jsonLogFile }) {
  const status = summarizeCodexProgress(jsonLogFile);
  const lines = [
    `Codex 任务进度：${task.title}`,
    `状态：执行中`,
    `已运行：${formatDuration(elapsedSeconds)}`,
    `当前步骤：${status.currentStep}`
  ];

  if (status.activeCount > 1) {
    lines.push(`并行步骤：${status.activeCount} 个`);
  }
  if (status.lastCompletedCommand) {
    lines.push(`最近完成：${status.lastCompletedCommand}`);
  }
  if (status.lastTodo) {
    lines.push(status.lastTodo);
  }

  return lines.join("\n");
}

function runCodexExec({ root, prompt, taskStem, onProgress }) {
  const entrypoint = codexEntrypoint(root);
  if (!fs.existsSync(entrypoint)) {
    throw new Error(`Codex CLI not installed at ${entrypoint}. Run npm install first.`);
  }

  const tmpDir = path.join(root, "data", "tmp", "codex-auto");
  const logDir = path.join(root, "data", "logs");
  fs.mkdirSync(tmpDir, { recursive: true });
  fs.mkdirSync(logDir, { recursive: true });

  const safeStem = taskStem.replace(/[^a-z0-9_.-]+/gi, "-").slice(0, 120) || timestampForFile();
  const lastMessageFile = path.join(tmpDir, `${safeStem}.last.txt`);
  const jsonLogFile = path.join(logDir, `codex-auto-${safeStem}.jsonl`);
  const sandbox = process.env.CODEX_AUTO_SANDBOX || "danger-full-access";
  const timeoutMs = envNumber("CODEX_AUTO_TIMEOUT_SECONDS", 1800) * 1000;
  const progressMs = envNumber("CODEX_AUTO_PROGRESS_SECONDS", 60) * 1000;

  fs.rmSync(lastMessageFile, { force: true });

  const args = [
    "exec",
    "-C",
    root,
    "--skip-git-repo-check",
    "-s",
    sandbox,
    "--json",
    "--output-last-message",
    lastMessageFile,
    "--color",
    "never",
    "-"
  ];

  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [entrypoint, ...args], {
      cwd: root,
      env: process.env,
      shell: false,
      stdio: ["pipe", "pipe", "pipe"]
    });

    const logStream = createRedactingLogWriter(jsonLogFile);
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`Codex exec timed out after ${timeoutMs / 1000}s`));
    }, timeoutMs);
    const startedAt = Date.now();
    const progressTimer = setInterval(() => {
      Promise.resolve(
        onProgress?.({
          elapsedSeconds: Math.round((Date.now() - startedAt) / 1000),
          jsonLogFile,
          lastMessageFile
        })
      ).catch(() => {
        // Progress reporting must not fail the actual task.
      });
    }, progressMs);

    child.stdout.on("data", (chunk) => logStream.write(chunk));
    child.stderr.on("data", (chunk) => logStream.write(chunk));
    child.on("error", (error) => {
      clearTimeout(timer);
      clearInterval(progressTimer);
      logStream.end();
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      clearInterval(progressTimer);
      logStream.end();
      if (code !== 0) {
        reject(new Error(`Codex exec failed with exit ${code}. Log: ${jsonLogFile}`));
        return;
      }
      const result = fs.existsSync(lastMessageFile)
        ? fs.readFileSync(lastMessageFile, "utf8").trim()
        : "";
      resolve({
        result: redactSensitive(result || `Codex exec completed but did not write ${lastMessageFile}.`),
        jsonLogFile,
        lastMessageFile
      });
    });

    child.stdin.end(prompt, "utf8");
  });
}

export async function processCodexAutoQueue({ notify = true } = {}) {
  loadEnv();

  const root = process.cwd();
  const inboxPath = process.env.CODEX_QUEUE_INBOX || "./data/queues/codex/inbox";
  const maxTasks = envNumber("CODEX_AUTO_MAX_TASKS", 1);
  const lockFile = resolveFromCwd(process.env.CODEX_AUTO_LOCK_FILE || "./data/state/codex-auto-worker.lock");
  ensureQueue(inboxPath);

  fs.mkdirSync(path.dirname(lockFile), { recursive: true });
  if (fs.existsSync(lockFile) && !boolEnv("CODEX_AUTO_IGNORE_LOCK", false)) {
    const stat = fs.statSync(lockFile);
    const staleMs = envNumber("CODEX_AUTO_LOCK_STALE_MINUTES", 120) * 60 * 1000;
    if (Date.now() - stat.mtimeMs < staleMs) {
      console.log(`Codex auto worker lock exists: ${lockFile}`);
      return [];
    }
    fs.rmSync(lockFile, { force: true });
  }

  fs.writeFileSync(lockFile, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }, null, 2), "utf8");

  const pending = listPendingTasks(inboxPath).slice(0, maxTasks);
  const results = [];

  try {
    for (const item of pending) {
      const claimed = claimTask(item, inboxPath);
      let task;
      try {
        task = readTask(claimed);
        if (notify) {
          await sendTelegramMessage(`Codex 任务已开始：${task.title}\n状态：已领取到 processing，正在启动 Codex。`);
        }
        const notifyStatusUpdates = boolEnv("CODEX_AUTO_STATUS_UPDATES", true);
        const taskStem = path.basename(claimed).replace(/\.[^.]+$/, "");
        const execution = await runCodexExec({
          root,
          prompt: buildPrompt(task),
          taskStem,
          onProgress: async ({ elapsedSeconds, jsonLogFile }) => {
            if (notify && notifyStatusUpdates) {
              await sendTelegramMessage(buildProgressMessage({ task, elapsedSeconds, jsonLogFile }));
            }
          }
        });
        const outFile = writeResult({ inboxPath, taskFile: claimed, task, result: execution.result });
        results.push({ ok: true, task, outFile, log: execution.jsonLogFile });
        if (notify) {
          await sendTelegramMessage(`Codex 自动任务完成：${task.title}\n\n${execution.result}`);
        }
      } catch (error) {
        const outFile = writeFailure({ inboxPath, taskFile: claimed, task, error });
        results.push({ ok: false, task, outFile, error });
        if (notify) {
          await sendTelegramMessage(`Codex 自动任务失败：${task?.title || item.name}\n\n${error.message || String(error)}`);
        }
      }
    }
  } finally {
    fs.rmSync(lockFile, { force: true });
  }

  return results;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  processCodexAutoQueue({ notify: !process.argv.includes("--no-notify") }).then((results) => {
    console.log(`Codex auto worker processed ${results.length} task(s).`);
  }).catch((error) => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  });
}
