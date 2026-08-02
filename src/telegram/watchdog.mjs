import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { loadEnv, resolveFromCwd } from "../env.mjs";
import { sendTelegramMessage } from "../telegram.mjs";

export const DEFAULT_STALE_MS = 900_000;

const HEARTBEAT_FILE = "./data/state/telegram-direct-heartbeat.json";
const LOG_FILE = "./data/logs/bridge-watchdog.log";
const LOG_MAX_BYTES = 1024 * 1024;
const RESTART_SCRIPT = "./scripts/start-openclaw-telegram-bridge-hidden.ps1";
const STOP_SETTLE_DELAY_MS = 1000;
const RESTART_VERIFY_DELAY_MS = 5000;

export function decideBridgeAction({
  heartbeatAtMs,
  nowMs,
  processAlive,
  staleMs = DEFAULT_STALE_MS
}) {
  if (processAlive === false) {
    return { restart: true, reason: "process-missing" };
  }

  if (!Number.isFinite(heartbeatAtMs)) {
    return { restart: false, reason: "no-heartbeat-yet" };
  }

  if (nowMs - heartbeatAtMs > staleMs) {
    return { restart: true, reason: "heartbeat-stale" };
  }

  return { restart: false, reason: "healthy" };
}

export function readHeartbeat(file) {
  try {
    const heartbeat = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!Number.isFinite(heartbeat?.atMs)) return null;
    return { atMs: heartbeat.atMs };
  } catch {
    return null;
  }
}

export function getBridgePids() {
  if (process.platform !== "win32") return null;

  const command = [
    "$ErrorActionPreference = 'Stop'",
    "$items = @(Get-CimInstance Win32_Process -Filter \"Name = 'node.exe'\" | Where-Object { $_.CommandLine -and $_.CommandLine -like '*openclaw-telegram-bridge*' })",
    "$items | ForEach-Object { Write-Output $_.ProcessId }"
  ].join("; ");
  const result = spawnSync("powershell.exe", ["-NoProfile", "-Command", command], {
    encoding: "utf8",
    timeout: 10_000,
    windowsHide: true
  });

  if (result.error || result.status !== 0) {
    const detail = result.error?.message || result.stderr.trim() || `exit ${result.status}`;
    throw new Error(`Bridge process check failed: ${detail}`);
  }

  const output = result.stdout.trim();
  if (!output) return [];

  const pids = output.split(/\s+/).map(Number);
  if (pids.some((pid) => !Number.isInteger(pid) || pid <= 0)) {
    throw new Error(`Bridge process check returned unexpected output: ${output}`);
  }
  return pids;
}

export function verifyRestart({ beforePids, afterPids }) {
  if (afterPids === null) return { ok: false, reason: "unverifiable" };
  if (afterPids.length === 0) return { ok: false, reason: "not-running" };

  const previous = new Set(beforePids ?? []);
  if (afterPids.every((pid) => previous.has(pid))) {
    return { ok: false, reason: "not-restarted" };
  }
  return { ok: true, reason: "restarted" };
}

function watchdogStaleMs() {
  const seconds = Number(process.env.BRIDGE_WATCHDOG_STALE_SECONDS);
  if (!Number.isFinite(seconds) || seconds <= 0) return DEFAULT_STALE_MS;
  return seconds * 1000;
}

function rotateLogIfNeeded(file, incomingBytes) {
  if (!fs.existsSync(file)) return;
  if (fs.statSync(file).size + incomingBytes <= LOG_MAX_BYTES) return;

  const rotated = `${file}.1`;
  fs.rmSync(rotated, { force: true });
  fs.renameSync(file, rotated);
}

