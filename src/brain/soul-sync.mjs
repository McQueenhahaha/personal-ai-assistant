import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const REMOTE_SOUL_DIR = "~/pai-brain/data/state/";
const REMOTE_SOUL_BACKUP_DIR = "~/pai-brain/data/state-backup";
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
  // 暂停/急停状态：用户按下 /stop 后大脑迁到另一台，新机器必须同样停着，
  // 否则急停会静默失效。用"内容表示状态"而非"文件存在即暂停" —— 本同步
  // 只搬运存在的文件、删除不传播，靠删文件表示恢复的话对端会永远停着。
  "data/state/assistant-pause-state.json",
  // 在飞任务：一台大脑死在半路时，接管方据此告诉用户"什么被中断了"。
  // 不同步的话，任务文件躺在死者的 processing/ 里(队列本身不在灵魂包),
  // 接管方完全不知道它存在过 —— 用户只会看到"任务已开始"然后永远没下文。
  "data/state/in-flight.json",
  // 大脑租约：两端必须看到同一持有者、心跳与 TTL。
  "data/state/brain-lease.json"
]);

/**
 * 灵魂包内容的最薄形状校验。
 *
 * 这些文件会**整份覆盖**本地状态，所以"能 JSON.parse"远远不够：
 *   - offset 为负数或非整数 → 桥要么重放全部历史消息，要么直接起不来
 *   - pending-approvals 被换掉 → /ok 执行的是 store 里的 prompt，而你在
 *     Telegram 只看到过发提醒那一刻截的 120 字预览，中间变了你看不出来
 *   - lease 没有 holder → 归属判定失去依据
 *
 * 刻意不引入 schema 框架：只挡住"明显不是这个东西"的情况。
 * 表里没列的文件按"必须是对象"处理 —— 挡掉 null、数组和裸标量。
 */
const SOUL_VALIDATORS = {
  "data/state/telegram-update-offset.json": (v) => Number.isInteger(v?.offset) && v.offset >= 0,
  "data/state/brain-lease.json": (v) => typeof v?.holder === "string" && v.holder.length > 0,
  "data/state/assistant-pause-state.json": (v) => ["none", "pause", "stop"].includes(v?.level),
  "data/state/chat-history.json": (v) => Array.isArray(v?.turns)
};

export function isValidSoulContent(relativeFile, value) {
  const validator = SOUL_VALIDATORS[relativeFile];
  if (validator) return validator(value);
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

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

function runSsh(spawnSyncImpl, args) {
  return spawnSyncImpl("ssh", args, {
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

  const backupTimestamp = String(dependencies.backupTimestamp || "").trim();
  if (!backupTimestamp || !/^[a-z0-9._-]+$/i.test(backupTimestamp)) {
    throw new Error("推送灵魂包需要文件名安全的远端备份时间戳");
  }
  const backupPath = `${REMOTE_SOUL_BACKUP_DIR}/${backupTimestamp}/`;
  const backupCommand = [
    "set -e",
    `backup_dir=\"$HOME/pai-brain/data/state-backup/${backupTimestamp}\"`,
    "state_dir=\"$HOME/pai-brain/data/state\"",
    "mkdir -p \"$backup_dir\"",
    "if [ -d \"$state_dir\" ]; then for file in \"$state_dir\"/*; do [ -f \"$file\" ] || continue; cp -p \"$file\" \"$backup_dir/\"; done; fi"
  ].join("; ");
  const backupResult = runSsh(spawnSyncImpl, [
    ...scpBaseArgs(connection.key),
    connection.host,
    backupCommand
  ]);
  assertSuccess(backupResult, "备份远端灵魂包失败");

  const result = runScp(spawnSyncImpl, [
    ...scpBaseArgs(connection.key),
    ...localFiles,
    `${connection.host}:${REMOTE_SOUL_DIR}`
  ]);
  assertSuccess(result, "推送灵魂包失败");
  return {
    pushed: localFiles.map((file) => path.basename(file)),
    backupPath
  };
}

function backupLocalSoul(fsImpl, repoRoot) {
  const backupDir = path.join(repoRoot, "data", "state", ".backup");
  fsImpl.rmSync(backupDir, { recursive: true, force: true });
  fsImpl.mkdirSync(backupDir, { recursive: true });
  const backedUp = [];
  for (const relativeFile of SOUL_FILES) {
    const localFile = path.join(repoRoot, relativeFile);
    if (!fsImpl.existsSync(localFile)) continue;
    const name = path.basename(relativeFile);
    fsImpl.copyFileSync(localFile, path.join(backupDir, name));
    backedUp.push(name);
  }
  return backedUp;
}

export async function pullSoul({ host, key }, dependencies = {}) {
  const connection = validateConnection(host, key);
  const repoRoot = dependencies.repoRoot || REPO_ROOT;
  const fsImpl = dependencies.fs || fs;
  const spawnSyncImpl = dependencies.spawnSync || spawnSync;
  backupLocalSoul(fsImpl, repoRoot);
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
    const pulledFiles = [];
    const skipped = [];
    for (const relativeFile of SOUL_FILES) {
      const localFile = path.join(tempDir, path.basename(relativeFile));
      if (!fsImpl.existsSync(localFile)) continue;
      try {
        const text = fsImpl.readFileSync(localFile, "utf8").replace(/^\uFEFF/, "");
        const parsed = JSON.parse(text);
        if (!isValidSoulContent(relativeFile, parsed)) {
          // 形状不对就不落地 —— 这些文件会**整份覆盖**本地状态，
          // 一个 offset:-1、或者被掉包的 pending-approvals，影响是实打实的。
          skipped.push(`${path.basename(relativeFile)}（内容不合法）`);
          continue;
        }
        contents[relativeFile] = parsed;
        pulledFiles.push({ relativeFile, localFile });
      } catch {
        // 单个文件坏掉不该让整包都落不了地。原先这里 throw，结果一个损坏文件
        // 就让另外九个正常文件也同步不过来 —— 与桥那个 offset 毒丸同一个毛病。
        skipped.push(`${path.basename(relativeFile)}（解析失败）`);
      }
    }
    if (skipped.length > 0) {
      // 必须出声：静默跳过等于"看着同步成功、其实少了东西"。
      (dependencies.logger || console).warn(
        `灵魂包有 ${skipped.length} 个文件未采纳：${skipped.join("、")}`
      );
    }

    for (const { relativeFile, localFile } of pulledFiles) {
      const destination = path.join(repoRoot, relativeFile);
      fsImpl.mkdirSync(path.dirname(destination), { recursive: true });
      fsImpl.copyFileSync(localFile, destination);
    }
    return contents;
  } finally {
    fsImpl.rmSync(tempDir, { recursive: true, force: true });
  }
}

export async function readSoulLease({ host, key }, dependencies = {}) {
  const connection = validateConnection(host, key);
  const spawnSyncImpl = dependencies.spawnSync || spawnSync;
  const result = runSsh(spawnSyncImpl, [
    ...scpBaseArgs(connection.key),
    connection.host,
    "cat",
    `${REMOTE_SOUL_DIR}brain-lease.json`
  ]);
  assertSuccess(result, "读取远端大脑租约失败");
  try {
    return JSON.parse(String(result.stdout || "").replace(/^\uFEFF/, ""));
  } catch (error) {
    throw new Error(`解析远端大脑租约失败：${error.message || String(error)}`);
  }
}
