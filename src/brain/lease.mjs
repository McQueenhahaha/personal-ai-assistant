import fs from "node:fs/promises";
import path from "node:path";

const HOLDERS = new Set(["windows", "mac"]);
const REASONS = new Set(["startup", "handover", "takeover", "renew"]);

export function isLeaseValid(lease) {
  return Boolean(
    lease &&
    typeof lease === "object" &&
    !Array.isArray(lease) &&
    HOLDERS.has(lease.holder) &&
    typeof lease.heartbeatAt === "string" &&
    Number.isFinite(Date.parse(lease.heartbeatAt)) &&
    Number.isFinite(lease.ttlSeconds) &&
    lease.ttlSeconds > 0 &&
    REASONS.has(lease.reason)
  );
}

export function isLeaseFresh(lease, nowMs) {
  if (!isLeaseValid(lease) || !Number.isFinite(nowMs)) return false;
  return nowMs - Date.parse(lease.heartbeatAt) <= lease.ttlSeconds * 1000;
}

export function decideRole({
  lease,
  selfId,
  nowMs,
  peerReachable,
  unreachableStreak,
  minUnreachableStreak = 3
}) {
  if (!isLeaseValid(lease)) {
    return {
      role: "brain",
      action: "claim",
      reason: "missing-or-invalid-lease"
    };
  }

  if (lease.holder === selfId) {
    return {
      role: "brain",
      action: "renew",
      reason: "self-holds-lease"
    };
  }

  // Windows 是主力：Mac 只是它离开期间的接力，不该在它回来后继续占着大脑。
  //
  // 为什么需要它（2026-08-21 实测的真实故障）：没有这条规则，大脑一旦交给 Mac
  // 就再也回不来 —— 只要 Mac 还在续租，租约就永远新鲜，Windows 会无限期待机。
  // 2026-08-19 重装后就这样卡了两天，症状是 /digest、/school 这些命令回
  // 「spawn powershell.exe ENOENT」：命令要跑 .ps1，而大脑在没有 PowerShell 的
  // Mac 上。handover 只有「交出去」这一半，收回的那一半此前根本不存在。
  //
  // 规则刻意是**单向的**：Mac 侧看到 Windows 持有新鲜租约仍旧走下面的 standby，
  // 所以两边不会来回抢。交接也不受影响 —— handover 保留 holder 不变，
  // 那种情形在上面的 self-holds-lease 分支就返回了，走不到这里。
  if (selfId === "windows" && isLeaseFresh(lease, nowMs)) {
    return {
      role: "brain",
      action: "takeover",
      reason: "windows-preferred-reclaim"
    };
  }

  if (isLeaseFresh(lease, nowMs)) {
    return {
      role: "satellite",
      action: "standby",
      reason: "peer-lease-fresh"
    };
  }

  if (peerReachable === true) {
    return {
      role: "brain",
      action: "takeover",
      reason: "peer-lease-expired-reachable"
    };
  }

  if (
    peerReachable === false &&
    unreachableStreak >= minUnreachableStreak
  ) {
    return {
      role: "brain",
      action: "takeover",
      reason: "peer-lease-expired-unreachable-threshold"
    };
  }

  return {
    role: "satellite",
    action: "standby",
    reason: "peer-lease-expired-waiting"
  };
}

export function makeLease(selfId, nowMs, reason, ttlSeconds = 90) {
  return {
    holder: selfId,
    heartbeatAt: new Date(nowMs).toISOString(),
    ttlSeconds,
    reason
  };
}

export async function loadLease(file) {
  try {
    const lease = JSON.parse(await fs.readFile(file, "utf8"));
    return isLeaseValid(lease) ? lease : null;
  } catch (error) {
    if (error?.code === "ENOENT" || error instanceof SyntaxError) return null;
    throw error;
  }
}

export async function saveLease(file, lease) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, `${JSON.stringify(lease, null, 2)}\n`, "utf8");
}
