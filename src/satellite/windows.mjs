import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { runClaudeChat } from "../brain/claude.mjs";
import { loadEnv, projectRoot } from "../env.mjs";

const PAYLOAD_KEYS = ["kind", "prompt", "taskId", "timeoutSeconds"];
const MAX_PROMPT_LENGTH = 100000;
const MAX_TIMEOUT_SECONDS = 3600;

export const MAINTENANCE_ACTIONS = Object.freeze([
  "dism-restorehealth",
  "dism-scanhealth",
  "sfc-scannow",
  "defender-quickscan",
  "defender-status",
  "disk-reliability",
  "volume-status"
]);

function failure(error, detail, payload) {
  return {
    ok: false,
    error,
    detail,
    ...(payload?.taskId ? { taskId: payload.taskId } : {}),
    ...(payload?.kind ? { kind: payload.kind } : {})
  };
}

function oneLine(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function processFailure(result) {
  return oneLine(result?.stderr || result?.stdout || result?.error?.message) ||
    `退出码 ${result?.status ?? "unknown"}`;
}

function timedOut(result) {
  return result?.error?.code === "ETIMEDOUT" || result?.signal === "SIGTERM";
}

export function validateWindowsPayload(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return "载荷必须是 JSON 对象";
  }
  const keys = Object.keys(value).sort();
  if (keys.length !== PAYLOAD_KEYS.length || keys.some((key, index) => key !== PAYLOAD_KEYS[index])) {
    return `载荷字段必须严格为：${PAYLOAD_KEYS.join(", ")}`;
  }
  if (typeof value.kind !== "string" || value.kind === "") return "kind 必须是非空字符串";
  if (typeof value.prompt !== "string" || value.prompt.trim() === "") return "prompt 必须是非空字符串";
  if (value.prompt.length > MAX_PROMPT_LENGTH) return `prompt 不能超过 ${MAX_PROMPT_LENGTH} 个字符`;
  if (typeof value.taskId !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(value.taskId)) {
    return "taskId 必须是 1-128 位安全字符串";
  }
  if (
    !Number.isSafeInteger(value.timeoutSeconds) ||
    value.timeoutSeconds <= 0 ||
    value.timeoutSeconds > MAX_TIMEOUT_SECONDS
  ) {
    return `timeoutSeconds 必须是 1-${MAX_TIMEOUT_SECONDS} 的整数`;
  }
  return "";
}

function runScreen(payload, dependencies) {
  const root = dependencies.root || projectRoot();
  const spawnSyncImpl = dependencies.spawnSync || spawnSync;
  const script = path.join(root, "scripts", "take-screenshot.ps1");
  const result = spawnSyncImpl(
    "powershell.exe",
    ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script],
    {
      cwd: root,
      encoding: "utf8",
      shell: false,
      windowsHide: true,
      timeout: payload.timeoutSeconds * 1000
    }
  );
  if (timedOut(result)) return failure("timeout", "截图处理超时", payload);
  if (result?.error || result?.status !== 0) {
    return failure("handler-failed", `截图失败：${processFailure(result)}`, payload);
  }

  const screenshotPath = String(result.stdout || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .at(-1);
  const screenshotRoot = path.join(root, "data", "screenshots");
  const resolved = screenshotPath ? path.resolve(screenshotPath) : "";
  const relative = resolved ? path.relative(screenshotRoot, resolved) : "";
  if (
    !resolved ||
    !path.isAbsolute(screenshotPath) ||
    relative.startsWith("..") ||
    path.isAbsolute(relative) ||
    path.extname(resolved).toLowerCase() !== ".png"
  ) {
    return failure("handler-failed", "截图脚本没有返回预期目录内的 PNG 绝对路径", payload);
  }
  return { ok: true, node: "windows", taskId: payload.taskId, kind: payload.kind, result: resolved };
}

async function runBrowse(payload, dependencies) {
  const browse = dependencies.runClaudeChat || runClaudeChat;
  try {
    const result = await browse(payload.prompt, {
      capability: "browse",
      timeoutMs: payload.timeoutSeconds * 1000
    });
    return { ok: true, node: "windows", taskId: payload.taskId, kind: payload.kind, result };
  } catch (error) {
    const detail = oneLine(error.message || String(error));
    return /超时|timed?\s*out/i.test(detail)
      ? failure("timeout", detail || "浏览处理超时", payload)
      : failure("handler-failed", detail || "浏览处理失败", payload);
  }
}

function runMaintenance(payload, dependencies) {
  // fixedAction comes from this immutable table, never from the untrusted prompt value.
  const fixedAction = MAINTENANCE_ACTIONS.find((action) => action === payload.prompt);
  if (!fixedAction) {
    return failure("maintenance-not-allowed", "维护 action 不在 MAINTENANCE_ACTIONS 白名单内", payload);
  }

  const root = dependencies.root || projectRoot();
  const spawnSyncImpl = dependencies.spawnSync || spawnSync;
  const script = path.join(root, "scripts", "admin-maintenance", "request-admin-maintenance.ps1");
  const result = spawnSyncImpl(
    "powershell.exe",
    [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      script,
      "-Action",
      fixedAction,
      "-TimeoutSeconds",
      String(payload.timeoutSeconds)
    ],
    {
      cwd: root,
      encoding: "utf8",
      shell: false,
      windowsHide: true,
      timeout: (payload.timeoutSeconds + 20) * 1000
    }
  );
  if (timedOut(result)) return failure("timeout", "等待管理员维护结果超时", payload);
  if (result?.error || result?.status !== 0) {
    return failure("handler-failed", `维护请求失败：${processFailure(result)}`, payload);
  }
  return {
    ok: true,
    node: "windows",
    taskId: payload.taskId,
    kind: payload.kind,
    result: String(result.stdout || "").trim()
  };
}

const HANDLERS = Object.freeze({
  screen: runScreen,
  browse: runBrowse,
  maintenance: runMaintenance
});

export async function runWindowsTask(value, dependencies = {}) {
  const validationError = validateWindowsPayload(value);
  if (validationError) return failure("bad-payload", validationError);

  const handler = HANDLERS[value.kind];
  if (!handler) return failure("unknown-kind", `未开放的任务 kind：${value.kind}`, value);

  try {
    return await handler(value, dependencies);
  } catch (error) {
    return failure("handler-failed", oneLine(error.message || String(error)) || "处理器异常", value);
  }
}

async function main() {
  loadEnv();
  let value;
  try {
    value = JSON.parse(fs.readFileSync(0, "utf8"));
  } catch (error) {
    const response = failure("bad-payload", `stdin 不是合法 JSON：${oneLine(error.message || String(error))}`);
    process.stdout.write(`${JSON.stringify(response)}\n`);
    process.exitCode = 1;
    return;
  }

  const response = await runWindowsTask(value);
  process.stdout.write(`${JSON.stringify(response)}\n`);
  if (!response.ok) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stdout.write(`${JSON.stringify(failure("handler-failed", oneLine(error.message || String(error))))}\n`);
    process.exitCode = 1;
  });
}
