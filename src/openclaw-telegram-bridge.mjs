import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createTask, ensureQueue, listPendingTasks } from "./queue.mjs";
import { envNumber, loadEnv, projectRoot, resolveFromCwd } from "./env.mjs";
import { OWNER_COMMAND_MENU } from "./openclaw/command-menu.mjs";
import { macSatelliteHealth } from "./satellite/mac.mjs";
import { appendAudit } from "./security/audit.mjs";
import { isExpired, loadApprovals, resolveApproval, saveApprovals } from "./security/pending.mjs";
import { classifyTask, TIER } from "./security/policy.mjs";

const DEFAULT_MESSAGE_FILE = "./.openclaw/state/agents/main/sessions/sessions.json.telegram-messages.json";
const DEFAULT_STATE_FILE = "./data/state/openclaw-telegram-bridge-state.json";
const MAINTENANCE_ACTIONS = [
  "dism-restorehealth",
  "dism-scanhealth",
  "sfc-scannow",
  "defender-quickscan",
  "defender-status",
  "disk-reliability",
  "volume-status"
];
const MAINTENANCE_COMMANDS = {
  "/defender_status": "defender-status",
  "/defender_scan": "defender-quickscan",
  "/sfc_scan": "sfc-scannow",
  "/dism_restore": "dism-restorehealth",
  "/dism_scan": "dism-scanhealth",
  "/disk_status": "volume-status",
  "/disk_health": "disk-reliability"
};

function boolEnv(name, fallback = false) {
  const value = process.env[name];
  if (value == null || value === "") return fallback;
  return ["1", "true", "yes", "on"].includes(String(value).toLowerCase());
}

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

function readTelegramMessages(file) {
  if (!fs.existsSync(file)) return [];
  const lines = fs.readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean);
  const messages = [];
  for (const line of lines) {
    try {
      const entry = JSON.parse(line.replace(/^\uFEFF/, ""));
      const sourceMessage = entry?.node?.sourceMessage;
      if (!sourceMessage?.message_id || !sourceMessage?.text) continue;
      messages.push({
        key: entry.key || `${sourceMessage.chat?.id || "chat"}:${sourceMessage.message_id}`,
        chatId: String(sourceMessage.chat?.id || ""),
        messageId: sourceMessage.message_id,
        date: sourceMessage.date || 0,
        text: sourceMessage.text
      });
    } catch {
      // Ignore partially-written JSONL lines.
    }
  }
  return messages.sort((a, b) => (a.date - b.date) || (a.messageId - b.messageId));
}

function commandParts(text) {
  const trimmed = String(text || "").trim();
  if (!trimmed.startsWith("/")) return null;
  const firstSpace = trimmed.search(/\s/);
  const rawCommand = firstSpace === -1 ? trimmed : trimmed.slice(0, firstSpace);
  const command = rawCommand.replace(/@.+$/, "").toLowerCase();
  const rest = firstSpace === -1 ? "" : trimmed.slice(firstSpace + 1).trim();
  return { command, rest };
}

