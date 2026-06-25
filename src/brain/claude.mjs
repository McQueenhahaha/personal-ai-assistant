import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

function trimError(text, maxLength = 300) {
  const clean = String(text || "").replace(/\s+/g, " ").trim();
  if (clean.length <= maxLength) return clean;
  return `${clean.slice(0, Math.max(0, maxLength - 3))}...`;
}

function quoteWindowsShellArg(value) {
  return `"${String(value).replace(/"/g, "\"\"")}"`;
}

function spawnClaude(cliPath, args) {
  if (process.platform !== "win32") {
    return spawn(cliPath, args, {
      env: process.env,
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true
    });
  }

  return spawn([cliPath, ...args].map(quoteWindowsShellArg).join(" "), {
    env: process.env,
    shell: true,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true
  });
}

export async function runClaudeText(prompt, opts = {}) {
  const {
    cliPath = process.env.CLAUDE_BRAIN_CMD || "claude",
    model = process.env.CLAUDE_BRAIN_MODEL || "",
    sessionId = "",
    resume = false,
    timeoutMs = 120000
  } = opts;
  const args = [
    "-p",
    "--output-format",
    "text",
    "--append-system-prompt",
    "仅用你已有的知识简洁回答用户；不要使用任何工具、不要读写文件或运行命令。"
  ];

  if (model) {
    args.push("--model", model);
  }
  if (sessionId) {
    args.push(...(resume ? ["--resume", sessionId] : ["--session-id", sessionId]));
  }

  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    let settled = false;

    const child = spawnClaude(cliPath, args);
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) {
        reject(error);
        return;
      }
      resolve(result);
    };
    const timer = setTimeout(() => {
      child.kill();
      finish(new Error(`Claude 超时：${timeoutMs}ms`));
    }, timeoutMs);

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.stdin.on("error", () => {
      // Spawn failures can close stdin before the error event is emitted.
    });
    child.on("error", (error) => {
      finish(new Error(`Claude 启动失败：${error.message}`));
    });
    child.on("close", (code, signal) => {
      if (settled) return;
      if (code !== 0) {
        const detail = trimError(stderr);
        const suffix = detail ? `：${detail}` : "";
        finish(new Error(`Claude 退出失败：${code ?? signal}${suffix}`));
        return;
      }

      const result = stdout.trim();
      if (!result) {
        finish(new Error("Claude 返回空"));
        return;
      }
      finish(null, result);
    });

    child.stdin.end(String(prompt ?? ""), "utf8");
  });
}

export function shouldResetChatSession(state, nowMs, idleMs) {
  if (!state?.sessionId) return true;
  return nowMs - state.lastAtMs >= idleMs;
}

async function readChatSessionState(stateFile) {
  try {
    return JSON.parse(await fs.readFile(stateFile, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT" || error instanceof SyntaxError) return null;
    throw error;
  }
}

async function writeChatSessionState(stateFile, state) {
  await fs.mkdir(path.dirname(stateFile), { recursive: true });
  await fs.writeFile(stateFile, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

export async function runClaudeChat(prompt, opts = {}) {
  const {
    nowMs = Date.now(),
    stateFile = process.env.CHAT_SESSION_FILE || "./data/state/telegram-chat-session.json",
    idleMs = (Number(process.env.CHAT_SESSION_IDLE_MINUTES) > 0 ? Number(process.env.CHAT_SESSION_IDLE_MINUTES) : 30) * 60000,
    cliPath,
    model,
    timeoutMs
  } = opts;

  const state = await readChatSessionState(stateFile);
  const reset = shouldResetChatSession(state, nowMs, idleMs);
  let sessionId = reset ? randomUUID() : state.sessionId;
  let resume = !reset;
  let result;

  try {
    result = await runClaudeText(prompt, { cliPath, model, timeoutMs, sessionId, resume });
  } catch (error) {
    if (!resume) throw error;
    sessionId = randomUUID();
    resume = false;
    result = await runClaudeText(prompt, { cliPath, model, timeoutMs, sessionId, resume });
  }

  await writeChatSessionState(stateFile, { sessionId, lastAtMs: nowMs });
  return result;
}
