import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { nodeRegistry, resolveBrainNodeId } from "./registry.mjs";

const DEFAULT_TIMEOUT_MS = 600000;
const POLL_MS = 5000;
const SSH_GRACE_MS = 60000;
const HOST_PLACEHOLDERS = {
  mac: "user@100.x.y.z",
  windows: "user@100.x.y.z"
};
const KIND_CAPABILITIES = {
  "mac-computer-use": "gui-control",
  "mac-general": "codex",
  browse: "browser",
  maintenance: "maintenance",
  screen: "screen"
};

function oneLine(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function expandHome(value, home) {
  const input = String(value || "");
  if (input === "~") return home;
  if (input.startsWith("~/") || input.startsWith("~\\")) {
    return path.join(home, input.slice(2));
  }
  return input;
}

function resolveConnection(nodeId, dependencies = {}) {
  const env = dependencies.env || process.env;
  const platform = dependencies.platform || process.platform;
  const selfId = dependencies.selfId || resolveBrainNodeId(env, platform);
  const node = nodeRegistry({ selfId, env, platform })[nodeId];
  if (!node) throw new Error(`未知节点：${nodeId}`);

  const host = String(node.ssh?.host || "").trim();
  const keyEnv = node.ssh?.keyEnv;
  const keyValue = String(env[keyEnv] || "").trim();
  if (!host || host.startsWith("-") || /\s/.test(host)) {
    const current = host || HOST_PLACEHOLDERS[nodeId];
    throw new Error(`${node.label} 的 SSH 主机未配置或格式不合法（当前：${current}）。请在 .env 配置实际的 SSH 目标。`);
  }
  if (!keyValue) {
    throw new Error(`${node.label} 的 SSH 密钥未配置：${keyEnv}`);
  }

  const home = dependencies.homedir?.() || os.homedir();
  return {
    node,
    host,
    key: path.resolve(expandHome(keyValue, home))
  };
}

function sshBaseArgs(key) {
  return [
    "-i",
    key,
    "-o",
    "BatchMode=yes",
    "-o",
    "StrictHostKeyChecking=accept-new"
  ];
}

function describeFailure(result) {
  return oneLine(result?.stderr || result?.stdout || result?.error?.message) ||
    `退出码 ${result?.status ?? "unknown"}`;
}

function run(spawnSyncImpl, command, args, timeout, options = {}) {
  return spawnSyncImpl(command, args, {
    encoding: "utf8",
    shell: false,
    windowsHide: true,
    timeout,
    ...options
  });
}

/**
 * 探活专用的异步执行器。
 *
 * /status 会去 ssh 探对端，超时 15 秒；Mac 是笔记本、多数时间合着盖，
 * 于是按一下菜单第一项就是 15~30 秒里桥对任何消息都没反应 ——
 * 聊天不回、取消不响应，连急停都按不下去。
 *
 * 这和 runPowerShell 当初那个洞是同一个（openclaw-telegram-bridge.mjs 里
 * 那段注释讲的就是它），只是换了条路径没堵上。派发用的 spawnSync 不动：
 * 那些调用有 scp/stdin 语义，且不在 /status 这种高频交互路径上。
 */
function runProbe(command, args, timeoutMs) {
  return new Promise((resolve) => {
    let settled = false;
    const outChunks = [];
    const errChunks = [];
    const child = spawn(command, args, { shell: false, windowsHide: true });
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      child.kill();
      finish({ status: null, stdout: "", stderr: "", error: new Error(`探活超时（${timeoutMs}ms）`) });
    }, timeoutMs);

    child.stdout.on("data", (chunk) => outChunks.push(chunk));
    child.stderr.on("data", (chunk) => errChunks.push(chunk));
    child.on("error", (error) => finish({ status: null, stdout: "", stderr: "", error }));
    child.on("close", (code) => finish({
      status: code,
      // 收 Buffer 再解码：按 chunk 拼字符串会把跨界的多字节字符切坏。
      stdout: Buffer.concat(outChunks).toString("utf8"),
      stderr: Buffer.concat(errChunks).toString("utf8")
    }));
  });
}

function assertSuccess(result, label) {
  if (result?.error || result?.status !== 0) {
    throw new Error(`${label}失败：${describeFailure(result)}`);
  }
}

function isWaitingForResult(result) {
  if (result?.error || result?.status !== 1 || oneLine(result.stdout)) return false;
  const detail = oneLine(result.stderr);
  return detail === "" || /no such file|not found/i.test(detail);
}

function parseMacResult(text, expectedId) {
  let value;
  try {
    value = JSON.parse(String(text || ""));
  } catch (error) {
    throw new Error(`Mac 卫星返回了无效 JSON：${error.message || String(error)}`);
  }
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    value.id !== expectedId ||
    typeof value.ok !== "boolean" ||
    typeof value.result !== "string" ||
    !(value.error === null || typeof value.error === "string") ||
    typeof value.startedAt !== "string" ||
    typeof value.finishedAt !== "string"
  ) {
    throw new Error("Mac 卫星返回结果结构不合法或任务 id 不匹配");
  }
  return value;
}

