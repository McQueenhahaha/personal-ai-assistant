import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import assert from "node:assert/strict";

// .env.example 是新机器唯一的配置清单。代码里新读一个环境变量却忘了往这里加，
// 后果不是报错而是**静默走默认值** —— 换机重装时你完全不知道少配了什么。
// 这件事已经连续四次发生（Codex 连着四个任务都漏加），所以用测试挡住它，
// 而不是靠"记得手动加"。npm run verify 本来就跑 node --test，不需要额外的
// 脚本或 CI 步骤。

const ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));

// 这些是运行期内部路径/测试夹具用的，不该出现在给人抄的配置清单里。
const INTERNAL_ONLY = new Set([
  "PROJECT_ROOT",
  "PENDING_APPROVALS_FILE",
  "AUDIT_LOG_FILE",
  "CODEX_AUTO_LOCK_FILE",
  "CODEX_AUTO_IGNORE_LOCK",
  "OPENCLAW_TELEGRAM_BRIDGE_STATE_FILE",
  "CLAUDE_TEST_ARGS_FILE",
  "OPENCLAW_TELEGRAM_MESSAGES_FILE",
  // 这两个由 sshd 注入，windows-agent 读它们判断来源 —— 不是用户配置项。
  "SSH_CLIENT",
  "SSH_CONNECTION",
  "NODE_ENV",
  "TEMP",
  "TMP",
  "HOME",
  "USERPROFILE",
  "PATH",
  "APPDATA",
  "LOCALAPPDATA",
  "SystemRoot",
  "ComSpec"
]);

function collectSourceFiles(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) collectSourceFiles(full, out);
    else if (entry.name.endsWith(".mjs")) out.push(full);
  }
  return out;
}

test(".env.example 必须覆盖代码里真正读取的每一个环境变量", () => {
  const files = [
    ...collectSourceFiles(path.join(ROOT, "src")),
    ...collectSourceFiles(path.join(ROOT, "satellite"))
  ];

  const used = new Set();
  const patterns = [
    /process\.env\.([A-Z][A-Z0-9_]*)/g,
    /process\.env\[["']([A-Z][A-Z0-9_]*)["']\]/g,
    /env\.([A-Z][A-Z0-9_]*)/g,
    /env\[["']([A-Z][A-Z0-9_]*)["']\]/g,
    /envNumber\(["']([A-Z][A-Z0-9_]*)["']/g,
    /envList\(["']([A-Z][A-Z0-9_]*)["']/g,
    /boolEnv\(["']([A-Z][A-Z0-9_]*)["']/g
  ];
  for (const file of files) {
    const source = fs.readFileSync(file, "utf8");
    for (const pattern of patterns) {
      for (const match of source.matchAll(pattern)) used.add(match[1]);
    }
  }

  const example = fs.readFileSync(path.join(ROOT, ".env.example"), "utf8");
  const documented = new Set(
    [...example.matchAll(/^([A-Z][A-Z0-9_]*)=/gm)].map((match) => match[1])
  );

  const missing = [...used]
    .filter((key) => !documented.has(key) && !INTERNAL_ONLY.has(key))
    .sort();

  assert.deepEqual(
    missing,
    [],
    `这些环境变量代码在读、.env.example 里却没有：\n  ${missing.join("\n  ")}\n`
    + "要么补进 .env.example，要么（若确属内部路径）加进本文件的 INTERNAL_ONLY。"
  );
});
