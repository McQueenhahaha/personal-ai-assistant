import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  decideRole,
  isLeaseValid,
  loadLease,
  makeLease,
  saveLease
} from "./lease.mjs";
import { pullSoul, pushSoul, readSoulLease } from "./soul-sync.mjs";
import { macSatelliteHealth } from "../satellite/mac.mjs";
import { loadEnv, timestampForFile } from "../env.mjs";

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
    // Windows 没有 SSH 服务端；Mac 只用 Tailscale ping 探活，不建立 SSH 连接。
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

function readPid(fsImpl, pidFile) {
  try {
    const value = Number.parseInt(fsImpl.readFileSync(pidFile, "utf8").trim(), 10);
    return Number.isSafeInteger(value) && value > 0 ? value : null;
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

function processIsRunning(pid, killImpl) {
  if (!pid) return false;
  try {
    killImpl(pid, 0);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    throw error;
  }
}

function removePidFile(fsImpl, pidFile) {
  fsImpl.rmSync(pidFile, { force: true });
}

async function ensureWindowsBrainServices(shouldRun, dependencies) {
  const repoRoot = dependencies.repoRoot || REPO_ROOT;
  const spawnSyncImpl = dependencies.spawnSync || spawnSync;
  const env = dependencies.env || process.env;
  const bridgeScript = path.join(repoRoot, "src", "openclaw-telegram-bridge.mjs");
  let result;

  if (shouldRun) {
    result = runPowerShell(spawnSyncImpl, [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      path.join(repoRoot, "scripts", "start-openclaw-telegram-bridge-hidden.ps1")
    ], env);
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
    ], { ...env, PAI_BRIDGE_SCRIPT: bridgeScript });
  }

  if (result?.error || result?.status !== 0) {
    const action = shouldRun ? "启动" : "停止";
    throw new Error(`${action}大脑桥失败：${processFailure(result)}`);
  }
  return { running: shouldRun };
}

async function ensureMacBrainServices(shouldRun, dependencies) {
  const repoRoot = dependencies.repoRoot || REPO_ROOT;
  const fsImpl = dependencies.fs || fs;
  const spawnImpl = dependencies.spawn || spawn;
  const killImpl = dependencies.kill || process.kill.bind(process);
  const nodePath = dependencies.nodePath || process.execPath;
  const pidFile = path.join(repoRoot, "data", "state", "bridge.pid");
  const pid = readPid(fsImpl, pidFile);
  const running = processIsRunning(pid, killImpl);

  if (shouldRun && running) return { running: true };
  if (!shouldRun && !running) {
    if (pid) removePidFile(fsImpl, pidFile);
    return { running: false };
  }

  if (!shouldRun) {
    try {
      killImpl(pid);
    } catch (error) {
      if (error?.code !== "ESRCH") throw error;
    }
    removePidFile(fsImpl, pidFile);
    return { running: false };
  }

  const logDir = path.join(repoRoot, "data", "logs");
  fsImpl.mkdirSync(logDir, { recursive: true });
  fsImpl.mkdirSync(path.dirname(pidFile), { recursive: true });
  const logFd = fsImpl.openSync(path.join(logDir, "bridge.log"), "a");
  let child;
  try {
    child = spawnImpl(nodePath, [path.join(repoRoot, "src", "openclaw-telegram-bridge.mjs")], {
      cwd: repoRoot,
      detached: true,
      env: dependencies.env || process.env,
      shell: false,
      stdio: ["ignore", logFd, logFd]
    });
  } finally {
    fsImpl.closeSync(logFd);
  }
  if (!Number.isSafeInteger(child?.pid) || child.pid <= 0) {
    throw new Error("启动 Mac 大脑桥失败：未获得有效 pid");
  }
  child.unref();
  fsImpl.writeFileSync(pidFile, `${child.pid}\n`, "utf8");
  return { running: true, pid: child.pid };
}

export async function ensureBrainServices(shouldRun, dependencies = {}) {
  const platform = dependencies.platform || process.platform;
  if (platform === "win32") {
    return ensureWindowsBrainServices(shouldRun, dependencies);
  }
  if (platform === "darwin") {
    return ensureMacBrainServices(shouldRun, dependencies);
  }
  throw new Error(`不支持在 ${platform} 上管理大脑服务`);
}

export function windowsPeerReachable(dependencies = {}) {
  const env = dependencies.env || process.env;
  const peerIp = String(env.PEER_TAILSCALE_IP || "").trim();
  if (!peerIp) {
    dependencies.onMissingPeerIp?.();
    return false;
  }
  const spawnSyncImpl = dependencies.spawnSync || spawnSync;
  try {
    const result = spawnSyncImpl(
      "/usr/local/bin/tailscale",
      ["ping", "--c=1", "--timeout=5s", peerIp],
      {
        encoding: "utf8",
        shell: false,
        timeout: 10000
      }
    );
    return !result?.error && result?.status === 0;
  } catch {
    return false;
  }
}