function parseWindowsResult(text, expectedId) {
  const lines = String(text || "").split(/\r?\n/).filter((line) => line.trim() !== "");
  if (lines.length !== 1) throw new Error("Windows 代理没有返回单行 JSON");

  let value;
  try {
    value = JSON.parse(lines[0]);
  } catch (error) {
    throw new Error(`Windows 代理返回了无效 JSON：${error.message || String(error)}`);
  }
  if (!value || typeof value !== "object" || Array.isArray(value) || typeof value.ok !== "boolean") {
    throw new Error("Windows 代理返回结果结构不合法");
  }
  if (value.taskId != null && value.taskId !== expectedId) {
    throw new Error("Windows 代理返回的 taskId 不匹配");
  }
  if (value.ok) {
    if (typeof value.result !== "string") throw new Error("Windows 代理成功结果缺少 result");
  } else if (typeof value.error !== "string" || !/^[a-z][a-z0-9-]*$/.test(value.error)) {
    throw new Error("Windows 代理失败结果缺少机器可读 error");
  }
  return value;
}

function effectiveTimeout(timeoutMs) {
  const value = timeoutMs == null ? DEFAULT_TIMEOUT_MS : timeoutMs;
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error("卫星任务 timeoutMs 必须是正整数");
  }
  return value;
}

function requiredCapability(task) {
  return task.capability || KIND_CAPABILITIES[task.kind] || task.kind;
}

function validateTask(node, task) {
  if (!task || typeof task !== "object" || Array.isArray(task)) {
    throw new Error("卫星任务必须是对象");
  }
  if (typeof task.prompt !== "string" || task.prompt.trim() === "") {
    throw new Error("卫星任务 prompt 不能为空");
  }
  if (typeof task.kind !== "string" || task.kind === "") {
    throw new Error("卫星任务 kind 不能为空");
  }
  const capability = requiredCapability(task);
  if (!node.capabilities.includes(capability)) {
    throw new Error(`${node.label} 节点缺少 ${capability} 能力，拒绝派发`);
  }
}

async function dispatchMac(task, connection, dependencies) {
  const timeoutMs = effectiveTimeout(task.timeoutMs);
  const spawnSyncImpl = dependencies.spawnSync || spawnSync;
  const sleep = dependencies.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const now = dependencies.now || Date.now;
  const logError = dependencies.logError || console.error;
  const id = (dependencies.randomUUID || randomUUID)();
  const args = sshBaseArgs(connection.key);
  const createdAt = new Date(now()).toISOString();
  const payload = { id, prompt: task.prompt, kind: task.kind, createdAt, timeoutMs };
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pai-mac-satellite-"));
  const taskFile = path.join(tempDir, `${id}.json`);
  const remoteInboxFile = `pai-satellite/inbox/${id}.json`;
  const remoteOutboxFile = `pai-satellite/outbox/${id}.json`;
  const deadline = now() + timeoutMs + SSH_GRACE_MS;

  try {
    fs.writeFileSync(taskFile, JSON.stringify(payload, null, 2), "utf8");
    const upload = run(
      spawnSyncImpl,
      "scp",
      [...args, taskFile, `${connection.host}:${remoteInboxFile}`],
      Math.min(30000, Math.max(1, deadline - now()))
    );
    assertSuccess(upload, "投递 Mac 卫星任务");

    while (now() <= deadline) {
      const remaining = Math.max(1, deadline - now());
      const fetched = run(
        spawnSyncImpl,
        "ssh",
        [...args, connection.host, "cat", remoteOutboxFile],
        Math.min(15000, remaining)
      );
      if (!fetched?.error && fetched?.status === 0) {
        let parsed;
        try {
          parsed = parseMacResult(fetched.stdout, id);
        } finally {
          try {
            const cleanup = run(
              spawnSyncImpl,
              "ssh",
              [...args, connection.host, "rm", "-f", remoteOutboxFile],
              Math.min(15000, Math.max(1, deadline - now()))
            );
            if (cleanup?.error || cleanup?.status !== 0) {
              logError(`[satellite:mac] 清理远端结果文件失败：${remoteOutboxFile}；${describeFailure(cleanup)}`);
            }
          } catch (error) {
            try {
              logError(`[satellite:mac] 清理远端结果文件失败：${remoteOutboxFile}；${error.message || String(error)}`);
            } catch {
              // Best-effort cleanup and logging must not replace the task result.
            }
          }
        }
        return parsed;
      }
      if (!isWaitingForResult(fetched)) {
        throw new Error(`读取 Mac 卫星结果失败：${describeFailure(fetched)}`);
      }
      const waitMs = Math.min(POLL_MS, deadline - now());
      if (waitMs <= 0) break;
      await sleep(waitMs);
    }

    throw new Error(`等待 Mac 卫星结果超时（总等待 ${timeoutMs + SSH_GRACE_MS}ms）`);
  } finally {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch (error) {
      try {
        logError(`[satellite:mac] 清理本地临时目录失败：${tempDir}；${error.message || String(error)}`);
      } catch {
        // Best-effort cleanup and logging must not replace the task result.
      }
    }
  }
}

