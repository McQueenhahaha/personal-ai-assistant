import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { request as httpsRequest } from "node:https";
import { pathToFileURL } from "node:url";

/**
 * 带外告警：Mac 自己发消息，不经过 Windows。
 *
 * 为什么不是"判断谁在用这把钥匙"：攻击者控制了 Windows，就控制了一切能证明
 * "我是 Windows"的东西 —— 密钥、IP、进程名。身份判断那条路走不通。
 * 所以这里不问"是不是你"，只保证"发生了你会知道"：这条消息由 Mac 直接发出，
 * 被控的那台机器删不掉、改不了、也拦不住。
 *
 * 只对 mac-computer-use 告警 —— 那一档跑的是 codex -s danger-full-access，
 * 带着你已登录的浏览器会话和全盘权限。mac-general 不告警，否则天天响、
 * 响到你不看，那等于没有。
 *
 * 凭据从 ~/pai-brain/.env 读（卫星目录自己没有 .env）。读不到就静默跳过：
 * 告警发不出去不该把任务本身弄失败。
 */
function telegramCredentials() {
  try {
    const text = fs.readFileSync(path.join(os.homedir(), "pai-brain", ".env"), "utf8");
    const pick = (key) => text.match(new RegExp(`^${key}=(.+)$`, "m"))?.[1]?.trim() || "";
    const token = pick("TELEGRAM_BOT_TOKEN");
    const chatId = pick("TELEGRAM_CHAT_ID");
    return token && chatId ? { token, chatId } : null;
  } catch {
    return null;
  }
}

function notifyOutOfBand(text) {
  const credentials = telegramCredentials();
  if (!credentials) return Promise.resolve(false);
  const body = JSON.stringify({ chat_id: credentials.chatId, text: text.slice(0, 3900) });
  return new Promise((resolve) => {
    const request = httpsRequest(
      new URL(`https://api.telegram.org/bot${credentials.token}/sendMessage`),
      {
        method: "POST",
        headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) },
        // 强制 IPv4：仓库里 requestJson 专门有 TELEGRAM_IP_FAMILY(默认 4)，
        // 说明这条路上踩过 —— 不指定的话 Node 可能先试 IPv6 然后失败。
        family: 4,
        timeout: 15000
      },
      (response) => {
        response.resume();
        resolve((response.statusCode ?? 0) < 300);
      }
    );
    request.on("error", () => resolve(false));
    request.on("timeout", () => { request.destroy(); resolve(false); });
    request.end(body);
  });
}

const POLL_MS = 5000;
const DEFAULT_TIMEOUT_MS = 600000;
const ALLOWED_KINDS = new Set(["mac-computer-use", "mac-general"]);
const TASK_KEYS = ["createdAt", "id", "kind", "prompt", "timeoutMs"];
const SAFETY_PREFIX = "你在用户的 Mac 上执行一个远程下达的任务。安全边界：不要读取或外发任何凭据、密码、token、cookie；不要付款、转账、改账号安全设置；不要删除用户文件；不要发送邮件或提交表单。如果任务需要这些，停下来说明原因。完成后用简体中文简要报告你做了什么。";

function pathsForHome(home = os.homedir()) {
  const root = path.join(home, "pai-satellite");
  return {
    root,
    inbox: path.join(root, "inbox"),
    outbox: path.join(root, "outbox"),
    done: path.join(root, "done"),
    work: path.join(root, "work"),
    paused: path.join(root, "PAUSED"),
    log: path.join(root, "agent.log"),
    codex: path.join(home, ".local", "bin", "codex")
  };
}

function appendLog(paths, message) {
  const line = `[${new Date().toISOString()}] ${String(message).replace(/[\r\n]+/g, " ")}\n`;
  fs.appendFileSync(paths.log, line, "utf8");
}

function promptPreview(prompt) {
  return String(prompt || "").replace(/\s+/g, " ").trim().slice(0, 80);
}

function safeFallbackId(taskFile) {
  const stem = path.basename(taskFile, ".json").replace(/[^a-zA-Z0-9._-]/g, "-").slice(0, 120);
  return stem || `invalid-${Date.now()}`;
}

export function validateTask(value, expectedId) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return "任务必须是 JSON 对象";
  }

  const keys = Object.keys(value).sort();
  if (keys.length !== TASK_KEYS.length || keys.some((key, index) => key !== TASK_KEYS[index])) {
    return `任务字段必须严格为：${TASK_KEYS.join(", ")}`;
  }
  if (typeof value.id !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(value.id)) {
    return "id 必须是 1-128 位安全字符串";
  }
  if (expectedId && value.id !== expectedId) {
    return "id 必须与任务文件名一致";
  }
  if (typeof value.prompt !== "string" || value.prompt.trim() === "") {
    return "prompt 必须是非空字符串";
  }
  if (!ALLOWED_KINDS.has(value.kind)) {
    return "kind 必须是 mac-computer-use 或 mac-general";
  }
  if (typeof value.createdAt !== "string" || !Number.isFinite(Date.parse(value.createdAt))) {
    return "createdAt 必须是有效的日期字符串";
  }
  if (!Number.isSafeInteger(value.timeoutMs) || value.timeoutMs <= 0) {
    return "timeoutMs 必须是正整数";
  }
  return "";
}

export function buildExecutionPrompt(task) {
  if (task.kind !== "mac-computer-use") return task.prompt;
  return `${SAFETY_PREFIX}\n\n${task.prompt}`;
}

