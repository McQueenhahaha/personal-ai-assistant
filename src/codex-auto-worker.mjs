import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { loadEnv, projectRoot, resolveFromCwd, timestampForFile } from "./env.mjs";
import { runClaudeChat, runClaudeText, SCREEN_SYSTEM_PROMPT } from "./brain/claude.mjs";
import { resolveNodeId } from "./brain/supervisor.mjs";
import {
  findAssignments,
  getAssignmentDetail,
  listActiveCourses,
  listUpcomingAssignments
} from "./canvas/api.mjs";
import { sendCanvasUnauthorizedAlert } from "./canvas/token-alert.mjs";
import { dispatchToNode as dispatchToNodeDefault } from "./satellite/dispatch.mjs";
import { dispatchToMac } from "./satellite/mac.mjs";
import { pickNode, resolveBrainNodeId } from "./satellite/registry.mjs";
import { appendAudit } from "./security/audit.mjs";
import { createApproval, loadApprovals } from "./security/pending.mjs";
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
import { isPaused, isStopRequested } from "./state/pause.mjs";
import { clearCancelRequest, isCancelRequestedFor } from "./state/cancel.mjs";
import { clearInFlight, describeInterrupted, readInFlight, writeInFlight } from "./state/in-flight.mjs";
import {
  claimTask,
  decideOrphanAction,
  ensureQueue,
  listPendingTasks,
  listProcessingTasks,
  readTask,
  requeueTask,
  writeFailure,
  writeResult
} from "./queue.mjs";
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

export function decideLockState({ lockContent, lockMtimeMs, nowMs, staleMs, isPidAlive }) {
  let lock;
  try {
    lock = JSON.parse(lockContent);
  } catch {
    lock = null;
  }

  const pid = lock?.pid;
  const stale = nowMs - lockMtimeMs >= staleMs;
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    return stale
      ? { action: "proceed", reason: "unparsable-fallback-proceed" }
      : { action: "wait", reason: "unparsable-fallback-wait" };
  }
  if (stale) return { action: "proceed", reason: "stale-mtime" };

  let holderAlive = false;
  try {
    holderAlive = Boolean(isPidAlive(pid));
  } catch {
    // If the holder cannot be confirmed as this worker, prefer clearing the lock.
  }
  return holderAlive
    ? { action: "wait", reason: "holder-alive" }
    : { action: "proceed", reason: "holder-dead" };
}

export function isWorkerPidAlive(pid, spawnSyncImpl = spawnSync) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  const command = [
    `$process = Get-CimInstance Win32_Process -Filter "ProcessId = ${pid}" -ErrorAction SilentlyContinue`,
    "if ($null -ne $process) { [Console]::Out.Write([string]$process.CommandLine) }"
  ].join("\n");
  const result = spawnSyncImpl(
    "powershell.exe",
    ["-NoProfile", "-Command", command],
    { encoding: "utf8", shell: false, windowsHide: true }
  );
  return !result?.error && result?.status === 0 && /codex-auto-worker\.mjs/i.test(String(result.stdout || ""));
}

// 急停检测间隔。进度回调默认 60 秒，用它来检测急停的话用户要等一分钟 —— 那不叫急停。
const STOP_POLL_MS = 2000;

// 杀整棵进程树。
// 不能用 child.kill()：本仓审计已确认它只终止直接子进程，
// codex 派生的孙进程(DISM/SFC 之类)会继续跑下去。
export function killProcessTree(pid, spawnSyncImpl = spawnSync) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  const result = spawnSyncImpl(
    "taskkill.exe",
    ["/PID", String(pid), "/T", "/F"],
    { encoding: "utf8", shell: false, windowsHide: true }
  );
  return !result?.error;
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
  const labels = {
    browser: "浏览器",
    canvas: "Canvas",
    codex: "Codex",
    "gui-control": "图形界面操控",
    maintenance: "系统维护",
    outlook: "Outlook",
    screen: "屏幕查看"
  };
  const detail = reason || "目标机器不可达或没有声明这项能力。";
  const remoteWindowsOffline = /Windows.*(?:不可达|离线)/.test(detail);
  return [
    `这个任务需要${labels[capability] || capability}能力，但当前没有可用节点。`,
    remoteWindowsOffline ? "这个功能需要另一台电脑，它当前离线。" : "",
    detail,
    /[。！？.!?]$/.test(detail) ? "" : "。",
    "请确认对应机器已开机、Tailscale 与受限 SSH 代理在线，并检查该节点的 SSH 主机和密钥环境变量。"
  ].join("");
}

