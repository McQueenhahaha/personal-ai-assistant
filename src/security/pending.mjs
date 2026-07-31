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
  fs.writeFileSync(file, `${JSON.stringify(store, null, 2)}\n`, "utf8");
  return file;
}

export function createApproval({ prompt, tier, reason, ttlMs } = {}) {
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
