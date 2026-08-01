import fs from "node:fs";
import path from "node:path";
import { tokenExpiryStatus } from "./token-guard.mjs";

const TOKEN_ALERT_STATE_FILE = "data/state/canvas-token-alert.json";
const SETTINGS_URL = "https://rmit.instructure.com/profile/settings";
const RENEWAL_STEPS = `续期：打开 ${SETTINGS_URL} → Approved Integrations → + New Access Token → 把新 token 发给我，我来更新。`;

function dayKey(nowMs) {
  const date = new Date(nowMs);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function readState(stateFile) {
  try {
    const state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
    return state && typeof state === "object" && !Array.isArray(state) ? state : {};
  } catch {
    return {};
  }
}

function writeState(stateFile, state) {
  fs.mkdirSync(path.dirname(stateFile), { recursive: true });
  fs.writeFileSync(stateFile, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

async function sendOncePerDay(level, message, { nowMs, send, stateFile }) {
  const state = readState(stateFile);
  const today = dayKey(nowMs);
  if (state[level] === today) return false;

  await send(message);
  state[level] = today;
  writeState(stateFile, state);
  return true;
}

export async function sendTokenExpiryAlertIfNeeded({
  expiresAtIso,
  nowMs = Date.now(),
  send,
  stateFile = path.resolve(process.cwd(), TOKEN_ALERT_STATE_FILE)
}) {
  const status = tokenExpiryStatus(expiresAtIso, nowMs);
  if (status.level === "ok" || !expiresAtIso) return false;

  const message = status.level === "expired"
    ? `Canvas token 已到期（${expiresAtIso}）。${RENEWAL_STEPS}`
    : `Canvas token 还有 ${status.daysLeft} 天到期（${expiresAtIso}）。${RENEWAL_STEPS}`;
  return sendOncePerDay(status.level, message, { nowMs, send, stateFile });
}

export async function sendCanvasUnauthorizedAlert({
  nowMs = Date.now(),
  send,
  stateFile = path.resolve(process.cwd(), TOKEN_ALERT_STATE_FILE)
}) {
  const message = `Canvas token 已失效，请重新生成。${RENEWAL_STEPS}`;
  return sendOncePerDay("unauthorized", message, { nowMs, send, stateFile });
}
