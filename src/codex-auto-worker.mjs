import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { loadEnv, projectRoot, resolveFromCwd, timestampForFile } from "./env.mjs";
import { runClaudeChat, runClaudeText, SCREEN_SYSTEM_PROMPT } from "./brain/claude.mjs";
import {
  findAssignments,
  getAssignmentDetail,
  listActiveCourses,
  listUpcomingAssignments
} from "./canvas/api.mjs";
import { sendCanvasUnauthorizedAlert } from "./canvas/token-alert.mjs";
import { dispatchToMac } from "./satellite/mac.mjs";
import { pickNode } from "./satellite/registry.mjs";
import { appendAudit } from "./security/audit.mjs";
import { createApproval } from "./security/pending.mjs";
import {
  classifyTask,
  needsBrowser,
  needsCanvas,
  needsGuiControl,
  needsScreen,
  pickCapability,
  TIER
} from "./security/policy.mjs";
import { redactSensitive } from "./security/redact.mjs";
import { claimTask, ensureQueue, listPendingTasks, readTask, writeFailure, writeResult } from "./queue.mjs";
import { sendTelegramDocument, sendTelegramMessage } from "./telegram.mjs";

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

const FORCE_NODE_DIRECTIVE = /^\s*\[force-node:(mac|windows)\]\s*/i;
const OUTLOOK_INTENT = /\boutlook\b|微软(?:邮箱|邮件)|学校邮箱/i;
const NODE_CAPABILITY_BY_ROUTE = {
  assist: "codex",
  browse: "browser",
  screen: "screen",
  canvas: "canvas",
  "gui-control": "gui-control"
};

function routingPrompt(text) {
  const input = String(text ?? "");
  const match = input.match(FORCE_NODE_DIRECTIVE);
  return {
    forcedNodeId: match?.[1]?.toLowerCase() || null,
    prompt: match ? input.slice(match[0].length) : input
  };
}

function nodeCapabilityFor(task, route) {
  if (task.taskType === "remote-maintenance") return "maintenance";
  if (OUTLOOK_INTENT.test(task.prompt)) return "outlook";
  return NODE_CAPABILITY_BY_ROUTE[route] || "codex";
}

function unavailableNodeMessage(capability, reason) {
  if (capability === "gui-control") {
    return "这个任务需要图形界面操控，但 Mac 卫星当前离线（可能休眠），这台电脑也暂时不可用。请唤醒 Mac 或稍后再试。";
  }
  const labels = {
    browser: "浏览器",
    canvas: "Canvas",
    codex: "Codex",
    maintenance: "系统维护",
    outlook: "Outlook",
    screen: "屏幕查看"
  };
  return `这个任务需要${labels[capability] || capability}能力，但当前没有可用节点。${reason || "请稍后再试。"}`;
}

export function takeScreenshot(root = projectRoot(), spawnSyncImpl = spawnSync) {
  const scriptPath = path.join(root, "scripts", "take-screenshot.ps1");
  const result = spawnSyncImpl(
    "powershell.exe",
    ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", scriptPath],
    {
      cwd: root,
      encoding: "utf8",
      shell: false,
      windowsHide: true
    }
  );

  if (result.error || result.status !== 0) {
    const detail = oneLine(result.stderr || result.stdout || result.error?.message);
    throw new Error(detail || `截图脚本退出码：${result.status ?? "unknown"}`);
  }

  const outputPath = String(result.stdout || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .at(-1);
  if (!outputPath || !path.isAbsolute(outputPath)) {
    throw new Error("截图脚本未返回 PNG 绝对路径");
  }

  const screenshotPath = path.resolve(outputPath);
  const screenshotRoot = path.join(root, "data", "screenshots");
  const relativePath = path.relative(screenshotRoot, screenshotPath);
  if (relativePath.startsWith("..") || path.isAbsolute(relativePath) || path.extname(screenshotPath).toLowerCase() !== ".png") {
    throw new Error("截图脚本返回了预期目录之外的路径");
  }
  if (!fs.existsSync(screenshotPath)) {
    throw new Error(`截图文件不存在：${screenshotPath}`);
  }

  return screenshotPath;
}

export async function runScreenChat(task, root = projectRoot(), dependencies = {}) {
  const capture = dependencies.takeScreenshot || takeScreenshot;
  const runChat = dependencies.runClaudeChat || runClaudeChat;
  let screenshotPath;

  try {
    screenshotPath = capture(root);
  } catch (error) {
    const result = `截图失败，无法查看当前屏幕：${oneLine(error.message || String(error))}`;
    return { result, notification: result, screenshotFailed: true };
  }

  const prompt = buildPrompt({
    ...task,
    prompt: `[已为你截取当前屏幕，图片路径：${screenshotPath}]\n\n用户请求：${task.prompt}`
  }, root);
  const result = await runChat(prompt, {
    capability: "assist",
    additionalSystemPrompt: SCREEN_SYSTEM_PROMPT,
    disableBash: true
  });
  return { result, screenshotPath };
}

function formatCanvasDate(ms) {
  if (!Number.isFinite(ms)) return "未设置";
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  }).format(new Date(ms));
}

