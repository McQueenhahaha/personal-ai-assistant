import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";

const DEFAULT_HOST = "user@100.x.y.z";
const DEFAULT_TIMEOUT_MS = 600000;
const POLL_MS = 5000;
const SSH_GRACE_MS = 60000;
const TASK_KINDS = new Set(["mac-computer-use", "mac-general"]);

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

function resolveConfig(dependencies = {}) {
  const env = dependencies.env || process.env;
  const home = dependencies.homedir?.() || os.homedir();
  const host = String(env.MAC_SATELLITE_HOST || DEFAULT_HOST).trim();
  const key = path.resolve(expandHome(env.MAC_SATELLITE_KEY || path.join(home, ".ssh", "pai_mac"), home));
  if (!host || host.startsWith("-") || /\s/.test(host)) {
    throw new Error("MAC_SATELLITE_HOST 未配置或格式不合法");
  }
  return { host, key };
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
  return oneLine(result?.stderr || result?.stdout || result?.error?.message) || `退出码 ${result?.status ?? "unknown"}`;
}

function run(spawnSyncImpl, command, args, timeout) {
  return spawnSyncImpl(command, args, {
    encoding: "utf8",
    shell: false,
    windowsHide: true,
    timeout
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

function parseSatelliteResult(text, expectedId) {
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

export async function dispatchToMac({ prompt, kind, timeoutMs } = {}, dependencies = {}) {
  if (typeof prompt !== "string" || prompt.trim() === "") throw new Error("Mac 卫星任务 prompt 不能为空");
  if (!TASK_KINDS.has(kind)) {
    throw new Error("Mac 卫星任务 kind 必须是 mac-computer-use 或 mac-general");
  }

  const effectiveTimeoutMs = timeoutMs == null ? DEFAULT_TIMEOUT_MS : timeoutMs;
  if (!Number.isSafeInteger(effectiveTimeoutMs) || effectiveTimeoutMs <= 0) {
    throw new Error("Mac 卫星任务 timeoutMs 必须是正整数");
  }

  const spawnSyncImpl = dependencies.spawnSync || spawnSync;
  const sleep = dependencies.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const now = dependencies.now || Date.now;
  const id = (dependencies.randomUUID || randomUUID)();
  const { host, key } = resolveConfig(dependencies);
  const args = sshBaseArgs(key);
  const createdAt = new Date(now()).toISOString();
  const task = { id, prompt, kind, createdAt, timeoutMs: effectiveTimeoutMs };
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pai-mac-satellite-"));
  const taskFile = path.join(tempDir, `${id}.json`);
  const remoteInboxFile = `pai-satellite/inbox/${id}.json`;
  const remoteOutboxFile = `pai-satellite/outbox/${id}.json`;
  const deadline = now() + effectiveTimeoutMs + SSH_GRACE_MS;

  try {
    fs.writeFileSync(taskFile, JSON.stringify(task, null, 2), "utf8");
    const upload = run(
      spawnSyncImpl,
      "scp",
      [...args, taskFile, `${host}:${remoteInboxFile}`],
      Math.min(30000, Math.max(1, deadline - now()))
    );
    assertSuccess(upload, "投递 Mac 卫星任务");

    while (now() <= deadline) {
      const remaining = Math.max(1, deadline - now());
      const fetchResult = run(
        spawnSyncImpl,
        "ssh",
        [...args, host, "cat", remoteOutboxFile],
        Math.min(15000, remaining)
      );
      if (!fetchResult?.error && fetchResult?.status === 0) {
        let parsed;
        try {
          parsed = parseSatelliteResult(fetchResult.stdout, id);
        } finally {
          const cleanup = run(
            spawnSyncImpl,
            "ssh",
            [...args, host, "rm", "-f", remoteOutboxFile],
            Math.min(15000, Math.max(1, deadline - now()))
          );
          assertSuccess(cleanup, "清理 Mac 卫星结果");
        }
        return parsed;
      }
      if (!isWaitingForResult(fetchResult)) {
        throw new Error(`读取 Mac 卫星结果失败：${describeFailure(fetchResult)}`);
      }
      const waitMs = Math.min(POLL_MS, deadline - now());
      if (waitMs <= 0) break;
      await sleep(waitMs);
    }

    throw new Error(`等待 Mac 卫星结果超时（总等待 ${effectiveTimeoutMs + SSH_GRACE_MS}ms）`);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

export async function macSatelliteHealth(dependencies = {}) {
  const spawnSyncImpl = dependencies.spawnSync || spawnSync;
  let config;
  try {
    config = resolveConfig(dependencies);
  } catch (error) {
    return { ok: false, online: false, agentRunning: false, error: error.message || String(error) };
  }

  const args = sshBaseArgs(config.key);
  const probe = run(spawnSyncImpl, "ssh", [...args, config.host, "true"], 15000);
  if (probe?.error || probe?.status !== 0) {
    return {
      ok: false,
      online: false,
      agentRunning: false,
      host: config.host,
      error: `SSH 探活失败：${describeFailure(probe)}`
    };
  }

  const agent = run(
    spawnSyncImpl,
    "ssh",
    [...args, config.host, "pgrep", "-f", "pai-satellite/mac-agent.mjs"],
    15000
  );
  if (!agent?.error && agent?.status === 0) {
    return { ok: true, online: true, agentRunning: true, host: config.host };
  }
  if (!agent?.error && agent?.status === 1) {
    return {
      ok: false,
      online: true,
      agentRunning: false,
      host: config.host,
      error: "Mac 在线，但卫星代理未运行"
    };
  }
  if (agent?.error || agent?.status === 255) {
    return {
      ok: false,
      online: false,
      agentRunning: false,
      host: config.host,
      error: `检查卫星代理时 SSH 失败：${describeFailure(agent)}`
    };
  }
  return {
    ok: false,
    online: true,
    agentRunning: false,
    host: config.host,
    error: `检查卫星代理失败：${describeFailure(agent)}`
  };
}
