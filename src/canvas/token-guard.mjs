const DAY_MS = 86400000;

export function tokenExpiryStatus(expiresAtIso, nowMs = Date.now()) {
  const expiresAtMs = Date.parse(String(expiresAtIso || ""));
  if (!Number.isFinite(expiresAtMs) || !Number.isFinite(nowMs)) {
    return { daysLeft: null, level: "ok" };
  }

  const remainingMs = expiresAtMs - nowMs;
  const daysLeft = Math.ceil(remainingMs / DAY_MS);
  if (remainingMs <= 0) return { daysLeft, level: "expired" };
  if (daysLeft <= 3) return { daysLeft, level: "urgent" };
  if (daysLeft <= 14) return { daysLeft, level: "warn" };
  return { daysLeft, level: "ok" };
}