function compactCanvasText(text, maxLength = 8000) {
  const value = String(text || "").trim();
  return value.length <= maxLength ? value : `${value.slice(0, maxLength - 3)}...`;
}

function formatCanvasSnapshot({ courses, assignments, detail, failure }) {
  if (failure) return `读取失败：${failure}`;

  const lines = [
    `活跃学术课程（${courses.length}）：`,
    ...courses.map((course) => `- ${course.code || "无课程代码"} | ${course.name}`),
    `未来 21 天作业（${assignments.length}）：`,
    ...assignments.map((assignment) => {
      const points = assignment.pointsPossible == null ? "分值未标注" : `${assignment.pointsPossible} 分`;
      return `- [${assignment.courseCode || "无课程代码"}] ${assignment.name} | 截止 ${formatCanvasDate(assignment.dueAtMs)} | ${assignment.submitted ? "已提交" : "未提交"} | ${points}`;
    })
  ];

  if (detail) {
    lines.push(
      "匹配到的作业详情：",
      `- ${detail.name} | 截止 ${formatCanvasDate(detail.dueAtMs)} | ${detail.submission.submitted ? "已提交" : "未提交"}`,
      `- 要求：${compactCanvasText(detail.description) || "Canvas 未提供文字说明"}`
    );
    if (detail.rubric.length > 0) {
      lines.push(
        "- Rubric：",
        ...detail.rubric.slice(0, 12).map((criterion) => {
          const points = criterion.pointsPossible == null ? "" : `（${criterion.pointsPossible} 分）`;
          return `  - ${criterion.description}${points}${criterion.longDescription ? `：${criterion.longDescription}` : ""}`;
        })
      );
    }
    if (detail.url) lines.push(`- 链接：${detail.url}`);
  }

  return lines.join("\n");
}