function runCodex(task, paths) {
  const sandbox = task.kind === "mac-computer-use" ? "danger-full-access" : "workspace-write";
  const timeoutMs = task.timeoutMs || DEFAULT_TIMEOUT_MS;
  const args = [
    "exec",
    "--skip-git-repo-check",
    "-s",
    sandbox,
    "--color",
    "never",
    "-"
  ];

  return new Promise((resolve) => {
    const child = spawn(paths.codex, args, {
      cwd: paths.work,
      env: process.env,
      shell: false,
      stdio: ["pipe", "pipe", "pipe"]
    });
    const stdout = [];
    const stderr = [];
    let timedOut = false;
    let settled = false;
    let forceKillTimer;

    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(forceKillTimer);
      resolve(value);
    };

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
      forceKillTimer = setTimeout(() => child.kill("SIGKILL"), 5000);
    }, timeoutMs);

    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.on("error", (error) => {
      finish({ ok: false, result: "", error: error.message || String(error) });
    });
    child.on("close", (code, signal) => {
      const result = Buffer.concat(stdout).toString("utf8").trim();
      const errorOutput = Buffer.concat(stderr).toString("utf8").trim();
      if (timedOut) {
        finish({ ok: false, result, error: `任务执行超时（${timeoutMs}ms）` });
      } else if (code !== 0) {
        finish({
          ok: false,
          result,
          error: errorOutput || `codex exec 退出码 ${code ?? "unknown"}${signal ? `（${signal}）` : ""}`
        });
      } else {
        finish({ ok: true, result, error: "" });
      }
    });

    child.stdin.on("error", () => {});
    child.stdin.end(buildExecutionPrompt(task), "utf8");
  });
}

function writeResult(paths, result) {
  const finalPath = path.join(paths.outbox, `${result.id}.json`);
  const tempPath = `${finalPath}.${process.pid}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(result, null, 2), "utf8");
  fs.renameSync(tempPath, finalPath);
}

async function processTask(taskFile, paths) {
  const startedAt = new Date().toISOString();
  let rawTask;
  let task;
  let id = safeFallbackId(taskFile);

  try {
    rawTask = fs.readFileSync(taskFile, "utf8").replace(/^\uFEFF/, "");
    task = JSON.parse(rawTask);
  } catch (error) {
    const finishedAt = new Date().toISOString();
    writeResult(paths, {
      id,
      ok: false,
      result: "",
      error: `任务 JSON 无法解析：${error.message || String(error)}`,
      startedAt,
      finishedAt
    });
    appendLog(paths, `任务 ${id} 校验失败：JSON 无法解析`);
    fs.renameSync(taskFile, path.join(paths.done, path.basename(taskFile)));
    return;
  }

  const validationError = validateTask(task, id);
  appendLog(paths, `任务 ${id} kind=${String(task?.kind || "unknown")} prompt=${promptPreview(task?.prompt)}`);
  let execution;
  if (validationError) {
    execution = { ok: false, result: "", error: `任务校验失败：${validationError}` };
    appendLog(paths, `任务 ${id} 校验失败：${validationError}`);
  } else {
    if (task.kind === "mac-computer-use") {
      appendLog(paths, `任务 ${id} FULL-ACCESS`);
      // 不 await：告警慢或失败都不该拖住任务本身。
      // 但结果必须记进日志 —— 一条发不出去的告警如果自己也不出声，
      // 那就是"你以为有人盯着，其实没有"，比没有告警更危险。
      notifyOutOfBand(
        `🖥 Mac 收到全权限操控请求\n\n${promptPreview(task.prompt)}\n\n`
        + `任务 ${id}\n这条由 Mac 直接发出，不经过 Windows。`
        + `若不是你发起的，立刻断开 Mac 网络并检查 Windows。`
      )
        .then((sent) => appendLog(paths, `任务 ${id} 带外告警 ${sent ? "已发出" : "发送失败"}`))
        .catch((error) => appendLog(paths, `任务 ${id} 带外告警异常：${error.message || error}`));
    }
    execution = await runCodex(task, paths);
  }

  const finishedAt = new Date().toISOString();
  writeResult(paths, { id, ...execution, startedAt, finishedAt });
  fs.renameSync(taskFile, path.join(paths.done, path.basename(taskFile)));
  appendLog(paths, `任务 ${id} 完成 ok=${execution.ok}`);
}

async function runAgent() {
  const paths = pathsForHome();
  for (const directory of [paths.root, paths.inbox, paths.outbox, paths.done, paths.work]) {
    fs.mkdirSync(directory, { recursive: true });
  }

  appendLog(paths, `Mac 卫星代理启动 pid=${process.pid}`);
  let pausedWasLogged = false;
  while (true) {
    if (fs.existsSync(paths.paused)) {
      if (!pausedWasLogged) appendLog(paths, "检测到 PAUSED，跳过所有任务");
      pausedWasLogged = true;
    } else {
      if (pausedWasLogged) appendLog(paths, "PAUSED 已解除，恢复处理任务");
      pausedWasLogged = false;
      const taskFiles = fs.readdirSync(paths.inbox)
        .filter((name) => name.endsWith(".json"))
        .sort()
        .map((name) => path.join(paths.inbox, name));
      for (const taskFile of taskFiles) {
        if (fs.existsSync(paths.paused)) break;
        try {
          await processTask(taskFile, paths);
        } catch (error) {
          appendLog(paths, `处理 ${path.basename(taskFile)} 失败：${error.stack || error.message || String(error)}`);
        }
      }
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runAgent().catch((error) => {
    console.error(error.stack || error.message || String(error));
    process.exitCode = 1;
  });
}