async function telegramApi(token, method, body) {
  const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Telegram ${method} failed ${response.status}: ${text}`);
  }
  const json = await response.json();
  if (!json.ok) throw new Error(`Telegram ${method} returned ok=false`);
  return json.result;
}

async function send(token, chatId, text, dryRun) {
  if (dryRun) {
    console.log(`[dry-run send ${chatId}] ${text}`);
    return;
  }
  await telegramApi(token, "sendMessage", {
    chat_id: chatId,
    text: text.slice(0, 3900),
    disable_web_page_preview: false
  });
}

async function summarizeStatus() {
  const dataDir = resolveFromCwd("./data");
  const flags = ["assistant-desired-running.flag", "assistant-running.flag", "assistant-suspended-for-game.flag", "school-game-catchup-needed.flag"]
    .map((name) => `${name}: ${fs.existsSync(path.join(dataDir, name)) ? "YES" : "NO"}`)
    .join("\n");
  const localInbox = process.env.LOCAL_QUEUE_INBOX || "./data/queues/local/inbox";
  const codexInbox = process.env.CODEX_QUEUE_INBOX || "./data/queues/codex/inbox";
  ensureQueue(localInbox);
  ensureQueue(codexInbox);
  let macStatus;
  try {
    const health = await macSatelliteHealth();
    macStatus = health.online && health.agentRunning
      ? "Mac 卫星：在线（代理运行中）"
      : `Mac 卫星：离线${health.error ? `（${health.error}）` : ""}`;
  } catch (error) {
    macStatus = `Mac 卫星：离线（${error.message || String(error)}）`;
  }
  return [
    "AI 助手状态",
    "",
    flags,
    "",
    `Local 队列待处理：${listPendingTasks(localInbox).length}`,
    `Codex 队列待处理：${listPendingTasks(codexInbox).length}`,
    macStatus
  ].join("\n");
}

function runPowerShell(script, args = [], timeoutMs = 180000) {
  const result = spawnSync("powershell.exe", [
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    path.resolve(script),
    ...args
  ], {
    cwd: process.cwd(),
    encoding: "utf8",
    timeout: timeoutMs
  });

  const output = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
  if (result.status !== 0) {
    throw new Error(output || `PowerShell command failed with exit ${result.status}`);
  }
  return output || "命令已执行。";
}

async function registerOwnerCommandMenu(token, chatId, dryRun) {
  if (dryRun) {
    console.log(`[dry-run setMyCommands chat ${chatId}] ${OWNER_COMMAND_MENU.map(({ command }) => command).join(", ")}`);
    return;
  }
  try {
    await telegramApi(token, "setMyCommands", {
      scope: { type: "chat", chat_id: Number(chatId) },
      commands: OWNER_COMMAND_MENU
    });
    console.log("Owner Telegram command menu registered (chat scope).");
  } catch (error) {
    console.warn(`Owner command menu registration failed: ${error.message || String(error)}`);
  }
}

async function dispatchMaintenance({ token, chatId, action, dryRun }) {
  const actionToken = String(action || "").trim();
  if (!/^[a-z][a-z0-9-]+$/.test(actionToken)) {
    await send(token, chatId, "动作名不合法", dryRun);
    return;
  }

  await send(token, chatId, `维护任务已派发：${actionToken}，执行中…`, dryRun);
  const output = runPowerShell(
    "./scripts/admin-maintenance/request-admin-maintenance.ps1",
    ["-Action", actionToken, "-TimeoutSeconds", "600"],
    620000
  );
  const resultText = output.length > 3500 ? `${output.slice(0, 3500)}\n\n...输出已截断` : output;
  await send(token, chatId, resultText, dryRun);
}

function createRemoteCodexTask(text) {
  const prompt = [
    "用户通过 Telegram 远程下达 Codex 维护任务。",
    `默认工作目录：${projectRoot()}。`,
    "可以读取、修改本项目代码/脚本/文档，并运行必要验证。",
    "必须遵守安全边界：不要泄露或打印 .env 密钥；不要发送邮件、提交表单、改账号、付费、删除大量文件或做不可逆操作，除非用户明确确认。",
    "完成后用简体中文写 Telegram 可读的结果，说明改了什么、验证了什么、还有什么风险。",
    "",
    "用户任务：",
    text
  ].join("\n");

  return createTask({
    inboxPath: process.env.CODEX_QUEUE_INBOX || "./data/queues/codex/inbox",
    title: text.slice(0, 60) || "Telegram Codex 远程任务",
    prompt,
    taskType: "remote-maintenance",
    source: "openclaw-telegram-bridge",
    priority: "high"
  });
}

function createRemoteLocalTask(text) {
  return createTask({
    inboxPath: process.env.LOCAL_QUEUE_INBOX || "./data/queues/local/inbox",
    title: text.slice(0, 60) || "Telegram 本地任务",
    prompt: text,
    taskType: "telegram-local",
    source: "openclaw-telegram-bridge",
    priority: "normal"
  });
}

function createChatTask(text) {
  return createTask({
    inboxPath: process.env.CODEX_QUEUE_INBOX || "./data/queues/codex/inbox",
    title: text.slice(0, 60) || "Telegram 提问",
    prompt: text,
    taskType: "telegram-chat",
    source: "openclaw-telegram-bridge",
    priority: "normal"
  });
}

function createApprovedPrivilegedTask(entry) {
  const file = createTask({
    inboxPath: process.env.CODEX_QUEUE_INBOX || "./data/queues/codex/inbox",
    title: entry.prompt.slice(0, 60) || "已批准的特权任务",
    prompt: entry.prompt,
    taskType: "approved-privileged",
    source: "openclaw-telegram-bridge",
    priority: "high"
  });
  const task = JSON.parse(fs.readFileSync(file, "utf8"));
  writeJson(file, { ...task, approvalId: entry.id });
  return file;
}

async function handleFreeText({ token, chatId, text, dryRun }) {
  createChatTask(text);
  await send(token, chatId, "🤔 收到，正在思考，稍等…（由 Claude 回答）", dryRun);
}

async function handleCommand({ token, chatId, text, dryRun }) {
  const parsed = commandParts(text);
  if (!parsed) return false;
  const { command, rest } = parsed;

  if (command === "/help" || command === "/start") {
    await send(token, chatId, [
      "可用命令：",
      "/status - 查看助手状态",
      "/web <任务> - 用只读浏览器查看网页",
      "/screen [说明] - 查看当前电脑屏幕",
      "/mac <任务> - 交给 Mac 卫星的 Codex 执行",
      "/codex <任务> - 让 Codex 修改/维护本项目",
      "/study <主题> - 蒸馏课程主题，生成学习文档",
      "/local <任务> - 交给本地 Ollama 队列",
      "/maint <动作> - 派发管理员维护任务",
      "也可以点左下角 Menu 按钮选择维护命令。",
      "/school - 立即检查学校邮件",
      "/mail - 立即检查 Gmail",
      "/game - 立即检查游戏资讯",
      "/digest - 发送综合摘要",
      "/due - 查看近期作业 due",
      "/ok <ID> - 批准待确认的特权任务",
      "/no <ID> - 拒绝待确认的特权任务",
      "/stop - 急停所有自动处理并作废待确认任务",
      "/pause /resume - 暂停/恢复自动处理"
    ].join("\n"), dryRun);
    return true;
  }

  if (command === "/due") {
    try {
      const { runCanvasDue } = await import("./canvas-check.mjs");
      await send(token, chatId, await runCanvasDue(), dryRun);
    } catch {
      await send(token, chatId, "查询 Canvas 失败", dryRun);
    }
    return true;
  }

  if (command === "/status") {
    await send(token, chatId, await summarizeStatus(), dryRun);
    return true;
  }

  if (command === "/ok") {
    const id = rest.toUpperCase();
    if (!/^[A-Z0-9]{6,8}$/.test(id)) {
      await send(token, chatId, "用法：/ok <确认 ID>", dryRun);
      return true;
    }
    const entry = loadApprovals()[id];
    if (!entry) {
      await send(token, chatId, `找不到待确认任务 ${id}。`, dryRun);
      return true;
    }
    if (entry.status !== "pending") {
      const messages = {
        approved: "该任务已经批准，不能重复批准。",
        denied: "该任务已经拒绝。",
        expired: "该确认已经过期。"
      };
      await send(token, chatId, messages[entry.status] || "该任务已经处理。", dryRun);
      return true;
    }
    if (isExpired(entry, Date.now())) {
      resolveApproval(id, "expired");
      appendAudit({
        kind: "approval",
        tier: entry.tier,
        reason: entry.reason,
        promptPreview: entry.prompt,
        result: "expired",
        approvalId: id
      });
      await send(token, chatId, "该确认已经过期。", dryRun);
      return true;
    }
    const classification = classifyTask(entry.prompt);
    if (classification.tier === TIER.FORBIDDEN) {
      resolveApproval(id, "denied");
      appendAudit({
        kind: "approval",
        tier: classification.tier,
        reason: classification.reason,
        promptPreview: entry.prompt,
        result: "denied",
        approvalId: id
      });
      await send(token, chatId, `这个任务命中禁止档，无法执行。原因：${classification.reason}`, dryRun);
      return true;
    }
    resolveApproval(id, "approved");
    createApprovedPrivilegedTask(entry);
    appendAudit({
      kind: "approval",
      tier: classification.tier,
      reason: classification.reason,
      promptPreview: entry.prompt,
      result: "approved",
      approvalId: id
    });
    await send(token, chatId, "已批准，开始执行。", dryRun);
    return true;
  }

  if (command === "/no") {
    const id = rest.toUpperCase();
    if (!/^[A-Z0-9]{6,8}$/.test(id)) {
      await send(token, chatId, "用法：/no <确认 ID>", dryRun);
      return true;
    }
    const entry = loadApprovals()[id];
    if (!entry) {
      await send(token, chatId, `找不到待确认任务 ${id}。`, dryRun);
      return true;
    }
    if (entry.status !== "pending") {
      const messages = {
        approved: "该任务已经批准。",
        denied: "该任务已经拒绝。",
        expired: "该确认已经过期。"
      };
      await send(token, chatId, messages[entry.status] || "该任务已经处理。", dryRun);
      return true;
    }
    if (isExpired(entry, Date.now())) {
      resolveApproval(id, "expired");
      appendAudit({
        kind: "approval",
        tier: entry.tier,
        reason: entry.reason,
        promptPreview: entry.prompt,
        result: "expired",
        approvalId: id
      });
      await send(token, chatId, "该确认已经过期。", dryRun);
      return true;
    }
    resolveApproval(id, "denied");
    appendAudit({
      kind: "approval",
      tier: entry.tier,
      reason: entry.reason,
      promptPreview: entry.prompt,
      result: "denied",
      approvalId: id
    });
    await send(token, chatId, "已拒绝。", dryRun);
    return true;
  }

  if (command === "/pause") {
    const flagFile = resolveFromCwd("./data/state/assistant-paused.flag");
    fs.mkdirSync(path.dirname(flagFile), { recursive: true });
    fs.writeFileSync(flagFile, `${new Date().toISOString()}\n`, "utf8");
    await send(token, chatId, "已暂停自动摘要/检查。发 /resume 恢复。", dryRun);
    return true;
  }

  if (command === "/stop") {
    const flagFile = resolveFromCwd("./data/state/assistant-paused.flag");
    fs.mkdirSync(path.dirname(flagFile), { recursive: true });
    fs.writeFileSync(flagFile, `${new Date().toISOString()}\n`, "utf8");
    const approvals = loadApprovals();
    let deniedCount = 0;
    for (const [id, entry] of Object.entries(approvals)) {
      if (entry.status !== "pending") continue;
      approvals[id] = { ...entry, status: "denied" };
      deniedCount += 1;
      appendAudit({
        kind: "stop",
        tier: entry.tier,
        reason: entry.reason,
        promptPreview: entry.prompt,
        result: "denied",
        approvalId: id
      });
    }
    saveApprovals(approvals);
    await send(
      token,
      chatId,
      `🛑 已急停：暂停所有自动处理，已作废 ${deniedCount} 条待确认任务。发 /resume 恢复。`,
      dryRun
    );
    return true;
  }

  if (command === "/resume") {
    const flagFile = resolveFromCwd("./data/state/assistant-paused.flag");
    fs.rmSync(flagFile, { force: true });
    await send(token, chatId, "已恢复。", dryRun);
    return true;
  }

  if (MAINTENANCE_COMMANDS[command]) {
    await dispatchMaintenance({ token, chatId, action: MAINTENANCE_COMMANDS[command], dryRun });
    return true;
  }

  if (command === "/maint") {
    const action = rest;
    if (!action) {
      await send(token, chatId, [
        "用法：/maint <动作>",
        "",
        "可用动作：",
        MAINTENANCE_ACTIONS.join(", ")
      ].join("\n"), dryRun);
      return true;
    }
    await dispatchMaintenance({ token, chatId, action, dryRun });
    return true;
  }

  if (command === "/web") {
    if (!rest) {
      await send(token, chatId, "用法：/web 要浏览器查看的网页任务", dryRun);
      return true;
    }
    createChatTask(`[web] ${rest}`);
    await send(token, chatId, "🌐 收到，正在用只读浏览器查看…", dryRun);
    return true;
  }

  if (command === "/screen") {
    const request = rest || "查看当前屏幕并说明你看到的内容";
    createChatTask(`[screen] ${request}`);
    await send(token, chatId, "🖥 收到，正在查看当前屏幕…", dryRun);
    return true;
  }

  if (command === "/mac") {
    if (!rest) {
      await send(token, chatId, "用法：/mac 要交给 Mac 卫星执行的任务", dryRun);
      return true;
    }
    createChatTask(`[mac] ${rest}`);
    await send(token, chatId, "💻 收到，正在交给 Mac 卫星处理…", dryRun);
    return true;
  }

  if (command === "/codex" || command === "/dev" || command === "/update") {
    if (!rest) {
      await send(token, chatId, "用法：/codex 你要我在电脑上修改或检查的任务", dryRun);
      return true;
    }
    const file = createRemoteCodexTask(rest);
    await send(token, chatId, `Codex 远程任务已入队。\n\n${path.basename(file)}\n\n本地检测器会提醒 Codex 介入处理。`, dryRun);
    return true;
  }

  if (command === "/study") {
    if (!rest) {
      await send(token, chatId, "用法：/study 课程/主题，例如：/study MIET2115 断裂力学 应力强度因子没听懂", dryRun);
      return true;
    }
    createTask({
      inboxPath: process.env.CODEX_QUEUE_INBOX || "./data/queues/codex/inbox",
      title: rest.slice(0, 60) || "课程蒸馏",
      prompt: rest,
      taskType: "study-distill",
      source: "openclaw-telegram-bridge",
      priority: "high"
    });
    await send(token, chatId, `📚 收到，开始蒸馏《${rest.slice(0, 40)}》。完成后把学习文档发给你（通常几分钟）。`, dryRun);
    return true;
  }

  if (command === "/local") {
    if (!rest) {
      await send(token, chatId, "用法：/local 要交给本地模型处理的任务", dryRun);
      return true;
    }
    const file = createRemoteLocalTask(rest);
    await send(token, chatId, `本地模型任务已入队。\n\n${path.basename(file)}`, dryRun);
    return true;
  }

  const commandMap = {
    "/school": ["./scripts/run-school-check.ps1", ["--force-school", "--ignore-game-mode"]],
    "/mail": ["./scripts/run-school-check.ps1", ["--force-personal", "--ignore-game-mode"]],
    "/game": ["./scripts/run-school-check.ps1", ["--force-game", "--ignore-game-mode"]],
    "/digest": ["./scripts/run-digest.ps1", []]
  };

  if (commandMap[command]) {
    const [script, args] = commandMap[command];
    await send(token, chatId, `${command} 已收到，正在执行。`, dryRun);
    const output = runPowerShell(script, args);
    await send(token, chatId, output, dryRun);
    return true;
  }

  return false;
}

async function processMessages({ messageFile, stateFile, token, chatId, dryRun, processExisting }) {
  const messages = readTelegramMessages(messageFile);
  let state = readJson(stateFile, null);

  if (!state) {
    state = { seenKeys: [] };
    if (!processExisting) {
      state.seenKeys = messages.map((message) => message.key).slice(-2000);
      writeJson(stateFile, state);
      console.log(`OpenClaw Telegram bridge bootstrapped ${state.seenKeys.length} existing message(s).`);
      return 0;
    }
  }

  const seen = new Set(state.seenKeys || []);
  let handled = 0;
  for (const message of messages) {
    if (seen.has(message.key)) continue;
    seen.add(message.key);
    if (String(message.chatId) !== String(chatId)) continue;
    try {
      if (await handleCommand({ token, chatId, text: message.text, dryRun })) {
        handled += 1;
      } else {
        const t = String(message.text || "").trim();
        if (t && !t.startsWith("/")) {
          await handleFreeText({ token, chatId, text: message.text, dryRun });
          handled += 1;
        }
      }
    } catch (error) {
      await send(token, chatId, `命令执行失败：${error.message || String(error)}`, dryRun);
    }
  }

  state.seenKeys = [...seen].slice(-2000);
  writeJson(stateFile, state);
  return handled;
}

async function main() {
  loadEnv();
  const once = hasArg("--once");
  const dryRun = hasArg("--dry-run");
  const processExisting = hasArg("--process-existing");

  if (!boolEnv("ENABLE_OPENCLAW_TELEGRAM_BRIDGE", true)) {
    console.log("OpenClaw Telegram bridge disabled. Set ENABLE_OPENCLAW_TELEGRAM_BRIDGE=true to enable.");
    return;
  }

  const token = process.env.TELEGRAM_BOT_TOKEN || "";
  const chatId = String(process.env.TELEGRAM_CHAT_ID || "");
  if (!token || !chatId) {
    throw new Error("OpenClaw Telegram bridge needs TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID.");
  }

  const messageFile = resolveFromCwd(process.env.OPENCLAW_TELEGRAM_MESSAGES_FILE || DEFAULT_MESSAGE_FILE);
  const stateFile = resolveFromCwd(process.env.OPENCLAW_TELEGRAM_BRIDGE_STATE_FILE || DEFAULT_STATE_FILE);
  const pollSeconds = envNumber("OPENCLAW_TELEGRAM_BRIDGE_POLL_SECONDS", 3);

  await registerOwnerCommandMenu(token, chatId, dryRun);
  console.log("OpenClaw Telegram bridge started.");
  while (true) {
    const handled = await processMessages({ messageFile, stateFile, token, chatId, dryRun, processExisting });
    if (handled > 0) console.log(`Handled ${handled} OpenClaw Telegram command(s).`);
    if (once) return;
    await new Promise((resolve) => setTimeout(resolve, pollSeconds * 1000));
  }
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