export async function runCanvasChat(task, root = projectRoot(), dependencies = {}) {
  const listCourses = dependencies.listActiveCourses || listActiveCourses;
  const listUpcoming = dependencies.listUpcomingAssignments || listUpcomingAssignments;
  const find = dependencies.findAssignments || findAssignments;
  const getDetail = dependencies.getAssignmentDetail || getAssignmentDetail;
  const runChat = dependencies.runClaudeChat || runClaudeChat;
  const send = dependencies.sendTelegramMessage || sendTelegramMessage;
  let canvasData;

  try {
    const courses = await listCourses();
    const assignments = await listUpcoming({ withinDays: 21, courses });
    const candidates = await find(task.prompt, { courses });
    const candidate = candidates[0];
    const detail = candidate
      ? await getDetail(candidate.courseId, candidate.id)
      : null;
    canvasData = formatCanvasSnapshot({ courses, assignments, detail });
  } catch (error) {
    if (error?.status === 401) {
      try {
        await sendCanvasUnauthorizedAlert({ send });
      } catch {
        // The Canvas answer still needs to explain the read failure.
      }
    }
    canvasData = formatCanvasSnapshot({
      failure: redactSensitive(oneLine(error.message || String(error)))
    });
  }

  const canvasPrompt = [
    "[Canvas 数据（实时读取）]",
    canvasData,
    "说明：以上详情已经通过 Canvas API 读取。若要求字段很短或为空，请如实说明 Canvas API 的 description 未提供更多内容；不要建议改走浏览器或 /codex。",
    "只能依据以上数据回答，禁止补充未列出的课程、作业、分值、截止日期或要求。",
    "",
    `用户问题：${task.prompt}`
  ].join("\n");
  const result = await runChat(buildPrompt({ ...task, prompt: canvasPrompt }, root), {
    capability: "assist",
    disableBash: true,
    additionalSystemPrompt: "Canvas 问答只能依据用户消息中提供的实时 API 数据；不得猜测或补充其中没有的课程、作业、日期、分值或要求。"
  });
  return { result, canvasData };
}

