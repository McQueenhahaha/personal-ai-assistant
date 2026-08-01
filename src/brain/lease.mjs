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