async function probePeer(selfId, peerConnection, dependencies) {
  if (selfId === "windows") {
    if (!peerConnection) return false;
    const health = await (dependencies.macSatelliteHealth || macSatelliteHealth)({
      env: dependencies.env || process.env,
      homedir: dependencies.homedir || os.homedir
    });
    return health.online === true;
  }
  return windowsPeerReachable(dependencies);
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
  const readSoulLeaseImpl = dependencies.readSoulLease || readSoulLease;
  const ensureBrainServicesImpl = dependencies.ensureBrainServices || ensureBrainServices;

  const localLease = await loadLeaseImpl(leaseFile);
  let peerReachable = false;
  let missingPeerIpWarningLogged = state.missingPeerIpWarningLogged === true;
  const hasPeer = selfId === "mac" || Boolean(peerConnection);
  if (hasPeer) {
    try {
      peerReachable = await probePeer(selfId, peerConnection, {
        ...dependencies,
        env,
        onMissingPeerIp: () => {
          if (missingPeerIpWarningLogged) return;
          logMessage(logger, "WARN", "PEER_TAILSCALE_IP 未配置，Windows 按不可达处理");
          missingPeerIpWarningLogged = true;
        }
      });
    } catch (error) {
      logMessage(logger, "WARN", `对端探活失败，按不可达处理：${error.message || String(error)}`);
    }
  }

  let peerLease = null;
  if (selfId === "windows" && peerConnection && peerReachable) {
    try {
      peerLease = await readSoulLeaseImpl(peerConnection);
    } catch (error) {
      logMessage(logger, "WARN", `读取 Mac 租约失败，继续使用本地租约：${error.message || String(error)}`);
    }
  }

  const newest = chooseNewestLease(localLease, peerLease);
  if (newest.source === "peer") await saveLeaseImpl(leaseFile, newest.lease);

  const previousStreak = Number.isSafeInteger(state.unreachableStreak)
    ? state.unreachableStreak
    : 0;
  const unreachableStreak = !hasPeer
    ? minUnreachableStreak
    : peerReachable
      ? 0
      : previousStreak + 1;

  // 单节点没有可争用租约的对端；遗留的对端租约不能让唯一节点永久待机。
  const effectiveLease = !hasPeer && newest.lease?.holder !== selfId
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
    let syncedLease = newest.lease;
    if (selfId === "windows" && peerConnection) {
      try {
        const contents = await pullSoulImpl(peerConnection);
        syncedLease = contents[REMOTE_LEASE_KEY] || syncedLease;
      } catch (error) {
        logMessage(logger, "WARN", `拉取 Mac 灵魂包失败，继续使用本地状态：${error.message || String(error)}`);
      }
    }
    await ensureBrainServicesImpl(false);
    logMessage(logger, "INFO", `${selfId} role=satellite action=standby reason=${decision.reason}`);
    return {
      ...decision,
      selfId,
      peerReachable,
      unreachableStreak,
      missingPeerIpWarningLogged,
      lease: syncedLease
    };
  }

  if (decision.action === "takeover" && selfId === "windows" && peerConnection) {
    try {
      await pullSoulImpl(peerConnection);
    } catch (error) {
      logMessage(
        logger,
        "WARN",
        `接管前拉取 Mac 灵魂包失败，放弃本轮接管并转为待机：${error.message || String(error)}`
      );
      try {
        await ensureBrainServicesImpl(false);
      } catch (stopError) {
        logMessage(logger, "ERROR", `放弃接管后停止大脑桥失败：${stopError.message || String(stopError)}`);
      }
      return {
        ...decision,
        role: "satellite",
        action: "standby",
        reason: "takeover-soul-pull-failed",
        selfId,
        peerReachable,
        unreachableStreak,
        missingPeerIpWarningLogged,
        lease: newest.lease
      };
    }
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

  if (selfId === "windows" && peerConnection) {
    try {
      await pushSoulImpl(peerConnection, {
        backupTimestamp: timestampForFile(new Date(nowMs))
      });
    } catch (error) {
      logMessage(logger, "WARN", `推送灵魂包失败，本轮租约仍保留：${error.message || String(error)}`);
    }
  }

  logMessage(logger, "INFO", `${selfId} role=brain action=${decision.action} reason=${decision.reason}`);
  return {
    ...decision,
    selfId,
    peerReachable,
    unreachableStreak,
    missingPeerIpWarningLogged,
    lease: nextLease
  };
}

export async function runSupervisor({ once = false } = {}, dependencies = {}) {
  loadEnv();
  const sleep = dependencies.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  let state = { unreachableStreak: 0, missingPeerIpWarningLogged: false };

  while (true) {
    try {
      const result = await runSupervisorRound(state, dependencies);
      state = {
        unreachableStreak: result.unreachableStreak,
        missingPeerIpWarningLogged: result.missingPeerIpWarningLogged
      };
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
