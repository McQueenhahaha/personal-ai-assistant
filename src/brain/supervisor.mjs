import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  decideRole,
  isLeaseValid,
  loadLease,
  makeLease,
  saveLease
} from "./lease.mjs";
import { pullSoul, pushSoul } from "./soul-sync.mjs";
import { macSatelliteHealth } from "../satellite/mac.mjs";

const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const LEASE_FILE = path.join(REPO_ROOT, "data", "state", "brain-lease.json");
const REMOTE_LEASE_KEY = "data/state/brain-lease.json";
const ROUND_INTERVAL_MS = 30000;
const MIN_UNREACHABLE_STREAK = 3;
const MAC_HOST_PLACEHOLDER = "user@100.x.y.z";

export function resolveNodeId(env = process.env, platform = process.platform) {
  const configured = String(env.BRAIN_NODE_ID || "").trim().toLowerCase();
  if (configured) {
    if (configured !== "windows" && configured !== "mac") {
      throw new Error("BRAIN_NODE_ID 必须是 windows 或 mac");
    }
    return configured;
  }
  return platform === "win32" ? "windows" : "mac";
}

function expandHome(value, home) {
  const input = String(value || "");
  if (input === "~") return home;
  if (input.startsWith("~/") || input.startsWith("~\\")) {
    return path.join(home, input.slice(2));
  }
  return input;
}

function resolvePeerConnection(selfId, env, home) {
  if (selfId !== "windows") {
    // TODO(P5.5 S4): Mac 成为完整大脑时，补 Windows SSH host/key 与探活。
    return null;
  }

  const host = String(env.MAC_SATELLITE_HOST || "").trim();
  if (!host || host === MAC_HOST_PLACEHOLDER) return null;
  const keyValue = env.MAC_SATELLITE_KEY || path.join(home, ".ssh", "pai_mac");
  return {
    host,
    key: path.resolve(expandHome(keyValue, home))
  };
}

export function chooseNewestLease(localLease, peerLease) {
  const localValid = isLeaseValid(localLease);
  const peerValid = isLeaseValid(peerLease);
  if (!localValid) return peerValid ? { lease: peerLease, source: "peer" } : { lease: null, source: "none" };
  if (!peerValid) return { lease: localLease, source: "local" };
  if (Date.parse(peerLease.heartbeatAt) > Date.parse(localLease.heartbeatAt)) {
    return { lease: peerLease, source: "peer" };
  }
  return { lease: localLease, source: "local" };
}

function processFailure(result) {
  return String(result?.stderr || result?.stdout || result?.error?.message ||
    `退出码 ${result?.status ?? "unknown"}`).replace(/\s+/g, " ").trim();
}

function runPowerShell(spawnSyncImpl, args, env) {
  return spawnSyncImpl("powershell.exe", args, {
    encoding: "utf8",
    shell: false,
    windowsHide: true,
    timeout: 30000,
    env
  });
}

export async function ensureBrainServices(shouldRun, dependencies = {}) {
  const platform = dependencies.platform || process.platform;
  if (platform !== "win32") {
    throw new Error("Mac 大脑服务启停留待 P5.5 S4；本阶段只实现 Windows 桥管理");
  }

  const repoRoot = dependencies.repoRoot || REPO_ROOT;
  const spawnSyncImpl = dependencies.spawnSync || spawnSync;
  const bridgeScript = path.join(repoRoot, "src", "openclaw-telegram-bridge.mjs");
  let result;

  if (shouldRun) {
    result = runPowerShell(spawnSyncImpl, [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      path.join(repoRoot, "scripts", "start-openclaw-telegram-bridge-hidden.ps1")
    ], process.env);
  } else {
    const stopCommand = [
      "$bridge = $env:PAI_BRIDGE_SCRIPT",
      "$processes = Get-CimInstance Win32_Process | Where-Object {",
      "  $_.Name -eq 'node.exe' -and $_.CommandLine -and",
      "  ($_.CommandLine -match [regex]::Escape($bridge) -or $_.CommandLine -match 'openclaw-telegram-bridge\\.mjs')",
      "}",
      "$processes | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction Stop }"
    ].join("\n");
    result = runPowerShell(spawnSyncImpl, [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-Command",
      stopCommand
    ], { ...process.env, PAI_BRIDGE_SCRIPT: bridgeScript });
  }

  if (result?.error || result?.status !== 0) {
    const action = shouldRun ? "启动" : "停止";
    throw new Error(`${action}大脑桥失败：${processFailure(result)}`);
  }
  return { running: shouldRun };
}

async function probePeer(selfId, peerConnection, dependencies) {
  if (!peerConnection) return false;
  if (selfId === "windows") {
    const health = await (dependencies.macSatelliteHealth || macSatelliteHealth)({
      env: dependencies.env || process.env,
      homedir: dependencies.homedir || os.homedir
    });
    return health.online === true;
  }
  // TODO(P5.5 S4): Mac -> Windows SSH 探活。
  return false;
}

