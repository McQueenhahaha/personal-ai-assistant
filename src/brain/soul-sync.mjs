import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const REMOTE_SOUL_DIR = "~/pai-satellite/soul/";
const SCP_TIMEOUT_MS = 30000;

export const SOUL_FILES = Object.freeze([
  // 已读消息 key：切换后不能对同一条 Telegram 消息重复回复。
  "data/state/openclaw-telegram-bridge-state.json",
  // Telegram 拉取位置：切换后必须从同一个 update offset 继续消费。
  "data/state/telegram-update-offset.json",
  // 自管对话记忆：切换执行机器后仍要理解最近上下文。
  "data/state/chat-history.json",
  // 待确认任务：用户确认不能因切换而丢失或失配。
  "data/state/pending-approvals.json",
  // Canvas 提醒去重：避免接管后重复发送已发提醒。
  "data/state/canvas-reminders-sent.json",
  // Canvas token 告警去重：避免同一告警在两台机器重复发送。
  "data/state/canvas-token-alert.json",
  // 学校检查去重：保留已处理邮件、作业与通知状态。
  "data/state/school-check-state.json",
  // 大脑租约：两端必须看到同一持有者、心跳与 TTL。
  "data/state/brain-lease.json"
]);

function scpBaseArgs(key) {
  return [
    "-i",
    key,
    "-o",
    "BatchMode=yes",
    "-o",
    "StrictHostKeyChecking=accept-new"
  ];
}

function validateConnection(host, key) {
  const normalizedHost = String(host || "").trim();
  const normalizedKey = String(key || "").trim();
  if (!normalizedHost || normalizedHost.startsWith("-") || /\s/.test(normalizedHost)) {
    throw new Error("灵魂包同步 host 未配置或格式不合法");
  }
  if (!normalizedKey) throw new Error("灵魂包同步 SSH key 未配置");
  return { host: normalizedHost, key: normalizedKey };
}

function oneLine(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function failureDetail(result) {
  return oneLine(result?.stderr || result?.stdout || result?.error?.message) ||
    `退出码 ${result?.status ?? "unknown"}`;
}

function runScp(spawnSyncImpl, args) {
  return spawnSyncImpl("scp", args, {
    encoding: "utf8",
    shell: false,
    windowsHide: true,
    timeout: SCP_TIMEOUT_MS
  });
}

function assertSuccess(result, label) {
  if (result?.error || result?.status !== 0) {
    throw new Error(`${label}：${failureDetail(result)}`);
  }
}

export async function pushSoul({ host, key }, dependencies = {}) {
  const connection = validateConnection(host, key);
  const repoRoot = dependencies.repoRoot || REPO_ROOT;
  const fsImpl = dependencies.fs || fs;
  const spawnSyncImpl = dependencies.spawnSync || spawnSync;
  const localFiles = SOUL_FILES
    .map((relativeFile) => path.join(repoRoot, relativeFile))
    .filter((file) => fsImpl.existsSync(file));

  if (!localFiles.length) return { pushed: [] };

  const result = runScp(spawnSyncImpl, [
    ...scpBaseArgs(connection.key),
    ...localFiles,
    `${connection.host}:${REMOTE_SOUL_DIR}`
  ]);
  assertSuccess(result, "推送灵魂包失败");
  return { pushed: localFiles.map((file) => path.basename(file)) };
}

export async function pullSoul({ host, key }, dependencies = {}) {
  const connection = validateConnection(host, key);
  const fsImpl = dependencies.fs || fs;
  const spawnSyncImpl = dependencies.spawnSync || spawnSync;
  const tempDir = fsImpl.mkdtempSync(path.join(os.tmpdir(), "pai-soul-pull-"));

  try {
    const result = runScp(spawnSyncImpl, [
      ...scpBaseArgs(connection.key),
      "-r",
      `${connection.host}:${REMOTE_SOUL_DIR}.`,
      tempDir
    ]);
    assertSuccess(result, "拉取灵魂包失败");

    const contents = {};
    for (const relativeFile of SOUL_FILES) {
      const localFile = path.join(tempDir, path.basename(relativeFile));
      if (!fsImpl.existsSync(localFile)) continue;
      try {
        const text = fsImpl.readFileSync(localFile, "utf8").replace(/^\uFEFF/, "");
        contents[relativeFile] = JSON.parse(text);
      } catch (error) {
        throw new Error(`解析远端灵魂包文件 ${path.basename(relativeFile)} 失败：${error.message || String(error)}`);
      }
    }
    return contents;
  } finally {
    fsImpl.rmSync(tempDir, { recursive: true, force: true });
  }
}
