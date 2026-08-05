import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { isLeaseFresh, isLeaseValid } from "../brain/lease.mjs";
import { resolveNodeId } from "../brain/supervisor.mjs";
import { loadEnv, resolveFromCwd } from "../env.mjs";
import { sendTelegramMessage } from "../telegram.mjs";

export const DEFAULT_STALE_MS = 900_000;

const HEARTBEAT_FILE = "./data/state/telegram-direct-heartbeat.json";
const LEASE_FILE = "./data/state/brain-lease.json";
const LOG_FILE = "./data/logs/bridge-watchdog.log";
const LOG_MAX_BYTES = 1024 * 1024;
const RESTART_SCRIPT = "./scripts/start-openclaw-telegram-bridge-hidden.ps1";
const SUPERVISOR_START_SCRIPT = "./scripts/start-brain-supervisor-hidden.ps1";
const WORKER_LOOP_START_SCRIPT = "./scripts/start-codex-auto-worker-hidden.ps1";
const GAME_WATCHER_START_SCRIPT = "./scripts/start-game-mode-watcher-hidden.ps1";
const RUNNING_FLAG = "./data/assistant-running.flag";
const DESIRED_RUNNING_FLAG = "./data/assistant-desired-running.flag";
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

export function decideBridgeOwnership({ selfId, lease, nowMs, peerConfigured }) {
  if (peerConfigured === false) {
    return { shouldRunLocally: "yes", reason: "single-node" };
  }

  if (!isLeaseValid(lease)) {
    return { shouldRunLocally: "defer", reason: "lease-missing" };
  }

  if (!isLeaseFresh(lease, nowMs)) {
    return { shouldRunLocally: "defer", reason: "lease-stale" };
  }

  if (lease.holder === selfId) {
    return { shouldRunLocally: "yes", reason: "self-holds-lease" };
  }

  return { shouldRunLocally: "no", reason: "peer-holds-lease" };
}

export function decideWorkerLoopAction({
  runningFlagExists,
  processAlive,
  shouldRunLocally
}) {
  if (runningFlagExists === false) return { start: false, reason: "not-desired" };
  if (shouldRunLocally !== "yes") return { start: false, reason: "not-local-brain" };
  if (processAlive === null) return { start: false, reason: "unverifiable" };
  if (processAlive === true) return { start: false, reason: "healthy" };
  return { start: true, reason: "process-missing" };
}

export function decideGameWatcherAction({ desiredFlagExists, processAlive }) {
  if (desiredFlagExists === false) return { start: false, reason: "not-desired" };
  if (processAlive === null) return { start: false, reason: "unverifiable" };
  if (processAlive === true) return { start: false, reason: "healthy" };
  return { start: true, reason: "process-missing" };
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

export function readBrainLease(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function buildProcessCheckCommand({ processName, commandLineFilter }) {
  return [
    "$ErrorActionPreference = 'Stop'",
    `$items = @(Get-CimInstance Win32_Process -Filter "Name = '${processName}'" | Where-Object { $_.CommandLine -and ${commandLineFilter} })`,
    "$items | ForEach-Object { Write-Output $_.ProcessId }"
  ].join("; ");
}

function getPidsByCommandLine({ processName, commandLineFilter, label }) {
  if (process.platform !== "win32") return null;

  const command = buildProcessCheckCommand({ processName, commandLineFilter });
  const result = spawnSync("powershell.exe", ["-NoProfile", "-Command", command], {
    encoding: "utf8",
    timeout: 10_000,
    windowsHide: true
  });

  if (result.error || result.status !== 0) {
    const detail = result.error?.message || result.stderr.trim() || `exit ${result.status}`;
    throw new Error(`${label} process check failed: ${detail}`);
  }

  const output = result.stdout.trim();
  if (!output) return [];

  const pids = output.split(/\s+/).map(Number);
  if (pids.some((pid) => !Number.isInteger(pid) || pid <= 0)) {
    throw new Error(`${label} process check returned unexpected output: ${output}`);
  }
  return pids;
}

export function buildSupervisorProcessCheckCommand() {
  return buildProcessCheckCommand({
    processName: "node.exe",
    commandLineFilter: "($_.CommandLine -like '*brain/supervisor*' -or $_.CommandLine -like '*brain\\supervisor*')"
  });
}

export function getSupervisorPids() {
  return getPidsByCommandLine({
    processName: "node.exe",
    commandLineFilter: "($_.CommandLine -like '*brain/supervisor*' -or $_.CommandLine -like '*brain\\supervisor*')",
    label: "Brain supervisor"
  });
}

export function getBridgePids() {
  return getPidsByCommandLine({
    processName: "node.exe",
    commandLineFilter: "$_.CommandLine -like '*openclaw-telegram-bridge*'",
    label: "Bridge"
  });
}

export function getWorkerLoopPids() {
  return getPidsByCommandLine({
    processName: "powershell.exe",
    commandLineFilter: "$_.ProcessId -ne $PID -and $_.CommandLine -like '*run-codex-auto-worker-loop.ps1*'",
    label: "Codex auto worker loop"
  });
}

export function getGameWatcherPids() {
  return getPidsByCommandLine({
    processName: "powershell.exe",
    commandLineFilter: "$_.ProcessId -ne $PID -and $_.CommandLine -like '*watch-game-mode.ps1*'",
    label: "Game mode watcher"
  });
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

function startSupervisor() {
  if (process.platform !== "win32") {
    throw new Error("Brain supervisor start script is only supported on Windows");
  }

  const script = resolveFromCwd(SUPERVISOR_START_SCRIPT);
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
    throw new Error(`Brain supervisor start failed: ${detail}`);
  }
}

function startWorkerLoop() {
  if (process.platform !== "win32") {
    throw new Error("Codex auto worker loop start script is only supported on Windows");
  }

  const script = resolveFromCwd(WORKER_LOOP_START_SCRIPT);
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
    throw new Error(`Codex auto worker loop start failed: ${detail}`);
  }
}

function startGameWatcher() {
  if (process.platform !== "win32") {
    throw new Error("Game mode watcher start script is only supported on Windows");
  }

  const script = resolveFromCwd(GAME_WATCHER_START_SCRIPT);
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
    throw new Error(`Game mode watcher start failed: ${detail}`);
  }
}

