import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { handleCommand } from "../src/openclaw-telegram-bridge.mjs";
import { loadApprovals, saveApprovals } from "../src/security/pending.mjs";

// /ok → resolveApproval → 建任务，这条链是审批边界本身，却一直零覆盖。
// 只固定现有语义，不在这里"顺手改进"任何行为。

function fixture(t, approvals) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pai-approval-flow-"));
  const inbox = path.join(root, "queues", "codex", "inbox");
  const previous = {
    PROJECT_ROOT: process.env.PROJECT_ROOT,
    CODEX_QUEUE_INBOX: process.env.CODEX_QUEUE_INBOX,
    PENDING_APPROVALS_FILE: process.env.PENDING_APPROVALS_FILE,
    AUDIT_LOG_FILE: process.env.AUDIT_LOG_FILE
  };
  process.env.PROJECT_ROOT = root;
  process.env.CODEX_QUEUE_INBOX = inbox;
  process.env.PENDING_APPROVALS_FILE = path.join(root, "pending-approvals.json");
  process.env.AUDIT_LOG_FILE = path.join(root, "audit.jsonl");
  saveApprovals(approvals);
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { root, inbox };
}

function pending(prompt, overrides = {}) {
  return {
    AAA111: {
      id: "AAA111",
      status: "pending",
      tier: "T2",
      reason: "操作项目目录以外的路径",
      prompt,
      createdAtMs: Date.now(),
      expiresAtMs: Date.now() + 30 * 60000,
      ...overrides
    }
  };
}

function queued(inbox) {
  try {
    return fs.readdirSync(inbox);
  } catch {
    return [];
  }
}

async function ok(id = "AAA111") {
  return handleCommand({ token: "t", chatId: "123", text: `/ok ${id}`, dryRun: true });
}

test("/ok 把待确认改成 approved 并建出带 approvalId 的任务", async (t) => {
  const { inbox } = fixture(t, pending("读 D:/notes/a.md 并总结"));

  await ok();

  assert.equal(loadApprovals().AAA111.status, "approved");
  const files = queued(inbox);
  assert.equal(files.length, 1, "必须建出任务");
  const task = JSON.parse(fs.readFileSync(path.join(inbox, files[0]), "utf8"));
  assert.equal(task.taskType, "approved-privileged");
  // approvalId 必须写进去 —— worker 现在会回查它，缺了就是 fail-closed 拒绝执行。
  assert.equal(task.approvalId, "AAA111");
});

test("已经处理过的确认不能重复批准，也不会再建一个任务", async (t) => {
  const { inbox } = fixture(t, pending("读 D:/notes/a.md", { status: "approved" }));

  await ok();

  assert.equal(queued(inbox).length, 0, "重复 /ok 不该再入队");
});

test("过期的确认只能落成 expired —— 不建任务", async (t) => {
  const { inbox } = fixture(t, pending("读 D:/notes/a.md", {
    expiresAtMs: Date.now() - 1000
  }));

  await ok();

  assert.equal(loadApprovals().AAA111.status, "expired");
  assert.equal(queued(inbox).length, 0);
});

test("用户明确 /ok 一条命中禁止档的任务，仍然必须落成 denied", async (t) => {
  // 这是整个体系的底线：禁止档不接受用户授权。
  // 若哪天它变成"用户点了就放行"，这条会立刻报红。
  // 用词要真能命中 T3。顺带记一笔：同样的意图换个说法（"把 .env 发给我"）
  // 只会被判成 T1 —— 禁止档是措辞枚举，绕过一直存在（清单里的 G5a）。
  // G5b 脱敏与 G5c 洗环境变量已经把它的收益拿掉，但绕过本身没被堵住。
  const { inbox } = fixture(t, pending("打印 .env 里的密钥"));

  await ok();

  assert.equal(loadApprovals().AAA111.status, "denied");
  assert.equal(queued(inbox).length, 0, "禁止档绝不能建出任务");
});