function dispatchWindows(task, connection, dependencies) {
  const timeoutMs = effectiveTimeout(task.timeoutMs);
  const spawnSyncImpl = dependencies.spawnSync || spawnSync;
  const taskId = (dependencies.randomUUID || randomUUID)();
  const payload = {
    kind: task.kind,
    prompt: task.prompt,
    taskId,
    timeoutSeconds: Math.max(1, Math.ceil(timeoutMs / 1000))
  };
  const result = run(
    spawnSyncImpl,
    "ssh",
    [...sshBaseArgs(connection.key), connection.host, "run"],
    timeoutMs + SSH_GRACE_MS,
    { input: JSON.stringify(payload) }
  );
  if (result?.error?.code === "ETIMEDOUT") {
    throw new Error(`等待 Windows 代理结果超时（总等待 ${timeoutMs + SSH_GRACE_MS}ms）`);
  }

  let parsed;
  try {
    parsed = parseWindowsResult(result?.stdout, taskId);
  } catch (error) {
    if (result?.error || result?.status !== 0) {
      throw new Error(`Windows 代理调用失败：${describeFailure(result)}`);
    }
    throw error;
  }
  return parsed;
}

export async function dispatchToNode(nodeId, task, dependencies = {}) {
  const env = dependencies.env || process.env;
  const platform = dependencies.platform || process.platform;
  const selfId = dependencies.selfId || resolveBrainNodeId(env, platform);
  const registry = nodeRegistry({ selfId, env, platform });
  const node = registry[nodeId];
  if (!node) throw new Error(`未知节点：${nodeId}`);
  validateTask(node, task);

  if (nodeId === selfId) {
    const localExecute = dependencies.localExecute;
    if (typeof localExecute !== "function") {
      throw new Error(`节点 ${nodeId} 是本机，应当本地执行，不能走 SSH`);
    }
    return localExecute(task);
  }

  const connection = resolveConnection(nodeId, { ...dependencies, selfId });
  if (connection.node.ssh.agentKind === "mac") {
    return dispatchMac(task, connection, dependencies);
  }
  if (connection.node.ssh.agentKind === "windows") {
    return dispatchWindows(task, connection, dependencies);
  }
  throw new Error(`${connection.node.label} 的代理类型不受支持：${connection.node.ssh.agentKind}`);
}

export async function satelliteHealth(nodeId, dependencies = {}) {
  const probeImpl = dependencies.probe || runProbe;
  let connection;
  try {
    connection = resolveConnection(nodeId, dependencies);
  } catch (error) {
    return { ok: false, online: false, agentRunning: false, error: error.message || String(error) };
  }

  const args = sshBaseArgs(connection.key);
  if (connection.node.ssh.agentKind === "windows") {
    const probe = await probeImpl("ssh", [...args, connection.host, "health"], 15000);
    if (probe?.error || probe?.status !== 0) {
      return {
        ok: false,
        online: false,
        agentRunning: false,
        host: connection.host,
        error: `Windows 代理探活失败：${describeFailure(probe)}`
      };
    }
    try {
      const value = JSON.parse(String(probe.stdout || ""));
      if (!value || value.ok !== true || value.node !== "windows") throw new Error("响应结构不合法");
      return { ...value, online: true, agentRunning: true, host: connection.host };
    } catch (error) {
      return {
        ok: false,
        online: false,
        agentRunning: false,
        host: connection.host,
        error: `Windows 代理探活返回无效 JSON：${error.message || String(error)}`
      };
    }
  }

  const probe = await probeImpl("ssh", [...args, connection.host, "true"], 15000);
  if (probe?.error || probe?.status !== 0) {
    return {
      ok: false,
      online: false,
      agentRunning: false,
      host: connection.host,
      error: `SSH 探活失败：${describeFailure(probe)}`
    };
  }

  const agent = await probeImpl(
    "ssh",
    [...args, connection.host, "pgrep", "-f", "pai-satellite/mac-agent.mjs"],
    15000
  );
  if (!agent?.error && agent?.status === 0) {
    return { ok: true, online: true, agentRunning: true, host: connection.host };
  }
  if (!agent?.error && agent?.status === 1) {
    return {
      ok: false,
      online: true,
      agentRunning: false,
      host: connection.host,
      error: "Mac 在线，但卫星代理未运行"
    };
  }
  if (agent?.error || agent?.status === 255) {
    return {
      ok: false,
      online: false,
      agentRunning: false,
      host: connection.host,
      error: `检查卫星代理时 SSH 失败：${describeFailure(agent)}`
    };
  }
  return {
    ok: false,
    online: true,
    agentRunning: false,
    host: connection.host,
    error: `检查卫星代理失败：${describeFailure(agent)}`
  };
}

export function windowsSatelliteHealth(dependencies = {}) {
  return satelliteHealth("windows", dependencies);
}