export function buildPrompt(task, root = projectRoot()) {
  if (task.taskType === "study-distill") {
    const learnerProfile = String(process.env.STUDY_LEARNER_PROFILE || "大学工程专业本科生").trim();
    return [
      `你是一位擅长把大学工程课程讲透的老师。用户是${learnerProfile}，下面是其没听懂的课程主题。`,
      "请生成一份 Markdown 学习文档，要求：",
      "- 简体中文讲解，专业术语保留英文原文（首次出现时标注）",
      "- 结构：# 主题 / ## 核心概念（直觉优先，先讲为什么再讲是什么） / ## 关键公式与推导（逐步，标注每步物理意义） / ## 典型例题（2-3 道，完整解题过程） / ## 常见误区 / ## 自测题（5 道，答案附文末）",
      "- 深度面向本科课程考试，不要浅尝辄止；公式用 LaTeX 记法",
      "- 直接输出 Markdown 正文，不要任何开场白或结尾客套",
      "",
      "课程主题：",
      task.prompt
    ].join("\n");
  }

  if (task.taskType === "telegram-chat") {
    return [
      "你在回答用户通过 Telegram 发来的提问或闲聊，用简体中文、简洁、口语化回答。",
      "严格限制：只回答，不要修改任何文件、不要运行有副作用或改系统的命令、不要安装/卸载软件、不要改配置或计划任务。",
      "如果用户的需求确实需要这些操作，不要执行，而是简短说明并建议用户改用 /codex 指令。",
      "",
      "用户消息：",
      task.prompt
    ].join("\n");
  }

  const computerUseTools = ["remote-maintenance", "approved-privileged"].includes(task.taskType)
    ? [
        "",
        "屏幕与输入工具：",
        "- 截图：powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\\scripts\\take-screenshot.ps1 [-OutFile <path>] [-Display <index>]；脚本输出 PNG 绝对路径，随后读取该 PNG 判断画面。",
        "- 输入：powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\\scripts\\send-input.ps1 -Action <click|move|type|key>，click/move 传 -X/-Y，type 传 -Text，key 传 -Key Enter/Tab/Escape。",
        task.taskType === "approved-privileged"
          ? "- 当前任务已经过 T2 确认；仅在任务明确要求鼠标键盘操作时调用 send-input.ps1。"
          : "- 当前任务不是已批准的 T2 输入任务，不得调用 send-input.ps1；需要鼠标键盘操作时停下并要求走确认流。"
      ]
    : [];

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
    ...computerUseTools,
    "",
    "执行要求：",
    `- 默认工作目录是 ${root}。`,
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

export async function processCodexAutoQueue({
  notify = true,
  dispatchToMac: dispatchMac = dispatchToMac,
  pickNode: selectNode = pickNode,
  nodeProbe,
  runClaudeChat: runChat = runClaudeChat,
  runCanvasChat: runCanvas = runCanvasChat,
  runScreenChat: runScreen = runScreenChat,
  runCodexExec: runCodex = runCodexExec
} = {}) {
  loadEnv();

  const pauseFile = resolveFromCwd("./data/state/assistant-paused.flag");
  if (fs.existsSync(pauseFile)) {
    console.log("[codex-auto-worker] 已暂停（assistant-paused.flag），跳过本轮任务处理。");
    return [];
  }

  const root = projectRoot();
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
        const routedPrompt = routingPrompt(task.prompt);
        const executionTask = routedPrompt.prompt === task.prompt
          ? task
          : { ...task, prompt: routedPrompt.prompt };
        const isChat = task.taskType === "telegram-chat";
        const isStudy = task.taskType === "study-distill";
        const isApprovedPrivileged = task.taskType === "approved-privileged";
        const classification = isChat || isApprovedPrivileged ? classifyTask(executionTask.prompt) : null;
        const capability = isChat || isApprovedPrivileged
          ? pickCapability({
              tier: isApprovedPrivileged && classification.tier === TIER.PRIVILEGED
                ? TIER.SANDBOX
                : classification.tier,
              guiControl: needsGuiControl(executionTask.prompt),
              needsCanvas: needsCanvas(executionTask.prompt),
              needsBrowser: needsBrowser(executionTask.prompt),
              needsScreen: needsScreen(executionTask.prompt)
            })
          : task.taskType === "remote-maintenance"
            ? "maintenance"
            : "codex";
        if (
          notify &&
          !isChat &&
          !isStudy &&
          !(isApprovedPrivileged && classification?.tier === TIER.FORBIDDEN)
        ) {
          await sendTelegramMessage(`Codex 任务已开始：${task.title}\n状态：已领取到 processing，正在启动 Codex。`);
        }
        const notifyStatusUpdates = boolEnv("CODEX_AUTO_STATUS_UPDATES", true);
        const taskStem = path.basename(claimed).replace(/\.[^.]+$/, "");
        let execution;
        if (classification?.tier === TIER.FORBIDDEN) {
          appendAudit({
            kind: isApprovedPrivileged ? "approved-privileged" : "policy",
            tier: classification.tier,
            reason: classification.reason,
            promptPreview: executionTask.prompt,
            result: "denied",
            approvalId: task.metadata?.approvalId
          });
          execution = {
            result: `这个请求涉及不可逆/高风险操作，我不会执行。原因：${classification.reason}`
          };
        } else if (isChat && capability === "confirm") {
          const approval = createApproval({
            prompt: task.prompt,
            tier: classification.tier,
            reason: classification.reason
          });
          const ttlMinutes = Math.ceil((approval.expiresAtMs - approval.createdAtMs) / 60000);
          const promptPreview = redactSensitive(oneLine(executionTask.prompt)).slice(0, 120);
          appendAudit({
            kind: "approval",
            tier: classification.tier,
            reason: classification.reason,
            promptPreview: executionTask.prompt,
            result: "pending",
            approvalId: approval.id
          });
          execution = {
            result: `等待用户确认 ${approval.id}`,
            notification: [
              "⚠️ 这个任务需要特权操作，需要你确认。",
              `原因：${classification.reason}`,
              `任务：${promptPreview}`,
              `批准回复：/ok ${approval.id}`,
              `拒绝回复：/no ${approval.id}`,
              `（${ttlMinutes} 分钟内有效）`
            ].join("\n")
          };
        } else if (isStudy) {
          execution = { result: await runClaudeText(buildPrompt(task, root), { timeoutMs: 600000 }) };
        } else {
          const nodeCapability = nodeCapabilityFor(executionTask, capability);
          const selection = routedPrompt.forcedNodeId
            ? { nodeId: routedPrompt.forcedNodeId, reason: "/mac 调试强制指定" }
            : await selectNode(nodeCapability, nodeProbe ? { probe: nodeProbe } : {});

          if (!selection.nodeId) {
            execution = {
              result: unavailableNodeMessage(nodeCapability, selection.reason)
            };
            if (classification) {
              appendAudit({
                kind: nodeCapability,
                tier: classification.tier,
                reason: selection.reason,
                promptPreview: executionTask.prompt,
                result: "node-unavailable",
                approvalId: task.metadata?.approvalId
              });
            }
          } else if (selection.nodeId === "mac" && selection.brainNodeId !== "mac") {
            const macResult = await dispatchMac({
              prompt: executionTask.prompt,
              kind: capability === "gui-control" && isApprovedPrivileged
                ? "mac-computer-use"
                : "mac-general"
            });
            if (!macResult.ok) {
              throw new Error(`Mac 卫星执行失败：${macResult.error || "未提供失败原因"}`);
            }
            execution = { result: macResult.result || "任务已完成。" };
            if (classification) {
              appendAudit({
                kind: capability,
                tier: classification.tier,
                reason: classification.reason,
                promptPreview: executionTask.prompt,
                result: "executed",
                approvalId: task.metadata?.approvalId
              });
            }
          } else if (isChat && capability === "canvas") {
            execution = await runCanvas(executionTask, root);
            appendAudit({
              kind: "canvas",
              tier: classification.tier,
              reason: classification.reason,
              promptPreview: executionTask.prompt,
              result: "executed"
            });
          } else if (isChat && capability === "screen") {
            execution = await runScreen(executionTask, root);
            appendAudit({
              kind: "screen",
              tier: classification.tier,
              reason: classification.reason,
              promptPreview: executionTask.prompt,
              result: execution.screenshotFailed ? "screenshot-failed" : "executed"
            });
          } else if (isChat) {
            execution = { result: await runChat(buildPrompt(executionTask, root), { capability }) };
            appendAudit({
              kind: capability,
              tier: classification.tier,
              reason: classification.reason,
              promptPreview: executionTask.prompt,
              result: "executed"
            });
          } else {
            execution = await runCodex({
              root,
              prompt: buildPrompt(executionTask, root),
              taskStem,
              onProgress: async ({ elapsedSeconds, jsonLogFile }) => {
                if (notify && notifyStatusUpdates && !isChat && !isStudy) {
                  await sendTelegramMessage(buildProgressMessage({ task, elapsedSeconds, jsonLogFile }));
                }
              }
            });
            if (isApprovedPrivileged) {
              appendAudit({
                kind: "approved-privileged",
                tier: classification.tier,
                reason: classification.reason,
                promptPreview: executionTask.prompt,
                result: "executed",
                approvalId: task.metadata?.approvalId
              });
            }
          }
        }
        const outFile = writeResult({ inboxPath, taskFile: claimed, task, result: execution.result });
        results.push({ ok: true, task, outFile, log: execution.jsonLogFile });
        if (notify && isStudy) {
          const studyDir = path.join(root, "data", "study");
          fs.mkdirSync(studyDir, { recursive: true });
          const studyFile = path.join(studyDir, `study-${timestampForFile()}.md`);
          fs.writeFileSync(studyFile, execution.result, "utf8");
          for (let offset = 0; offset < execution.result.length; offset += 3500) {
            await sendTelegramMessage(execution.result.slice(offset, offset + 3500));
          }
          await sendTelegramDocument(studyFile, `📚 学习文档：${task.title}`);
        } else if (notify && isChat) {
          await sendTelegramMessage(execution.notification || execution.result);
        } else if (notify) {
          await sendTelegramMessage(`Codex 自动任务完成：${task.title}\n\n${execution.result}`);
        }
      } catch (error) {
        const outFile = writeFailure({ inboxPath, taskFile: claimed, task, error });
        results.push({ ok: false, task, outFile, error });
        if (notify && task?.taskType === "study-distill") {
          await sendTelegramMessage(`蒸馏失败：${error.message || String(error)}`);
        } else if (notify && task?.taskType === "telegram-chat") {
          await sendTelegramMessage(`回答失败：${error.message || String(error)}`);
        } else if (notify) {
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
