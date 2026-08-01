import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { createTask, ensureQueue, listPendingTasks } from "./queue.mjs";
import { envNumber, loadEnv, projectRoot, resolveFromCwd } from "./env.mjs";
import { OWNER_COMMAND_MENU } from "./openclaw/command-menu.mjs";
import { resolveNodeId } from "./brain/supervisor.mjs";
import { nodeRegistry, nodeStatus } from "./satellite/registry.mjs";
import { appendAudit } from "./security/audit.mjs";
import { isExpired, loadApprovals, resolveApproval, saveApprovals } from "./security/pending.mjs";
import { classifyTask, TIER } from "./security/policy.mjs";
import { requestJson } from "./telegram/http.mjs";
import { fetchUpdates, nextOffset, parseUpdates } from "./telegram/updates.mjs";

const DEFAULT_MESSAGE_FILE = "./.openclaw/state/agents/main/sessions/sessions.json.telegram-messages.json";
const DEFAULT_STATE_FILE = "./data/state/openclaw-telegram-bridge-state.json";
const DEFAULT_UPDATE_OFFSET_FILE = "./data/state/telegram-update-offset.json";
const DEFAULT_DIRECT_HEARTBEAT_FILE = "./data/state/telegram-direct-heartbeat.json";
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

function errorDetails(error) {
  return error?.stack || error?.message || String(error);
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
  const json = await requestJson(`https://api.telegram.org/bot${token}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body
  });
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

function capabilityAvailability(capability, registry, statuses, selfId) {
  if (registry[selfId].capabilities.includes(capability)) return "可用（本机）";
  const remoteNodes = Object.values(registry)
    .filter((node) => node.id !== selfId && node.capabilities.includes(capability));
  if (remoteNodes.some((node) =>
    statuses[node.id]?.online && statuses[node.id]?.agentRunning !== false)) {
    return "需要另一台电脑，当前可用";
  }
  if (remoteNodes.length > 0) return "这个功能需要另一台电脑，它当前离线";
  return "当前不可用";
}

export async function summarizeStatus(dependencies = {}) {
  const env = dependencies.env || process.env;
  const platform = dependencies.platform || process.platform;
  const selfId = dependencies.selfId || resolveNodeId(env, platform);
  const dataDir = dependencies.dataDir || resolveFromCwd("./data");
  const existsSync = dependencies.existsSync || fs.existsSync;
  const ensureQueueImpl = dependencies.ensureQueue || ensureQueue;
  const listPendingTasksImpl = dependencies.listPendingTasks || listPendingTasks;
  const flags = ["assistant-desired-running.flag", "assistant-running.flag", "assistant-suspended-for-game.flag", "school-game-catchup-needed.flag"]
    .map((name) => `${name}: ${existsSync(path.join(dataDir, name)) ? "YES" : "NO"}`)
    .join("\n");
  const localInbox = dependencies.localInbox || env.LOCAL_QUEUE_INBOX || "./data/queues/local/inbox";
  const codexInbox = dependencies.codexInbox || env.CODEX_QUEUE_INBOX || "./data/queues/codex/inbox";
  ensureQueueImpl(localInbox);
  ensureQueueImpl(codexInbox);
  const registry = nodeRegistry({ selfId, env, platform });
  const statusImpl = dependencies.nodeStatus || nodeStatus;
  const statusEntries = await Promise.all(Object.keys(registry).map(async (nodeId) => [
    nodeId,
    await statusImpl(nodeId, { selfId, probes: dependencies.probes, env, platform })
  ]));
  const statuses = Object.fromEntries(statusEntries);
  const commonStatus = capabilityAvailability("files", registry, statuses, selfId);
  const windowsStatus = capabilityAvailability("browser", registry, statuses, selfId);
  const selfLabel = selfId === "mac" ? "这台 Mac" : "这台 Windows 电脑";
  return [
    "AI 助手状态",
    "",
    `当前运行节点：${selfLabel}`,
    "",
    flags,
    "",
    `Local 队列待处理：${listPendingTasksImpl(localInbox).length}`,
    `Codex 队列待处理：${listPendingTasksImpl(codexInbox).length}`,
    `文件 / Codex / Canvas / 图形操控：${commonStatus}`,
    `浏览器 / 屏幕查看 / Outlook / 系统维护：${windowsStatus}`
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

function createChatTask(text, { forcedNodeId } = {}) {
  const prompt = forcedNodeId ? `[force-node:${forcedNodeId}] ${text}` : text;
  return createTask({
    inboxPath: process.env.CODEX_QUEUE_INBOX || "./data/queues/codex/inbox",
    title: text.slice(0, 60) || "Telegram 提问",
    prompt,
    taskType: "telegram-chat",
    source: "openclaw-telegram-bridge",
    priority: "normal"
  });
}

function createApprovedPrivilegedTask(entry) {
  const title = entry.prompt.replace(/^\s*\[force-node:(?:mac|windows)\]\s*/i, "");
  const file = createTask({
    inboxPath: process.env.CODEX_QUEUE_INBOX || "./data/queues/codex/inbox",
    title: title.slice(0, 60) || "已批准的特权任务",
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
      "/mac <任务> - 调试时强制指定 Mac（一般不需要用）",
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
      await send(token, chatId, "用法：/mac <任务>（调试时强制指定 Mac，一般不需要用）", dryRun);
      return true;
    }
    createChatTask(rest, { forcedNodeId: "mac" });
    await send(token, chatId, "💻 收到，正在按调试指定处理…", dryRun);
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
      await send(token, chatId, "用法：/study 课程/主题，例如：/study <course-code> 课程主题没听懂", dryRun);
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

async function processMessageList({ messages, stateFile, token, chatId, dryRun, processExisting }) {
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

async function processMessages({ messageFile, stateFile, token, chatId, dryRun, processExisting }) {
  const messages = readTelegramMessages(messageFile);
  return processMessageList({ messages, stateFile, token, chatId, dryRun, processExisting });
}

function rememberMessageKeys(messages, stateFile) {
  const state = readJson(stateFile, null) || { seenKeys: [] };
  const seen = new Set(state.seenKeys || []);
  for (const message of messages) seen.add(message.key);
  state.seenKeys = [...seen].slice(-2000);
  writeJson(stateFile, state);
}

function readUpdateOffset(offsetFile) {
  if (!fs.existsSync(offsetFile)) return null;
  const state = readJson(offsetFile, null);
  if (!Number.isInteger(state?.offset) || state.offset < 0) {
    throw new Error(`Invalid Telegram update offset file: ${offsetFile}`);
  }
  return state.offset;
}

export async function runDirectMode({
  token,
  chatId,
  stateFile,
  offsetFile,
  heartbeatFile = resolveFromCwd(DEFAULT_DIRECT_HEARTBEAT_FILE),
  dryRun,
  processExisting,
  once,
  retrySeconds,
  failureWarnThreshold,
  idleLogEvery = 20,
  fetchUpdatesImpl = fetchUpdates,
  logger = console
}) {
  const savedOffset = readUpdateOffset(offsetFile);
  let skipHistorical = savedOffset == null && !processExisting;
  let offset = savedOffset ?? (skipHistorical ? -1 : 0);
  let consecutiveFailures = 0;
  let emptyPolls = 0;

  while (true) {
    let updates;
    try {
      updates = await fetchUpdatesImpl({ token, offset });
      consecutiveFailures = 0;
    } catch (error) {
      consecutiveFailures += 1;
      logger.error(`Telegram 直连拉取失败（连续 ${consecutiveFailures} 次）：\n${errorDetails(error)}`);
      if (consecutiveFailures === failureWarnThreshold) {
        logger.warn(`[Telegram 直连严重警告] getUpdates 已连续失败 ${failureWarnThreshold} 次，请检查网络和 Bot 状态。`);
      }
      await new Promise((resolve) => setTimeout(resolve, retrySeconds * 1000));
      continue;
    }

    let stage = "写入心跳";
    try {
      writeJson(heartbeatFile, {
        atMs: Date.now(),
        offset,
        lastUpdates: updates.length
      });

      stage = "解析 updates";
      const messages = parseUpdates(updates);
      let handled = 0;
      if (skipHistorical) {
        if (updates.length > 0) {
          stage = "记录历史消息基线";
          rememberMessageKeys(messages, stateFile);
          stage = "计算 offset";
          offset = nextOffset(updates, 0);
          skipHistorical = false;
          stage = "写入 offset";
          writeJson(offsetFile, { offset });
        }
      } else {
        stage = "处理消息";
        handled = await processMessageList({
          messages,
          stateFile,
          token,
          chatId,
          dryRun,
          processExisting: true
        });
        stage = "计算 offset";
        offset = nextOffset(updates, offset);
        stage = "写入 offset";
        writeJson(offsetFile, { offset });
      }

      if (updates.length > 0) {
        emptyPolls = 0;
        logger.log(`Telegram 直连拉取到 ${updates.length} 条新消息（文本 ${messages.length} 条，处理 ${handled} 条）。`);
      } else {
        emptyPolls += 1;
        if (emptyPolls % idleLogEvery === 0) {
          logger.log(`直连轮询存活（offset=${offset}）`);
        }
      }
      if (once) return;
    } catch (error) {
      logger.error(`[Telegram 直连轮询异常：${stage}]\n${errorDetails(error)}`);
      await new Promise((resolve) => setTimeout(resolve, retrySeconds * 1000));
    }
  }
}

async function main() {
  loadEnv();
  const once = hasArg("--once");
  const dryRun = hasArg("--dry-run");
  const processExisting = hasArg("--process-existing");
  const directMode = boolEnv("TELEGRAM_DIRECT_MODE", false);

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
  const offsetFile = resolveFromCwd(DEFAULT_UPDATE_OFFSET_FILE);
  const heartbeatFile = resolveFromCwd(DEFAULT_DIRECT_HEARTBEAT_FILE);
  const pollSeconds = envNumber("OPENCLAW_TELEGRAM_BRIDGE_POLL_SECONDS", 3);
  const failureWarnThreshold = Math.max(
    1,
    Math.trunc(envNumber("TELEGRAM_DIRECT_FAILURE_WARN_THRESHOLD", 5))
  );
  const idleLogEvery = Math.max(
    1,
    Math.trunc(envNumber("TELEGRAM_DIRECT_IDLE_LOG_EVERY", 20))
  );

  console.log(`当前模式：${directMode ? "Telegram 直连模式" : "OpenClaw 文件模式"}`);
  await registerOwnerCommandMenu(token, chatId, dryRun);
  console.log("OpenClaw Telegram bridge started.");
  if (directMode) {
    await runDirectMode({
      token,
      chatId,
      stateFile,
      offsetFile,
      heartbeatFile,
      dryRun,
      processExisting,
      once,
      retrySeconds: pollSeconds,
      failureWarnThreshold,
      idleLogEvery
    });
    return;
  }

  while (true) {
    const handled = await processMessages({ messageFile, stateFile, token, chatId, dryRun, processExisting });
    if (handled > 0) console.log(`Handled ${handled} OpenClaw Telegram command(s).`);
    if (once) return;
    await new Promise((resolve) => setTimeout(resolve, pollSeconds * 1000));
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    if (boolEnv("TELEGRAM_DIRECT_MODE", false)) {
      console.error(`[FATAL] 直连模式异常退出\n${errorDetails(error)}`);
    } else {
      console.error(errorDetails(error));
    }
    process.exitCode = 1;
  });
}
