import fs from "node:fs";
import path from "node:path";
import { isLeaseFresh, isLeaseValid } from "../brain/lease.mjs";
import { resolveFromCwd } from "../env.mjs";
import { sendTelegramMessage } from "../telegram.mjs";

// 进程在不在、心跳新不新，只能说明桥活着，说明不了它在干活：双节点脑裂时
// 桥照样活着、心跳照写（独立定时器），只是每次 getUpdates 都被 409 踢掉，
// 消息被另一台吞走。2026-10-03 就这样静默了一整天。所以再看桥自己的 JSONL 日志。
const BRIDGE_LOG_FILE = "./data/logs/openclaw-telegram-bridge.jsonl";
const HEALTH_STATE_FILE = "./data/state/bridge-health.json";
const START_MESSAGE = "OpenClaw Telegram bridge started.";
const TAIL_BYTES = 1024 * 1024;

const CONFLICT_WINDOW_MS = 15 * 60_000;
// 重启交接时旧的长轮询还挂着，偶发一两次 409 是正常的；真脑裂是每几秒一次。
const CONFLICT_THRESHOLD = 5;
const FLAP_WINDOW_MS = 60 * 60_000;
// 游戏模式起停、手动重启一小时内一两次很常见；10-03 那次是每小时 50+ 次。
const FLAP_THRESHOLD = 4;
const LAST_ERROR_MAX_CHARS = 200;

function compactError(msg) {
  const text = String(msg)
    .split("\n")
    .filter((line) => !/^\s+at /.test(line))
    .join(" ")
    .trim();
  return text.length > LAST_ERROR_MAX_CHARS ? `${text.slice(0, LAST_ERROR_MAX_CHARS)}…` : text;
}

export function summarizeBridgeLog(lines, nowMs) {
  const summary = { conflicts: 0, starts: 0, lastError: null };
  for (const line of lines) {
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    const ageMs = nowMs - Date.parse(record?.at);
    if (!(ageMs >= 0 && ageMs <= FLAP_WINDOW_MS)) continue;

    if (record.msg === START_MESSAGE) summary.starts += 1;
    if (record.level === "error") {
      summary.lastError = compactError(record.msg);
      if (ageMs <= CONFLICT_WINDOW_MS && /\b409\b/.test(record.msg)) summary.conflicts += 1;
    }
  }
  return summary;
}

function readTail(file) {
  const fd = fs.openSync(file, "r");
  try {
    const { size } = fs.fstatSync(fd);
    const start = Math.max(0, size - TAIL_BYTES);
    const buffer = Buffer.alloc(size - start);
    fs.readSync(fd, buffer, 0, buffer.length, start);
    // 截断处的半行解析失败，会在 summarizeBridgeLog 里被跳过。
    return buffer.toString("utf8");
  } finally {
    fs.closeSync(fd);
  }
}

export function defaultBridgeLogFile() {
  return resolveFromCwd(BRIDGE_LOG_FILE);
}

// 还没有 JSONL 日志（旧版桥、Mac 侧、尚未启动过）时返回 null：无从判断。
export function readBridgeLogSummary(file, nowMs) {
  let text;
  try {
    text = readTail(file);
  } catch {
    return null;
  }
  return summarizeBridgeLog(text.split("\n"), nowMs);
}

export function decideBridgeHealth({ conflicts, starts, lastError }) {
  if (conflicts >= CONFLICT_THRESHOLD) {
    return {
      health: "conflict",
      text: `⚠️ 助手桥近 15 分钟收到 ${conflicts} 次 Telegram 409 冲突：另一个实例在用同一个 bot 拉消息，`
        + "疑似双节点脑裂，消息可能被另一台吞掉。先查 Mac 的 Tailscale 是否在线。"
    };
  }
  if (starts >= FLAP_THRESHOLD) {
    return {
      health: "flapping",
      text: `⚠️ 助手桥 1 小时内启动了 ${starts} 次，在反复退出重启。`
        + (lastError ? `最近错误：${lastError}` : "日志里没有错误记录，可能是被外部终止。")
    };
  }
  return { health: "healthy" };
}

