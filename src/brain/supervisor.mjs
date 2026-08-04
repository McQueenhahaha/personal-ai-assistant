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
const DEFAULT_TAILSCALE_BINS = [
  "/usr/local/bin/tailscale",
  "/Applications/Tailscale.app/Contents/MacOS/Tailscale"
];

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

function peerProbeResult(reachable, determined, detail) {
  const result = { reachable, determined, detail };
  // The satellite registry still reads `online`; keep that caller compatible
  // without adding a fourth field to the probe result contract.
  Object.defineProperty(result, "online", { value: reachable, enumerable: false });
  return result;
}

export function windowsPeerReachable(dependencies = {}) {
  const env = dependencies.env || process.env;
  const peerIp = String(env.PEER_TAILSCALE_IP || "").trim();
  if (!peerIp) {
    dependencies.onMissingPeerIp?.();
    return peerProbeResult(false, false, "PEER_TAILSCALE_IP 未配置");
  }

  const fsImpl = dependencies.fs || fs;
  const configuredBin = String(env.TAILSCALE_BIN || "").trim();
  const candidates = [configuredBin, ...DEFAULT_TAILSCALE_BINS].filter(Boolean);
  let tailscaleBin;
  try {
    tailscaleBin = candidates.find((candidate) => fsImpl.existsSync(candidate));
  } catch (error) {
    return peerProbeResult(
      false,
      false,
      `检查 tailscale 可执行文件失败：${error.message || String(error)}`
    );
  }
  if (!tailscaleBin) {
    return peerProbeResult(false, false, `未找到 tailscale 可执行文件（已检查：${candidates.join("、")}）`);
  }

  const spawnSyncImpl = dependencies.spawnSync || spawnSync;
  try {
    const result = spawnSyncImpl(
      tailscaleBin,
      ["ping", "--c=1", "--timeout=5s", peerIp],
      {
        encoding: "utf8",
        shell: false,
        timeout: 10000
      }
    );
    const output = [result?.stdout, result?.stderr]
      .map((value) => String(value || ""))
      .join("\n");
    const pong = output.split(/\r?\n/).find((line) => /pong from/i.test(line));
    if (pong) return peerProbeResult(true, true, pong.trim());

    if (result?.error) {
      const errorDetail = [result.error.code, result.error.message]
        .filter(Boolean)
        .join(" ");
      return peerProbeResult(false, false, `tailscale 探测失败：${errorDetail || String(result.error)}`);
    }
    if (result?.signal) {
      return peerProbeResult(false, false, `tailscale 探测被信号 ${result.signal} 终止`);
    }
    if (!Number.isInteger(result?.status)) {
      return peerProbeResult(false, false, "tailscale 探测未正常结束");
    }

    const detail = output.replace(/\s+/g, " ").trim();
    return peerProbeResult(
      false,
      true,
      detail ? `未收到 pong from：${detail}` : `未收到 pong from（退出码 ${result.status}）`
    );
  } catch (error) {
    return peerProbeResult(false, false, `tailscale 探测失败：${error.message || String(error)}`);
  }
}

async function probePeer(selfId, peerConnection, dependencies) {
  if (selfId === "windows") {
    if (!peerConnection) return peerProbeResult(false, false, "Mac 对端连接未配置");
    const health = await (dependencies.macSatelliteHealth || macSatelliteHealth)({
      env: dependencies.env || process.env,
      homedir: dependencies.homedir || os.homedir
    });
    if (typeof health?.online !== "boolean") {
      return peerProbeResult(false, false, "Mac 对端探活未返回有效结果");
    }
    return peerProbeResult(
      health.online,
      true,
      health.error || (health.online ? "Mac 对端已应答" : "Mac 对端未应答")
    );
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
  let peerProbe = peerProbeResult(false, false, "本轮未执行对端探活");
  let missingPeerIpWarningLogged = state.missingPeerIpWarningLogged === true;
  const hasPeer = selfId === "mac" || Boolean(peerConnection);
  if (hasPeer) {
    try {
      peerProbe = await probePeer(selfId, peerConnection, { ...dependencies, env });
    } catch (error) {
      peerProbe = peerProbeResult(false, false, `对端探活抛出异常：${error.message || String(error)}`);
    }
    if (!peerProbe.determined) {
      logMessage(logger, "WARN", `对端探活无法判断，本轮不更新不可达计数：${peerProbe.detail}`);
      if (peerProbe.detail.includes("PEER_TAILSCALE_IP")) missingPeerIpWarningLogged = true;
    }
  }
  const peerReachable = peerProbe.reachable;

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
    : !peerProbe.determined
      ? previousStreak
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
  // 退出时必须把自己拉起来的桥一起带走。
  //
  // 正常的角色切换不需要这个 —— 变成卫星那条路本来就会调 ensureBrainServices(false)。
  // 缺的是**被直接终止**的情况：launchctl unload、关机、kill 都是发 SIGTERM，
  // supervisor 当场死掉，没机会跑下一轮；而它 spawn 桥时调过 child.unref()，
  // 于是桥活了下来变成孤儿，继续霸占 Telegram 的 getUpdates。
  // 后果是另一台机器起桥时撞 409 Conflict 并崩溃循环，两边都收不到消息
  // —— 2026-08-04 实测发生过，排查了很久才找到那个孤儿进程。
  //
  // ensureBrainServices(false) 在「本来就没桥」时是安全的空操作，还会顺手
  // 清掉陈旧的 pid 文件，所以卫星节点收到信号时照调不误。
  let shuttingDown = false;
  const shutdown = async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    try {
      await ensureBrainServices(false);
    } catch (error) {
      console.error(
        `[${new Date().toISOString()}] ERROR 退出时停止大脑桥失败:`,
        error.message || String(error)
      );
    }
    process.exit(signal === "SIGINT" ? 130 : 143);
  };
  for (const signal of ["SIGTERM", "SIGINT"]) {
    process.on(signal, () => { void shutdown(signal); });
  }

  runSupervisor({ once: process.argv.includes("--once") }).catch(() => {
    process.exitCode = 1;
  });
}