function appendLog(entry) {
  const file = resolveFromCwd(LOG_FILE);
  const line = `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  rotateLogIfNeeded(file, Buffer.byteLength(line, "utf8"));
  fs.appendFileSync(file, line, "utf8");
}

function readLastLoggedState() {
  try {
    const lines = fs.readFileSync(resolveFromCwd(LOG_FILE), "utf8").trimEnd().split(/\r?\n/);
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      const record = JSON.parse(lines[index]);
      if (typeof record.state === "string") return record.state;
    }
  } catch {
    // A missing or damaged log has no prior state to compare.
  }
  return null;
}

function logStateChange(state, details) {
  if (readLastLoggedState() === state) return;
  appendLog({ state, event: "state-change", ...details });
}

export function buildStopBridgeCommand(pids) {
  if (!Array.isArray(pids)) {
    throw new Error("Bridge stop requires a PID array");
  }

  const uniquePids = [...new Set(pids)];
  if (uniquePids.some((pid) => !Number.isInteger(pid) || pid <= 0)) {
    throw new Error("Bridge stop received an invalid PID");
  }
  return [
    "$ErrorActionPreference = 'Stop'",
    `$knownBridgePids = @(${uniquePids.join(", ")})`,
    "$stopFailures = @()",
    "$keepaliveProcesses = @(Get-CimInstance Win32_Process -Filter \"Name = 'powershell.exe'\" | Where-Object { $_.ProcessId -ne $PID -and $_.CommandLine -and $_.CommandLine -like '*run-openclaw-telegram-bridge.ps1*' })",
    "foreach ($keepaliveProcess in $keepaliveProcesses) { $keepalivePid = [int]$keepaliveProcess.ProcessId; try { Stop-Process -Id $keepalivePid -Force -ErrorAction Stop } catch { if (Get-Process -Id $keepalivePid -ErrorAction SilentlyContinue) { $stopFailures += $_.Exception.Message } } }",
    "foreach ($keepaliveProcess in $keepaliveProcesses) { $keepalivePid = [int]$keepaliveProcess.ProcessId; if (Get-Process -Id $keepalivePid -ErrorAction SilentlyContinue) { try { Wait-Process -Id $keepalivePid -Timeout 5 -ErrorAction Stop } catch { if (Get-Process -Id $keepalivePid -ErrorAction SilentlyContinue) { $stopFailures += $_.Exception.Message } } } }",
    "$runningBridgePids = @(Get-CimInstance Win32_Process -Filter \"Name = 'node.exe'\" | Where-Object { $_.CommandLine -and $_.CommandLine -like '*openclaw-telegram-bridge*' } | ForEach-Object { [int]$_.ProcessId })",
    "$bridgePids = @(($knownBridgePids + $runningBridgePids) | Sort-Object -Unique)",
    "foreach ($bridgePid in $bridgePids) { try { Stop-Process -Id $bridgePid -Force -ErrorAction Stop } catch { if (Get-Process -Id $bridgePid -ErrorAction SilentlyContinue) { $stopFailures += $_.Exception.Message } } }",
    "if ($stopFailures.Count -gt 0) { throw ($stopFailures -join '; ') }"
  ].join("; ");
}

export function stopBridge(pids) {
  if (process.platform !== "win32") {
    throw new Error("Stopping the bridge is only supported on Windows");
  }

  const command = buildStopBridgeCommand(pids);
  const result = spawnSync("powershell.exe", ["-NoProfile", "-Command", command], {
    encoding: "utf8",
    timeout: 10_000,
    windowsHide: true
  });

  if (result.error || result.status !== 0) {
    const detail = result.error?.message || result.stderr.trim() || `exit ${result.status}`;
    throw new Error(`Bridge stop failed: ${detail}`);
  }
}

function startBridge() {
  if (process.platform !== "win32") {
    throw new Error("Bridge restart script is only supported on Windows");
  }

  const script = resolveFromCwd(RESTART_SCRIPT);
  const result = spawnSync("powershell.exe", [
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    script
  ], {
    cwd: process.cwd(),
    encoding: "utf8",
    timeout: 30_000,
    windowsHide: true
  });

  if (result.error || result.status !== 0) {
    const detail = result.error?.message || result.stderr.trim() || `exit ${result.status}`;
    throw new Error(`Bridge restart failed: ${detail}`);
  }
}

function formatHeartbeatAge(heartbeatAtMs, nowMs) {
  if (!Number.isFinite(heartbeatAtMs)) return "未知";

  const ageMs = Math.max(0, nowMs - heartbeatAtMs);
  const totalMinutes = Math.floor(ageMs / 60_000);
  if (totalMinutes >= 60) {
    const hours = Math.floor(totalMinutes / 60);
    const minutes = totalMinutes % 60;
    return `${hours} 小时${minutes > 0 ? ` ${minutes} 分` : ""}前`;
  }
  if (totalMinutes > 0) return `${totalMinutes} 分钟前`;
  return `${Math.floor(ageMs / 1000)} 秒前`;
}

function errorMessage(error) {
  return error?.stack || error?.message || String(error);
}

function readLastSentAlert() {
  try {
    const lines = fs.readFileSync(resolveFromCwd(LOG_FILE), "utf8").trimEnd().split(/\r?\n/);
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      const record = JSON.parse(lines[index]);
      if (record.event === "restart-verified" && record.verificationOk === true) return null;
      if (record.event === "state-change" && record.state === "healthy") return null;
      if (record.event === "alert-sent") {
        return { state: record.state, reason: record.reason };
      }
    }
  } catch {
    // A missing or damaged log has no prior alert to compare.
  }
  return null;
}

async function sendRestartAlert({ decision, heartbeatAtMs, verification }) {
  const age = formatHeartbeatAge(heartbeatAtMs, Date.now());
  const state = verification.ok ? "restart-succeeded" : "restart-failed";
  const reason = verification.ok
    ? decision.reason
    : `${decision.reason}:${verification.reason}`;
  const previousAlert = readLastSentAlert();
  if (!verification.ok && previousAlert?.state === state && previousAlert.reason === reason) {
    appendLog({
      state,
      event: "alert-skipped",
      reason,
      decisionReason: decision.reason,
      verificationReason: verification.reason
    });
    return;
  }

  const text = verification.ok
    ? `✅ 助手桥已自动重启（原因：${decision.reason}，上次心跳 ${age}）`
    : `❗ 助手桥自动重启失败（原因：${decision.reason}，校验：${verification.reason}），需要人工处理`;

  try {
    const result = await sendTelegramMessage(text);
    if (!result.sent) throw new Error(result.reason || "Telegram alert was not sent");
    appendLog({
      state,
      event: "alert-sent",
      reason,
      decisionReason: decision.reason,
      verificationReason: verification.reason
    });
  } catch (error) {
    appendLog({
      state,
      event: "alert-failed",
      reason,
      decisionReason: decision.reason,
      verificationReason: verification.reason,
      error: errorMessage(error)
    });
  }
}

export async function main() {
  loadEnv();

  const heartbeat = readHeartbeat(resolveFromCwd(HEARTBEAT_FILE));
  const heartbeatAtMs = heartbeat?.atMs ?? null;
  const beforePids = getBridgePids();
  const processAlive = beforePids === null ? null : beforePids.length > 0;
  const decision = decideBridgeAction({
    heartbeatAtMs,
    nowMs: Date.now(),
    processAlive,
    staleMs: watchdogStaleMs()
  });

  if (!decision.restart) {
    logStateChange(decision.reason, {
      reason: decision.reason,
      processAlive,
      heartbeatAtMs
    });
    return decision;
  }

  appendLog({
    state: "restart",
    event: "restart-requested",
    reason: decision.reason,
    processAlive,
    beforePids,
    heartbeatAtMs
  });

  let restartError = null;
  try {
    if (beforePids !== null) {
      stopBridge(beforePids);
      await new Promise((resolve) => setTimeout(resolve, STOP_SETTLE_DELAY_MS));
    }
    startBridge();
  } catch (error) {
    restartError = errorMessage(error);
  }

  await new Promise((resolve) => setTimeout(resolve, RESTART_VERIFY_DELAY_MS));

  let afterPids = null;
  let verificationError = null;
  try {
    afterPids = getBridgePids();
  } catch (error) {
    verificationError = errorMessage(error);
  }
  const verification = verifyRestart({ beforePids, afterPids });

  appendLog({
    state: "restart",
    event: "restart-verified",
    reason: decision.reason,
    beforePids,
    afterPids,
    verificationOk: verification.ok,
    verificationReason: verification.reason,
    restartError,
    verificationError
  });
  await sendRestartAlert({ decision, heartbeatAtMs, verification });

  return { ...decision, beforePids, afterPids, verification };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    try {
      appendLog({ state: "error", event: "watchdog-failed", error: errorMessage(error) });
    } catch {
      // The original error is still reported when the log itself is unavailable.
    }
    console.error(errorMessage(error));
    process.exitCode = 1;
  });
}
