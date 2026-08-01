import fs from "node:fs";
import path from "node:path";
import { tokenExpiryStatus } from "./token-guard.mjs";

const TOKEN_ALERT_STATE_FILE = "data/state/canvas-token-alert.json";
const CANVAS_BASE_URL_PLACEHOLDER = "https://<your-school>.instructure.com";

function renewalSteps(canvasBaseUrl) {
  const configuredBaseUrl = String(canvasBaseUrl || "").trim().replace(/\/+$/, "");
  const baseUrl = configuredBaseUrl || CANVAS_BASE_URL_PLACEHOLDER;
  const configHint = configuredBaseUrl ? "" : " 请先在 .env 配置 CANVAS_BASE_URL。";
  return `续期：打开 ${baseUrl}/profile/settings → Approved Integrations → + New Access Token → 把新 token 发给我，我来更新。${configHint}`;
}

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
  stateFile = path.resolve(process.cwd(), TOKEN_ALERT_STATE_FILE),
  canvasBaseUrl = process.env.CANVAS_BASE_URL
}) {
  const status = tokenExpiryStatus(expiresAtIso, nowMs);
  if (status.level === "ok" || !expiresAtIso) return false;

  const message = status.level === "expired"
    ? `Canvas token 已到期（${expiresAtIso}）。${renewalSteps(canvasBaseUrl)}`
    : `Canvas token 还有 ${status.daysLeft} 天到期（${expiresAtIso}）。${renewalSteps(canvasBaseUrl)}`;
  return sendOncePerDay(status.level, message, { nowMs, send, stateFile });
}

export async function sendCanvasUnauthorizedAlert({
  nowMs = Date.now(),
  send,
  stateFile = path.resolve(process.cwd(), TOKEN_ALERT_STATE_FILE),
  canvasBaseUrl = process.env.CANVAS_BASE_URL
}) {
  const message = `Canvas token 已失效，请重新生成。${renewalSteps(canvasBaseUrl)}`;
  return sendOncePerDay("unauthorized", message, { nowMs, send, stateFile });
}
