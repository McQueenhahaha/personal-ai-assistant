import fs from "node:fs";
import path from "node:path";
import { resolveFromCwd } from "../env.mjs";

const DEFAULT_TTL_MINUTES = 30;
const PROCESSED_RETENTION_MS = 24 * 60 * 60 * 1000;
const RESOLVED_STATUSES = new Set(["approved", "denied", "expired"]);

function approvalsFile() {
  return resolveFromCwd(process.env.PENDING_APPROVALS_FILE || "./data/state/pending-approvals.json");
}

function defaultTtlMs() {
  const minutes = Number(process.env.APPROVAL_TTL_MINUTES);
  return (Number.isFinite(minutes) && minutes > 0 ? minutes : DEFAULT_TTL_MINUTES) * 60 * 1000;
}

export function makeApprovalId(nowMs, seq) {
  const safeNowMs = Number.isFinite(Number(nowMs)) ? Math.max(0, Math.trunc(Number(nowMs))) : 0;
  const safeSeq = Number.isFinite(Number(seq)) ? Math.max(0, Math.trunc(Number(seq))) : 0;
  const value = (BigInt(safeNowMs) * 1296n) + BigInt(safeSeq);
  return value.toString(36).toUpperCase().padStart(7, "0").slice(-7);
}

export function isExpired(entry, nowMs) {
  const expiresAtMs = Number(entry?.expiresAtMs);
  const currentMs = Number(nowMs);
  return Number.isFinite(expiresAtMs) && Number.isFinite(currentMs) && currentMs >= expiresAtMs;
}

export function pruneApprovals(store, nowMs) {
  const next = {};
  for (const [id, entry] of Object.entries(store || {})) {
    if (entry?.status === "pending" && isExpired(entry, nowMs)) continue;
    if (
      entry?.status !== "pending" &&
      Number.isFinite(Number(entry?.createdAtMs)) &&
      Number(nowMs) - Number(entry.createdAtMs) >= PROCESSED_RETENTION_MS
    ) {
      continue;
    }
    next[id] = { ...entry };
  }
  return next;
}

export function loadApprovals() {
  const file = approvalsFile();
  if (!fs.existsSync(file)) return {};
  return JSON.parse(fs.readFileSync(file, "utf8") || "{}");
}

export function saveApprovals(store) {
  const file = approvalsFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // 先写临时文件再 rename（同卷 rename 是原子的）。裸 writeFileSync 写到一半被杀
  // ——看门狗的 Stop-Process -Force、断电——就留下半截 JSON，之后 loadApprovals
  // 每次 JSON.parse 抛错：/ok /no /stop /resume 一律「命令执行失败」，worker 也
  // 再造不出待确认，而且是**永久**这样，直到人工删文件。
  // offset 文件当初就是为这个改成 tmp+rename 的，这份被漏掉了。
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(store, null, 2)}\n`, "utf8");
  fs.renameSync(tmp, file);
  return file;
}

// 自旋是**同步阻塞事件循环**的，绝不能重蹈 runPowerShell 冻住桥那个坑，
// 所以上限要钉死。注意 Windows 的定时器粒度约 15ms —— 按 5ms×20 去算会得到
// 100ms，实测却是 ~310ms。这里按真实粒度取 6 次，实测约 90ms。
// 拿不到锁就照旧执行：宁可退化成加锁之前的行为，也绝不把桥卡住
//（进程死在持锁时会留下锁目录，那时所有人都走这条降级路径）。
const LOCK_SPIN_MS = 15;
const LOCK_MAX_SPINS = 6;

/**
 * 把「读—改—写 pending-approvals」整段串起来。
 *
 * 桥是常驻进程，codex-auto-worker 每 20 秒被独立起一次，两个进程同时读改写
 * 同一个文件。最难受的是 /stop：你按下急停、机器人回你「已作废 N 条待确认」，
 * 而 worker 那一瞬间刚好把它自己那份还标着 pending 的旧快照写回去 ——
 * 那 N 条又活了，随后一个 /ok 就能把你以为已经掐掉的特权任务放出去。
 *
 * 注意边界：pending-approvals.json 在灵魂包里，soul-sync 是整份覆盖，
 * 本地锁挡不住它。别因为加了锁就以为跨机也安全了。
 * （当前架构大脑固定 Windows、Mac 只作派活目标，跨机那半边暂不成立。）
 */
export function withApprovalsLock(fn) {
  const lockDir = `${approvalsFile()}.lock`;
  fs.mkdirSync(path.dirname(lockDir), { recursive: true });
  let held = false;
  for (let attempt = 0; attempt < LOCK_MAX_SPINS; attempt += 1) {
    try {
      fs.mkdirSync(lockDir);
      held = true;
      break;
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, LOCK_SPIN_MS);
    }
  }
  try {
    return fn();
  } finally {
    if (held) {
      try {
        fs.rmdirSync(lockDir);
      } catch {
        // 锁目录已被清掉不是问题，别让它盖住 fn 的真实结果。
      }
    }
  }
}

export function createApproval(options = {}) {
  return withApprovalsLock(() => createApprovalUnlocked(options));
}

function createApprovalUnlocked({ prompt, tier, reason, ttlMs } = {}) {
  const nowMs = Date.now();
  const effectiveTtlMs = Number.isFinite(Number(ttlMs)) && Number(ttlMs) > 0
    ? Number(ttlMs)
    : defaultTtlMs();
  const store = pruneApprovals(loadApprovals(), nowMs);
  let seq = 0;
  let id = makeApprovalId(nowMs, seq);
  while (store[id]) {
    seq += 1;
    id = makeApprovalId(nowMs, seq);
  }

  const entry = {
    id,
    prompt: String(prompt || ""),
    tier: String(tier || ""),
    reason: String(reason || ""),
    createdAtMs: nowMs,
    expiresAtMs: nowMs + effectiveTtlMs,
    status: "pending"
  };
  store[id] = entry;
  saveApprovals(store);
  return entry;
}

export function resolveApproval(id, status) {
  return withApprovalsLock(() => resolveApprovalUnlocked(id, status));
}

function resolveApprovalUnlocked(id, status) {
  if (!RESOLVED_STATUSES.has(status)) {
    throw new Error(`Invalid approval status: ${status}`);
  }
  const key = String(id || "").toUpperCase();
  const store = loadApprovals();
  if (!store[key]) return null;
  store[key] = { ...store[key], status };
  saveApprovals(store);
  return store[key];
}