function logMessage(logger, level, message) {
  logger(`[${new Date().toISOString()}] ${level} ${message}`);
}

export async function runSupervisorRound(state = {}, dependencies = {}) {
  const env = dependencies.env || process.env;
  const platform = dependencies.platform || process.platform;
  const home = dependencies.homedir?.() || os.homedir();
  const selfId = dependencies.selfId || resolveNodeId(env, platform);
  const nowMs = (dependencies.now || Date.now)();
  const leaseFile = dependencies.leaseFile || LEASE_FILE;
  const minUnreachableStreak = dependencies.minUnreachableStreak || MIN_UNREACHABLE_STREAK;
  const logger = dependencies.log || console.log;
  const peerConnection = dependencies.peerConnection !== undefined
    ? dependencies.peerConnection
    : resolvePeerConnection(selfId, env, home);
  const loadLeaseImpl = dependencies.loadLease || loadLease;
  const saveLeaseImpl = dependencies.saveLease || saveLease;
  const pullSoulImpl = dependencies.pullSoul || pullSoul;
  const pushSoulImpl = dependencies.pushSoul || pushSoul;
  const ensureBrainServicesImpl = dependencies.ensureBrainServices || ensureBrainServices;

  const localLease = await loadLeaseImpl(leaseFile);
  let peerLease = null;
  if (peerConnection) {
    try {
      const contents = await pullSoulImpl(peerConnection);
      peerLease = contents[REMOTE_LEASE_KEY] || null;
    } catch (error) {
      logMessage(logger, "WARN", `拉取对端灵魂包失败，继续使用本地租约：${error.message || String(error)}`);
    }
  }

  const newest = chooseNewestLease(localLease, peerLease);
  if (newest.source === "peer") await saveLeaseImpl(leaseFile, newest.lease);

  let peerReachable = false;
  if (peerConnection) {
    try {
      peerReachable = await probePeer(selfId, peerConnection, { ...dependencies, env });
    } catch (error) {
      logMessage(logger, "WARN", `对端探活失败，按不可达处理：${error.message || String(error)}`);
    }
  }

  const previousStreak = Number.isSafeInteger(state.unreachableStreak)
    ? state.unreachableStreak
    : 0;
  const unreachableStreak = !peerConnection
    ? minUnreachableStreak
    : peerReachable
      ? 0
      : previousStreak + 1;

  // 单节点没有可争用租约的对端；遗留的对端租约不能让唯一节点永久待机。
  const effectiveLease = !peerConnection && newest.lease?.holder !== selfId
    ? null
    : newest.lease;
  const decision = decideRole({
    lease: effectiveLease,
    selfId,
    nowMs,
    peerReachable,
    unreachableStreak,
    minUnreachableStreak
  });

  if (decision.action === "standby") {
    await ensureBrainServicesImpl(false);
    logMessage(logger, "INFO", `${selfId} role=satellite action=standby reason=${decision.reason}`);
    return { ...decision, selfId, peerReachable, unreachableStreak, lease: newest.lease };
  }

  await ensureBrainServicesImpl(true);
  const leaseReason = decision.action === "renew"
    ? "renew"
    : decision.action === "takeover"
      ? "takeover"
      : "startup";
  const ttlSeconds = decision.action === "renew" && isLeaseValid(newest.lease)
    ? newest.lease.ttlSeconds
    : 90;
  const nextLease = makeLease(selfId, nowMs, leaseReason, ttlSeconds);
  try {
    await saveLeaseImpl(leaseFile, nextLease);
  } catch (error) {
    try {
      await ensureBrainServicesImpl(false);
    } catch (stopError) {
      logMessage(logger, "ERROR", `租约写入失败后停止大脑桥也失败：${stopError.message || String(stopError)}`);
    }
    throw error;
  }

  if (peerConnection) {
    try {
      await pushSoulImpl(peerConnection);
    } catch (error) {
      logMessage(logger, "WARN", `推送灵魂包失败，本轮租约仍保留：${error.message || String(error)}`);
    }
  }

  logMessage(logger, "INFO", `${selfId} role=brain action=${decision.action} reason=${decision.reason}`);
  return { ...decision, selfId, peerReachable, unreachableStreak, lease: nextLease };
}

export async function runSupervisor({ once = false } = {}, dependencies = {}) {
  const sleep = dependencies.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  let state = { unreachableStreak: 0 };

  while (true) {
    try {
      const result = await runSupervisorRound(state, dependencies);
      state = { unreachableStreak: result.unreachableStreak };
    } catch (error) {
      console.error(`[${new Date().toISOString()}] ERROR supervisor round failed:`, error.stack || error.message || String(error));
      if (once) throw error;
    }
    if (once) return;
    await sleep(ROUND_INTERVAL_MS);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runSupervisor({ once: process.argv.includes("--once") }).catch(() => {
    process.exitCode = 1;
  });
}