export function nextHealthAlert(previousHealth, decision) {
  if (decision.health === previousHealth) return null;
  if (decision.health !== "healthy") return decision.text;
  if (previousHealth === "conflict") return "✅ 409 冲突已消失，助手桥恢复正常。";
  if (previousHealth === "flapping") return "✅ 助手桥已恢复稳定，过去 1 小时没有反复重启。";
  return null;
}

const NODE_LABELS = { windows: "Windows", mac: "Mac" };

// /status 的健康区块：10-03 那次桥一天重启上千次，/status 却一个字都不提。
export function formatHealthLines({ lease, nowMs, bridgeLog, codeVersion, peerVersion }) {
  const lines = [];
  if (isLeaseValid(lease)) {
    const holder = NODE_LABELS[lease.holder] || lease.holder;
    const ageSeconds = Math.round((nowMs - Date.parse(lease.heartbeatAt)) / 1000);
    lines.push(isLeaseFresh(lease, nowMs)
      ? `大脑：${holder}（租约心跳 ${ageSeconds} 秒前）`
      : `大脑：${holder}（⚠️ 租约已过期 ${Math.round(ageSeconds / 60)} 分钟）`);
  } else {
    lines.push("大脑：⚠️ 没有有效租约");
  }
  if (bridgeLog) {
    const decision = decideBridgeHealth(bridgeLog);
    lines.push(decision.health === "healthy"
      ? `桥：正常（近 1 小时启动 ${bridgeLog.starts} 次）`
      : `桥：${decision.text}`);
    lines.push(`最近错误：${bridgeLog.lastError ?? "近 1 小时无"}`);
  }
  lines.push(`代码版本：${codeVersion ?? "未知"}`);
  // 由 Windows 看门狗比对后落盘（peer-version.json）；Mac 上没有这个文件就不显示。
  if (peerVersion) {
    lines.push(`Mac 代码版本：${peerVersion.mac ?? "未知（旧部署）"}`
      + (peerVersion.match ? "（与 Windows 一致）" : "⚠️ 与 Windows 不一致，需运行 deploy-mac-brain.ps1"));
  }
  return lines;
}

function readPreviousHealth(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")).health ?? null;
  } catch {
    return null;
  }
}

// 只看事件次数、按「状态转移」告警：一次故障发一条，恢复再发一条。去重状态放在
// 独立文件里；写进看门狗日志的记录刻意不带 state 字段 —— readLastLoggedState
// 会把任何 state 当成桥的状态，进而重置现有重启告警的去重。
export async function checkBridgeHealth({ nowMs }, dependencies = {}) {
  const logFile = dependencies.bridgeLogFile || defaultBridgeLogFile();
  const stateFile = dependencies.healthStateFile || resolveFromCwd(HEALTH_STATE_FILE);
  const send = dependencies.sendTelegramMessage || sendTelegramMessage;
  const appendLog = dependencies.appendLog;

  const summary = readBridgeLogSummary(logFile, nowMs);
  if (!summary) return { checked: false };
  const decision = decideBridgeHealth(summary);
  const previous = readPreviousHealth(stateFile);
  const alert = nextHealthAlert(previous, decision);

  if (alert) {
    const details = { health: decision.health, conflicts: summary.conflicts, starts: summary.starts };
    try {
      const result = await send(alert);
      if (!result?.sent) throw new Error(result?.reason || "Telegram alert was not sent");
      appendLog?.({ event: "health-alert-sent", ...details });
    } catch (error) {
      appendLog?.({ event: "health-alert-failed", ...details, error: error?.message || String(error) });
      // 不落盘新状态：下一轮还会再试。
      return { checked: true, health: decision.health, alerted: false };
    }
  }

  if (previous !== decision.health) {
    fs.mkdirSync(path.dirname(stateFile), { recursive: true });
    fs.writeFileSync(stateFile, `${JSON.stringify({ health: decision.health, atMs: nowMs })}\n`, "utf8");
  }
  return { checked: true, health: decision.health, alerted: Boolean(alert) };
}