export async function ensureSupervisorRunning({ peerConfigured }, dependencies = {}) {
  if (!peerConfigured) {
    return { checked: false, started: false, reason: "single-node" };
  }

  const getSupervisorPidsImpl = dependencies.getSupervisorPids || getSupervisorPids;
  const startSupervisorImpl = dependencies.startSupervisor || startSupervisor;
  const appendLogImpl = dependencies.appendLog || appendLog;
  const sendSupervisorAlertImpl = dependencies.sendSupervisorAlert || sendSupervisorAlert;
  const supervisorPids = getSupervisorPidsImpl();

  if (supervisorPids === null) {
    return { checked: false, started: false, reason: "unsupported-platform" };
  }
  if (supervisorPids.length > 0) {
    return { checked: true, started: false, reason: "supervisor-running", supervisorPids };
  }

  appendLogImpl({
    state: "supervisor-missing",
    event: "supervisor-start-requested",
    reason: "process-missing"
  });

  let startError = null;
  try {
    await startSupervisorImpl();
  } catch (error) {
    startError = errorMessage(error);
  }

  appendLogImpl({
    state: startError ? "supervisor-start-failed" : "supervisor-start-requested",
    event: startError ? "supervisor-start-failed" : "supervisor-start-dispatched",
    reason: "process-missing",
    startError
  });
  await sendSupervisorAlertImpl({ startError });

  return {
    checked: true,
    started: startError === null,
    reason: startError ? "supervisor-start-failed" : "supervisor-start-requested",
    supervisorPids,
    startError
  };
}

export async function ensureWorkerLoopRunning({ shouldRunLocally }, dependencies = {}) {
  const existsSyncImpl = dependencies.existsSync || fs.existsSync;
  const runningFlagExists = existsSyncImpl(resolveFromCwd(RUNNING_FLAG));
  if (runningFlagExists === false) {
    return { checked: false, started: false, reason: "not-desired" };
  }
  if (shouldRunLocally !== "yes") {
    return { checked: false, started: false, reason: "not-local-brain" };
  }

  const getWorkerLoopPidsImpl = dependencies.getWorkerLoopPids || getWorkerLoopPids;
  const startWorkerLoopImpl = dependencies.startWorkerLoop || startWorkerLoop;
  const appendLogImpl = dependencies.appendLog || appendLog;
  const sendWorkerLoopAlertImpl = dependencies.sendWorkerLoopAlert ||
    ((options) => sendWorkerLoopAlert(options, dependencies));
  const workerLoopPids = getWorkerLoopPidsImpl();
  const processAlive = workerLoopPids === null ? null : workerLoopPids.length > 0;
  const decision = decideWorkerLoopAction({
    runningFlagExists,
    processAlive,
    shouldRunLocally
  });

  if (!decision.start) {
    return { checked: processAlive !== null, started: false, reason: decision.reason };
  }

  appendLogImpl({
    state: "worker-loop-missing",
    event: "worker-loop-start-requested",
    reason: decision.reason
  });

  let startError = null;
  try {
    await startWorkerLoopImpl();
  } catch (error) {
    startError = errorMessage(error);
  }

  appendLogImpl({
    state: startError ? "worker-loop-start-failed" : "worker-loop-start-requested",
    event: startError ? "worker-loop-start-failed" : "worker-loop-start-dispatched",
    reason: decision.reason,
    startError
  });
  await sendWorkerLoopAlertImpl({ startError });

  return {
    checked: true,
    started: startError === null,
    reason: startError ? "worker-loop-start-failed" : "worker-loop-start-requested"
  };
}