function remoteTaskKind(nodeId, capability, nodeCapability, isApprovedPrivileged) {
  if (nodeId === "mac") {
    return capability === "gui-control" && isApprovedPrivileged
      ? "mac-computer-use"
      : "mac-general";
  }
  if (capability === "browse") return "browse";
  return nodeCapability;
}

/**
 * 回执开头的来源标签：`[Windows · codex]`。
 *
 * 没有它的时候，两台机器给出的回答长得一模一样 —— 出问题时你无从判断该去
 * 哪台机器看日志。今天排查那个孤儿桥就吃过这个亏：回你消息的一直是 Mac
 * 上的桥，而从消息本身完全看不出来。
 *
 * 刻意不做：不加配置开关、不做富格式、不动 /codex 与 /study 那两条通知
 *（它们的标题里已经带了任务名）。
 */
export function sourceLabel(nodeId, capability) {
  const machine = nodeId === "mac" ? "Mac" : nodeId === "windows" ? "Windows" : String(nodeId || "本机");
  return `[${machine} · ${capability || "codex"}]`;
}

function remoteFailureMessage(nodeId, capability, error, detail) {
  const label = nodeId === "windows" ? "Windows" : nodeId === "mac" ? "Mac" : nodeId;
  const reason = [error, detail].filter(Boolean).join("：") || "未提供失败原因";
  return `${label} 节点已被选中，但 ${capability} 任务派发失败（${reason}）。请确认该机器在线、受限代理可用且已开放对应 kind；不会在缺少能力的本机静默降级。`;
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
    ["npm run check", "检查 AI 助手项目脚本语法"]
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

export function createRedactingLogWriter(file) {
  const stream = fs.createWriteStream(file, { flags: "a", encoding: "utf8" });

  // 没有这个监听器的话，写日志失败会以 unhandled 'error' 直接打死整个 worker 进程：
  // 你收到的是「任务被中断（进程终止）」，codex 改了一半的文件留在那儿，
  // 而它那个 danger-full-access 子进程没人 kill，成了孤儿继续在仓库里写。
  //
  // 只记不抛，也不重试、不换路径 —— 日志坏了不该影响任务成败，
  // 这是本仓已有的原则（tryNotify 也是这么处理通知失败的）。
  stream.on("error", (error) => {
    console.error(`[codex-auto-worker] 任务日志写入失败，本次日志不完整：${error.message || String(error)}`);
  });

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

function recordNotificationFailure({ task, outFile, failure, appendAuditImpl, logError }) {
  const taskId = redactSensitive(oneLine(task?.id || "unknown"));
  const reason = redactSensitive(oneLine(failure.error?.message || String(failure.error)));
  const resultFile = path.resolve(outFile);
  const details = `taskId=${taskId}; phase=${failure.phase}; reason=${reason}; resultFile=${resultFile}`;

  try {
    appendAuditImpl({
      kind: "telegram-notification",
      reason: details,
      result: "failed"
    });
  } catch (error) {
    try {
      logError(`[codex-auto-worker] 通知失败审计写入失败：${error.message || String(error)}`);
    } catch {
      // Notification diagnostics must not fail the completed task.
    }
  }

  try {
    logError(`[codex-auto-worker] Telegram 通知失败：${details}`);
  } catch {
    // Notification diagnostics must not fail the completed task.
  }
}

export async function recoverOrphanedTasks({
  inboxPath,
  notify = true,
  appendAudit: appendAuditImpl = appendAudit,
  sendTelegramMessage: sendMessage = sendTelegramMessage,
  logError = console.error
} = {}) {
  const recovered = [];
  for (const item of listProcessingTasks(inboxPath)) {
    let task;
    try {
      task = readTask(item.file);
    } catch (error) {
      task = {
        id: item.name,
        title: item.name,
        taskType: null,
        prompt: ""
      };
      logError(`[codex-auto-worker] 读取孤儿任务失败，将按高风险任务处理：${item.file}；${error.message || String(error)}`);
    }

    const decision = decideOrphanAction(task);
    let destination;
    if (decision.action === "requeue") {
      destination = requeueTask(item.file, inboxPath);
    } else {
      destination = writeFailure({
        inboxPath,
        taskFile: item.file,
        task,
        error: new Error("任务被中断（进程终止），未完成")
      });
    }

    appendAuditImpl({
      kind: "orphan-recovery",
      reason: `taskId=${task.id}; ${decision.reason}`,
      promptPreview: task.prompt,
      result: decision.action === "requeue" ? "requeued" : "failed"
    });

    if (notify) {
      const message = decision.action === "requeue"
        ? `检测到任务被中断（进程终止），已重新排队：${task.title}`
        : `检测到任务被中断（进程终止），为避免重复执行已标记失败：${task.title}`;
      try {
        await sendMessage(message);
      } catch (error) {
        logError(`[codex-auto-worker] 孤儿任务恢复通知失败：taskId=${task.id}；${error.message || String(error)}`);
      }
    }

    recovered.push({ task, ...decision, destination });
  }
  return recovered;
}

function runCodexExec({ root, prompt, taskStem, onProgress, cancelId = "" }) {
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
      // 用整棵树而不是 child.kill()：后者会留下 codex 派生的孙进程继续跑。
      killProcessTree(child.pid);
      reject(new Error(`Codex exec timed out after ${timeoutMs / 1000}s`));
    }, timeoutMs);

    // 急停轮询。间隔要远小于进度回调(默认 60s) —— 用户按下急停后
    // 还要等一分钟才停下，那不叫急停。
    // 同一个轮询里顺带看"取消当前这一个"。两者的差别只在善后：
    // 急停会让助手一直停着(level=stop)，取消只掐这一个、循环继续领下一个。
    const abortTimer = setInterval(() => {
      if (isStopRequested(root)) {
        clearInterval(abortTimer);
        killProcessTree(child.pid);
        const error = new Error("用户急停：已终止正在执行的任务");
        error.abortedByStop = true;
        reject(error);
        return;
      }
      if (cancelId && isCancelRequestedFor(cancelId, root)) {
        clearInterval(abortTimer);
        killProcessTree(child.pid);
        // 立刻消费掉，免得这条请求残留下来把下一个任务也掐了。
        clearCancelRequest(root);
        const error = new Error("用户取消：已终止该任务，助手继续运行");
        error.cancelledByUser = true;
        reject(error);
      }
    }, STOP_POLL_MS);

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
      clearInterval(abortTimer);
      logStream.end();
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      clearInterval(progressTimer);
      clearInterval(abortTimer);
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
  appendAudit: appendAuditImpl = appendAudit,
  dispatchToNode: dispatchNode,
  dispatchToMac: dispatchMac = dispatchToMac,
  pickNode: selectNode = pickNode,
  nodeProbe,
  runClaudeChat: runChat = runClaudeChat,
  runClaudeText: runText = runClaudeText,
  runCanvasChat: runCanvas = runCanvasChat,
  runScreenChat: runScreen = runScreenChat,
  runCodexExec: runCodex = runCodexExec,
  sendTelegramDocument: sendDocument = sendTelegramDocument,
  sendTelegramMessage: sendMessage = sendTelegramMessage,
  isPidAlive: checkPidAlive = isWorkerPidAlive,
  log = console.log,
  logError = console.error
} = {}) {
  loadEnv();

  const pauseRoot = projectRoot();
  if (isPaused(pauseRoot)) {
    console.log("[codex-auto-worker] 已暂停，跳过本轮任务处理。");
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
    const lockContent = fs.readFileSync(lockFile, "utf8");
    const decision = decideLockState({
      lockContent,
      lockMtimeMs: stat.mtimeMs,
      nowMs: Date.now(),
      staleMs,
      isPidAlive: checkPidAlive
    });
    if (decision.action === "wait") {
      log(`Codex auto worker lock exists: ${lockFile} (${decision.reason})`);
      return [];
    }
    if (decision.reason === "holder-dead") {
      const holderPid = JSON.parse(lockContent).pid;
      log(`[codex-auto-worker] 清理已终止 worker 的残留锁：pid=${holderPid}；${lockFile}`);
    }
    fs.rmSync(lockFile, { force: true });
  }

  fs.writeFileSync(lockFile, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }, null, 2), "utf8");

  const results = [];

  try {
    try {
      await recoverOrphanedTasks({
        inboxPath,
        notify,
        appendAudit: appendAuditImpl,
        sendTelegramMessage: sendMessage,
        logError
      });
    } catch (error) {
      logError(`[codex-auto-worker] 孤儿任务恢复扫描失败，继续处理正常队列：${error.message || String(error)}`);
    }

    // 凤凰计划：上一台大脑若死在半路，这里把它正在做的事报给用户。
    // 上面的孤儿扫描只看得见**本机** processing/ 里的文件；而队列不在灵魂包里，
    // 死在另一台机器上的任务本机根本看不到 —— 只有这条跨机记录能说出
    // "什么被中断了"。它把静默丢失变成可见事件，这正是它存在的全部理由。
    // 注意：拿不回中间产物（codex 写了一半的代码是丢了），但用户至少知道发生过什么。
    try {
      const interrupted = describeInterrupted({
        record: readInFlight(root),
        selfId: resolveNodeId(),
        nowMs: Date.now()
      });
      if (interrupted) {
        appendAuditImpl({
          kind: "brain-handover",
          tier: TIER.SAFE,
          reason: `interrupted-on-${interrupted.fromNode}`,
          promptPreview: interrupted.taskId,
          result: "reported"
        });
        if (notify) {
          try {
            await sendMessage(`${interrupted.text}\n\n它的中间结果无法恢复。需要的话请重新发一次。`);
          } catch (notifyError) {
            // 通知失败不阻断后续队列处理 —— 本仓既有原则：任务状态不由通知成败决定。
            logError(`[codex-auto-worker] 中断上报通知失败：${notifyError.message || String(notifyError)}`);
          }
        }
        // 报告过就清掉，否则每轮都会重复提醒。
        clearInFlight(root);
      }
    } catch (error) {
      logError(`[codex-auto-worker] 跨机中断任务上报失败：${error.message || String(error)}`);
    }

    const pending = listPendingTasks(inboxPath).slice(0, maxTasks);
    for (const item of pending) {
      const claimed = claimTask(item, inboxPath);
      let task;
      let inFlightId = "";
      const notificationFailures = [];
      let completionNotificationFailed = false;
      const tryNotify = async (phase, action, { completion = false } = {}) => {
        try {
          await action();
        } catch (error) {
          notificationFailures.push({ phase, error });
          if (completion) completionNotificationFailed = true;
        }
      };
      try {
        task = readTask(claimed);

        // 「已批准」这三个字原先是任务文件自己写的，没有任何一处核对过：
        // worker 只看 taskType === "approved-privileged" 就把 T2 降成 T1，
        // 而 approvalId 从头到尾只被塞进审计日志、从不回查。于是任何能往
        // data/queues/codex/inbox/ 写一个 JSON 的东西，只要写上这个 taskType，
        // 就拿到了「你已经在 Telegram 上按过 /ok」的待遇 —— 直接进
        // danger-full-access 的 Codex 执行，而你的手机不会响。
        // 而 /codex 任务本身就是 danger-full-access 跑在项目根目录，
        // 它完全写得进那个 inbox：一次跑偏的 codex 任务能给自己签发通行证。
        //
        // fail-closed：查不到有效审批就拒绝。抛出去正好落进已有的 catch ——
        // 写 .error.txt、进 failed/、发一条失败通知，失败即拒绝。
        if (task.taskType === "approved-privileged") {
          const approvalId = String(task.metadata?.approvalId || "");
          if (loadApprovals()[approvalId]?.status !== "approved") {
            throw new Error("approved-privileged 任务没有有效的审批记录，拒绝执行");
          }
        }

        // 记下"正在做什么"。该记录在灵魂包里，所以对端看得见 ——
        // 本机若死在半路，接管方能据此告诉用户什么被中断了，
        // 而不是让用户停在"任务已开始"之后再无下文。
        // 这个 id 同时用于两处：告诉对端"正在做什么"，以及 /cancel 点名取消。
        // 两边必须是同一个值，否则用户在 Telegram 看到的任务和能取消的任务对不上。
        inFlightId = task.id || path.basename(claimed);
        writeInFlight({
          taskId: inFlightId,
          title: task.title || "",
          taskType: task.taskType || "",
          nodeId: resolveNodeId(),
          startedAt: new Date().toISOString()
        }, root);
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
          await tryNotify("task-start", () => sendMessage(
            `Codex 任务已开始：${task.title}\n状态：已领取到 processing，正在启动 Codex。`
          ));
        }
        const notifyStatusUpdates = boolEnv("CODEX_AUTO_STATUS_UPDATES", true);
        const taskStem = path.basename(claimed).replace(/\.[^.]+$/, "");
        // 回执里要看得出这条是哪台机器跑的。默认是本机；派发出去时改成目标节点。
        // 没有这个信息的时候，两台机器给的回答长得一模一样 —— 出问题时你无从
        // 判断该去哪台机器看日志，今天排查孤儿桥就吃过这个亏。
        let ranOnNodeId = resolveNodeId();
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
          execution = { result: await runText(buildPrompt(task, root), { timeoutMs: 600000 }) };
        } else {
          const nodeCapability = nodeCapabilityFor(executionTask, capability);
          const selection = routedPrompt.forcedNodeId
            ? { nodeId: routedPrompt.forcedNodeId, reason: "/mac 调试强制指定" }
            : await selectNode(nodeCapability, nodeProbe ? { probe: nodeProbe } : {});
          const selfId = selection.brainNodeId || resolveBrainNodeId();

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
          } else if (selection.nodeId !== selfId) {
            const remoteTask = {
              prompt: executionTask.prompt,
              kind: remoteTaskKind(selection.nodeId, capability, nodeCapability, isApprovedPrivileged),
              capability: nodeCapability
            };
            let remoteResult;
            try {
              remoteResult = dispatchNode
                ? await dispatchNode(selection.nodeId, remoteTask)
                : selection.nodeId === "mac"
                  ? await dispatchMac({
                      prompt: remoteTask.prompt,
                      kind: remoteTask.kind
                    })
                  : await dispatchToNodeDefault(selection.nodeId, remoteTask);
            } catch (error) {
              remoteResult = {
                ok: false,
                error: "unreachable",
                detail: oneLine(error.message || String(error))
              };
            }

            if (remoteResult.ok) ranOnNodeId = selection.nodeId;
            execution = remoteResult.ok
              ? { result: remoteResult.result || "任务已完成。" }
              : {
                  result: remoteFailureMessage(
                    selection.nodeId,
                    nodeCapability,
                    remoteResult.error,
                    remoteResult.detail
                  )
                };
            if (classification) {
              appendAudit({
                kind: capability,
                tier: classification.tier,
                reason: remoteResult.ok ? classification.reason : execution.result,
                promptPreview: executionTask.prompt,
                result: remoteResult.ok ? "executed" : "node-unavailable",
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
              cancelId: inFlightId,
              onProgress: async ({ elapsedSeconds, jsonLogFile }) => {
                if (notify && notifyStatusUpdates && !isChat && !isStudy) {
                  await tryNotify("task-progress", () => sendMessage(
                    buildProgressMessage({ task, elapsedSeconds, jsonLogFile })
                  ));
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
        if (notify && isStudy) {
          const studyDir = path.join(root, "data", "study");
          fs.mkdirSync(studyDir, { recursive: true });
          const studyFile = path.join(studyDir, `study-${timestampForFile()}.md`);
          fs.writeFileSync(studyFile, execution.result, "utf8");
          for (let offset = 0; offset < execution.result.length; offset += 3500) {
            const chunkNumber = Math.floor(offset / 3500) + 1;
            await tryNotify(
              `study-chunk-${chunkNumber}`,
              () => sendMessage(execution.result.slice(offset, offset + 3500)),
              { completion: true }
            );
          }
          await tryNotify(
            "study-document",
            () => sendDocument(studyFile, `📚 学习文档：${task.title}`),
            { completion: true }
          );
        } else if (notify && isChat) {
          await tryNotify(
            "chat-result",
            () => sendMessage(
              `${sourceLabel(ranOnNodeId, capability)}\n${execution.notification || execution.result}`
            ),
            { completion: true }
          );
        } else if (notify) {
          await tryNotify(
            "task-result",
            () => sendMessage(`Codex 自动任务完成：${task.title}\n\n${execution.result}`),
            { completion: true }
          );
        }
        if (completionNotificationFailed) {
          await tryNotify("result-recovery", () => sendMessage(
            `结果已生成但推送失败，文件在 ${outFile}`
          ));
        }
        for (const failure of notificationFailures) {
          recordNotificationFailure({
            task,
            outFile,
            failure,
            appendAuditImpl,
            logError
          });
        }
        results.push({ ok: true, task, outFile, log: execution.jsonLogFile });
      } catch (error) {
        const outFile = writeFailure({ inboxPath, taskFile: claimed, task, error });
        if (notify && task?.taskType === "study-distill") {
          await tryNotify("study-failure", () => sendMessage(`蒸馏失败：${error.message || String(error)}`));
        } else if (notify && task?.taskType === "telegram-chat") {
          await tryNotify("chat-failure", () => sendMessage(`回答失败：${error.message || String(error)}`));
        } else if (notify) {
          await tryNotify("task-failure", () => sendMessage(
            `Codex 自动任务失败：${task?.title || item.name}\n\n${error.message || String(error)}`
          ));
        }
        for (const failure of notificationFailures) {
          recordNotificationFailure({
            task,
            outFile,
            failure,
            appendAuditImpl,
            logError
          });
        }
        results.push({ ok: false, task, outFile, error });
      } finally {
        // 无论成败都要清 —— 留着会让接管方误报"有任务被中断"。
        // 用内容置空而非删文件：该文件在灵魂包里，而同步只搬运存在的文件、
        // 删除不传播，删了对端会永远以为还有任务在飞。
        try {
          clearInFlight(root);
        } catch {
          // 清理失败不能影响任务结果本身。
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
    // 空转不出声。循环脚本每 20 秒起一次这个 CLI，无条件打印的话日志里
    // 99.96% 是同一句 "processed 0 task(s)."（实测 69164 行里 69138 行），
    // 排障时真事件被淹没，而且文件被每 20 秒 touch 一次，
    // data\logs 的 7 天清理永远够不着它 —— 一直长下去。
    //
    // 源头噤声比加轮转好：安静之后那份清理规则自然开始管它，不用新机制。
    if (results.length > 0) {
      console.log(`Codex auto worker processed ${results.length} task(s).`);
    }
  }).catch((error) => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  });
}