export async function ensureGameWatcherRunning({} = {}, dependencies = {}) {
  const existsSyncImpl = dependencies.existsSync || fs.existsSync;
  const desiredFlagExists = existsSyncImpl(resolveFromCwd(DESIRED_RUNNING_FLAG));
  if (desiredFlagExists === false) {
    return { checked: false, started: false, reason: "not-desired" };
  }

  const getGameWatcherPidsImpl = dependencies.getGameWatcherPids || getGameWatcherPids;
  const startGameWatcherImpl = dependencies.startGameWatcher || startGameWatcher;
  const appendLogImpl = dependencies.appendLog || appendLog;
  const sendGameWatcherAlertImpl = dependencies.sendGameWatcherAlert ||
    ((options) => sendGameWatcherAlert(options, dependencies));
  const gameWatcherPids = getGameWatcherPidsImpl();
  const processAlive = gameWatcherPids === null ? null : gameWatcherPids.length > 0;
  const decision = decideGameWatcherAction({
    desiredFlagExists,
    processAlive
  });

  if (!decision.start) {
    return { checked: processAlive !== null, started: false, reason: decision.reason };
  }

  appendLogImpl({
    state: "game-watcher-missing",
    event: "game-watcher-start-requested",
    reason: decision.reason
  });

  let startError = null;
  try {
    await startGameWatcherImpl();
  } catch (error) {
    startError = errorMessage(error);
  }

  appendLogImpl({
    state: startError ? "game-watcher-start-failed" : "game-watcher-start-requested",
    event: startError ? "game-watcher-start-failed" : "game-watcher-start-dispatched",
    reason: decision.reason,
    startError
  });
  await sendGameWatcherAlertImpl({ startError });

  return {
    checked: true,
    started: startError === null,
    reason: startError ? "game-watcher-start-failed" : "game-watcher-start-requested"
  };
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

async function sendWatchdogAlert({ state, reason, text, dedupe, details = {} }) {
  const previousAlert = readLastSentAlert();
  if (dedupe && previousAlert?.state === state && previousAlert.reason === reason) {
    appendLog({
      state,
      event: "alert-skipped",
      reason,
      ...details
    });
    return;
  }

  try {
    const result = await sendTelegramMessage(text);
    if (!result.sent) throw new Error(result.reason || "Telegram alert was not sent");
    appendLog({
      state,
      event: "alert-sent",
      reason,
      ...details
    });
  } catch (error) {
    appendLog({
      state,
      event: "alert-failed",
      reason,
      ...details,
      error: errorMessage(error)
    });
  }
}

async function sendRestartAlert({ decision, heartbeatAtMs, verification }) {
  const age = formatHeartbeatAge(heartbeatAtMs, Date.now());
  const state = verification.ok ? "restart-succeeded" : "restart-failed";
  const reason = verification.ok
    ? decision.reason
    : `${decision.reason}:${verification.reason}`;
  const text = verification.ok
    ? `✅ 助手桥已自动重启（原因：${decision.reason}，上次心跳 ${age}）`
    : `❗ 助手桥自动重启失败（原因：${decision.reason}，校验：${verification.reason}），需要人工处理`;
  await sendWatchdogAlert({
    state,
    reason,
    text,
    dedupe: !verification.ok,
    details: {
      decisionReason: decision.reason,
      verificationReason: verification.reason
    }
  });
}

async function sendSupervisorAlert({ startError }) {
  const state = startError ? "supervisor-start-failed" : "supervisor-start-requested";
  const text = startError
    ? `❗ 大脑 supervisor 不在且自动拉起失败，需要人工处理：${startError}`
    : "⚠️ 大脑 supervisor 不在，看门狗已请求自动拉起";
  await sendWatchdogAlert({
    state,
    reason: "process-missing",
    text,
    dedupe: true,
    details: { startError }
  });
}

async function sendWorkerLoopAlert({ startError }, dependencies = {}) {
  const state = startError ? "worker-loop-start-failed" : "worker-loop-start-requested";
  const text = startError
    ? `❗ codex 队列 worker 自动拉起失败，需要人工处理：${startError}`
    : "⚠️ codex 队列 worker 不在（助手处于运行态），看门狗已请求自动拉起";
  const sendWatchdogAlertImpl = dependencies.sendWatchdogAlert || sendWatchdogAlert;
  await sendWatchdogAlertImpl({
    state,
    reason: "process-missing",
    text,
    dedupe: true,
    details: { startError }
  });
}

async function sendGameWatcherAlert({ startError }, dependencies = {}) {
  const state = startError ? "game-watcher-start-failed" : "game-watcher-start-requested";
  const text = startError
    ? `❗ 游戏模式 watcher 自动拉起失败，需要人工处理：${startError}`
    : "⚠️ 游戏模式 watcher 不在（助手处于期望运行态），看门狗已请求自动拉起";
  const sendWatchdogAlertImpl = dependencies.sendWatchdogAlert || sendWatchdogAlert;
  await sendWatchdogAlertImpl({
    state,
    reason: "process-missing",
    text,
    dedupe: true,
    details: { startError }
  });
}

async function sendOwnershipAlert({ ownership, stopError }) {
  const state = stopError ? "peer-bridge-stop-failed" : "peer-bridge-stopped";
  const text = stopError
    ? `❗ 对端持有大脑租约，但本机桥停止失败，需要人工处理：${stopError}`
    : "⚠️ 对端持有大脑租约，看门狗已停止本机误运行的 Telegram 桥";
  await sendWatchdogAlert({
    state,
    reason: ownership.reason,
    text,
    dedupe: true,
    details: { stopError }
  });
}

export async function reconcileBridgeOwnership({
  ownership,
  beforePids,
  heartbeatAtMs,
  nowMs,
  staleMs = DEFAULT_STALE_MS
}, dependencies = {}) {
  const appendLogImpl = dependencies.appendLog || appendLog;
  const logStateChangeImpl = dependencies.logStateChange || logStateChange;
  const stopBridgeImpl = dependencies.stopBridge || stopBridge;
  const startBridgeImpl = dependencies.startBridge || startBridge;
  const getBridgePidsImpl = dependencies.getBridgePids || getBridgePids;
  const sendRestartAlertImpl = dependencies.sendRestartAlert || sendRestartAlert;
  const sendOwnershipAlertImpl = dependencies.sendOwnershipAlert || sendOwnershipAlert;
  const sleep = dependencies.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const processAlive = beforePids === null ? null : beforePids.length > 0;

  if (ownership.shouldRunLocally === "no") {
    if (processAlive !== true) {
      logStateChangeImpl(ownership.reason, {
        reason: ownership.reason,
        ownershipAction: ownership.shouldRunLocally,
        processAlive,
        beforePids
      });
      return { restart: false, reason: ownership.reason, ownership, stopped: false };
    }

    appendLogImpl({
      state: "peer-bridge-stop",
      event: "peer-bridge-stop-requested",
      reason: ownership.reason,
      beforePids
    });
    let stopError = null;
    try {
      await stopBridgeImpl(beforePids);
    } catch (error) {
      stopError = errorMessage(error);
    }
    appendLogImpl({
      state: stopError ? "peer-bridge-stop-failed" : "peer-bridge-stopped",
      event: stopError ? "peer-bridge-stop-failed" : "peer-bridge-stopped",
      reason: ownership.reason,
      beforePids,
      stopError
    });
    await sendOwnershipAlertImpl({ ownership, stopError });
    return {
      restart: false,
      reason: ownership.reason,
      ownership,
      stopped: stopError === null,
      stopError
    };
  }

  if (ownership.shouldRunLocally === "defer") {
    logStateChangeImpl(ownership.reason, {
      reason: ownership.reason,
      ownershipAction: ownership.shouldRunLocally,
      processAlive,
      beforePids
    });
    return { restart: false, reason: ownership.reason, ownership, stopped: false };
  }

  if (ownership.shouldRunLocally !== "yes") {
    throw new Error(`Unexpected bridge ownership action: ${ownership.shouldRunLocally}`);
  }

  const decision = decideBridgeAction({
    heartbeatAtMs,
    nowMs,
    processAlive,
    staleMs
  });

  if (!decision.restart) {
    logStateChangeImpl(decision.reason, {
      reason: decision.reason,
      ownershipReason: ownership.reason,
      processAlive,
      heartbeatAtMs
    });
    return decision;
  }

  appendLogImpl({
    state: "restart",
    event: "restart-requested",
    reason: decision.reason,
    ownershipReason: ownership.reason,
    processAlive,
    beforePids,
    heartbeatAtMs
  });

  let restartError = null;
  try {
    if (beforePids !== null) {
      await stopBridgeImpl(beforePids);
      await sleep(STOP_SETTLE_DELAY_MS);
    }
    await startBridgeImpl();
  } catch (error) {
    restartError = errorMessage(error);
  }

  await sleep(RESTART_VERIFY_DELAY_MS);

  let afterPids = null;
  let verificationError = null;
  try {
    afterPids = getBridgePidsImpl();
  } catch (error) {
    verificationError = errorMessage(error);
  }
  const verification = verifyRestart({ beforePids, afterPids });

  appendLogImpl({
    state: "restart",
    event: "restart-verified",
    reason: decision.reason,
    ownershipReason: ownership.reason,
    beforePids,
    afterPids,
    verificationOk: verification.ok,
    verificationReason: verification.reason,
    restartError,
    verificationError
  });
  await sendRestartAlertImpl({ decision, heartbeatAtMs, verification });

  return { ...decision, beforePids, afterPids, verification };
}

export async function main(dependencies = {}) {
  if (dependencies.loadEnv) dependencies.loadEnv();
  else loadEnv();

  const env = dependencies.env || process.env;
  const peerConfigured = Boolean(String(env.PEER_TAILSCALE_IP || "").trim());
  const ensureSupervisorRunningImpl = dependencies.ensureSupervisorRunning || ensureSupervisorRunning;
  await ensureSupervisorRunningImpl({ peerConfigured }, dependencies);

  const nowMs = (dependencies.now || Date.now)();
  const readBrainLeaseImpl = dependencies.readBrainLease || readBrainLease;
  const resolveNodeIdImpl = dependencies.resolveNodeId || resolveNodeId;
  const lease = readBrainLeaseImpl(resolveFromCwd(LEASE_FILE));
  const ownership = decideBridgeOwnership({
    selfId: resolveNodeIdImpl(env, process.platform),
    lease,
    nowMs,
    peerConfigured
  });
  const readHeartbeatImpl = dependencies.readHeartbeat || readHeartbeat;
  const heartbeat = readHeartbeatImpl(resolveFromCwd(HEARTBEAT_FILE));
  const heartbeatAtMs = heartbeat?.atMs ?? null;
  const getBridgePidsImpl = dependencies.getBridgePids || getBridgePids;
  const beforePids = getBridgePidsImpl();
  const reconcileBridgeOwnershipImpl = dependencies.reconcileBridgeOwnership || reconcileBridgeOwnership;
  const bridgeResult = await reconcileBridgeOwnershipImpl({
    ownership,
    beforePids,
    heartbeatAtMs,
    nowMs,
    staleMs: dependencies.staleMs || watchdogStaleMs()
  }, dependencies);

  const appendLogImpl = dependencies.appendLog || appendLog;
  const ensureWorkerLoopRunningImpl = dependencies.ensureWorkerLoopRunning || ensureWorkerLoopRunning;
  try {
    await ensureWorkerLoopRunningImpl({ shouldRunLocally: ownership.shouldRunLocally }, dependencies);
  } catch (error) {
    try {
      appendLogImpl({
        state: "error",
        event: "worker-loop-reconcile-failed",
        error: errorMessage(error)
      });
    } catch {
      // The bridge reconcile has already completed; an add-on log failure must not affect it.
    }
  }

  const ensureGameWatcherRunningImpl = dependencies.ensureGameWatcherRunning || ensureGameWatcherRunning;
  try {
    await ensureGameWatcherRunningImpl({}, dependencies);
  } catch (error) {
    try {
      appendLogImpl({
        state: "error",
        event: "game-watcher-reconcile-failed",
        error: errorMessage(error)
      });
    } catch {
      // The bridge reconcile has already completed; an add-on log failure must not affect it.
    }
  }

  return bridgeResult;
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
