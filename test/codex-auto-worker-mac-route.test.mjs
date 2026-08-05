import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { processCodexAutoQueue } from "../src/codex-auto-worker.mjs";

function setupTask(t, task, brainNodeId = "windows") {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pai-capability-route-"));
  const inbox = path.join(tempDir, "queues", "inbox");
  const env = {
    AUDIT_LOG_FILE: path.join(tempDir, "audit.jsonl"),
    BRAIN_NODE_ID: brainNodeId,
    CODEX_AUTO_IGNORE_LOCK: "1",
    CODEX_AUTO_LOCK_FILE: path.join(tempDir, "worker.lock"),
    CODEX_AUTO_MAX_TASKS: "1",
    CODEX_QUEUE_INBOX: inbox,
    PENDING_APPROVALS_FILE: path.join(tempDir, "pending-approvals.json"),
    PROJECT_ROOT: tempDir
  };
  const previous = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));
  Object.assign(process.env, env);
  fs.mkdirSync(inbox, { recursive: true });
  fs.writeFileSync(path.join(inbox, "task.json"), JSON.stringify(task), "utf8");

  // approved-privileged 任务现在要回查审批记录（fail-closed），所以这里得
  // 把审批也建出来 —— 生产里的顺序就是「桥先建审批、你按 /ok、再建任务」。
  // 不建的话任务会被正确地拒绝执行，那是新加的护栏在起作用，不是测试环境问题。
  if (task.approvalId) {
    fs.writeFileSync(
      env.PENDING_APPROVALS_FILE,
      JSON.stringify({
        [task.approvalId]: {
          id: task.approvalId,
          status: "approved",
          tier: "T2",
          reason: "测试用已批准记录",
          prompt: task.prompt
        }
      }),
      "utf8"
    );
  }

  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  return { tempDir };
}

function approvedGuiTask(prompt = "帮我在 Photoshop 里裁个图") {
  return {
    id: "approved-gui",
    title: "Approved GUI",
    taskType: "approved-privileged",
    source: "test",
    prompt,
    approvalId: "ABC123"
  };
}

test("worker keeps unapproved GUI control in the confirmation flow", async (t) => {
  setupTask(t, {
    id: "unapproved-gui",
    title: "Unapproved GUI",
    taskType: "telegram-chat",
    source: "test",
    prompt: "帮我在 Photoshop 里裁个图"
  });
  let probes = 0;

  const results = await processCodexAutoQueue({
    notify: false,
    async nodeProbe() {
      probes += 1;
      return true;
    },
    async dispatchToMac() {
      throw new Error("unapproved GUI task should not be dispatched");
    }
  });

  const resultText = fs.readFileSync(results[0].outFile, "utf8");
  assert.equal(results[0].ok, true);
  assert.match(resultText, /等待用户确认/);
  assert.equal(probes, 0);
});

test("worker routes approved GUI control to Mac when it is online", async (t) => {
  setupTask(t, approvedGuiTask());
  const probed = [];
  const dispatched = [];

  const results = await processCodexAutoQueue({
    notify: false,
    async nodeProbe(nodeId) {
      probed.push(nodeId);
      return true;
    },
    async dispatchToMac(task) {
      dispatched.push(task);
      return { ok: true, result: "done" };
    },
    async runCodexExec() {
      throw new Error("Windows fallback should not run");
    }
  });

  assert.equal(results[0].ok, true);
  assert.deepEqual(probed, ["mac"]);
  assert.deepEqual(dispatched, [
    { prompt: "帮我在 Photoshop 里裁个图", kind: "mac-computer-use" }
  ]);
});

test("worker falls back to Windows when Mac GUI control is offline", async (t) => {
  setupTask(t, approvedGuiTask());
  const probed = [];
  let localRuns = 0;

  const results = await processCodexAutoQueue({
    notify: false,
    async nodeProbe(nodeId) {
      probed.push(nodeId);
      return nodeId === "windows";
    },
    async dispatchToMac() {
      throw new Error("offline Mac should not receive the task");
    },
    async runCodexExec() {
      localRuns += 1;
      return { result: "done" };
    }
  });

  assert.equal(results[0].ok, true);
  assert.deepEqual(probed, ["mac"]);
  assert.equal(localRuns, 1);
});

test("worker keeps Outlook tasks on Windows even when Mac is online", async (t) => {
  setupTask(t, {
    id: "outlook-read",
    title: "Outlook read",
    taskType: "telegram-chat",
    source: "test",
    prompt: "看看 Outlook 里有哪些未读邮件"
  });
  const probed = [];
  let localRuns = 0;

  const results = await processCodexAutoQueue({
    notify: false,
    async nodeProbe(nodeId) {
      probed.push(nodeId);
      return true;
    },
    async dispatchToMac() {
      throw new Error("Outlook should never route to Mac");
    },
    async runClaudeChat() {
      localRuns += 1;
      return "done";
    }
  });

  assert.equal(results[0].ok, true);
  assert.deepEqual(probed, []);
  assert.equal(localRuns, 1);
});

test("worker keeps the local Windows GUI fallback online without probing it", async (t) => {
  setupTask(t, approvedGuiTask());
  let localRuns = 0;

  const results = await processCodexAutoQueue({
    notify: false,
    nodeProbe: async () => false,
    async dispatchToMac() {
      throw new Error("offline nodes should not receive the task");
    },
    async runCodexExec() {
      localRuns += 1;
      return { result: "done" };
    }
  });

  assert.equal(results[0].ok, true);
  assert.equal(localRuns, 1);
});

test("Mac brain handles ordinary chat locally without SSH dispatch", async (t) => {
  setupTask(t, {
    id: "mac-local-chat",
    title: "Mac local chat",
    taskType: "telegram-chat",
    source: "test",
    prompt: "帮我整理一下今天的学习计划"
  }, "mac");
  let localRuns = 0;

  const results = await processCodexAutoQueue({
    notify: false,
    async dispatchToMac() {
      throw new Error("Mac brain must not SSH-dispatch an ordinary task to itself");
    },
    async runClaudeChat() {
      localRuns += 1;
      return "done";
    }
  });

  assert.equal(results[0].ok, true);
  assert.equal(localRuns, 1);
});

test("Mac brain tells the user when a Windows-only capability is offline", async (t) => {
  setupTask(t, {
    id: "mac-outlook-offline",
    title: "Mac Outlook offline",
    taskType: "telegram-chat",
    source: "test",
    prompt: "看看 Outlook 里有哪些未读邮件"
  }, "mac");

  const results = await processCodexAutoQueue({
    notify: false,
    nodeProbe: async () => false,
    async dispatchToMac() {
      throw new Error("Windows-only task must not run on Mac");
    },
    async runClaudeChat() {
      throw new Error("Windows-only task must not run locally on Mac");
    }
  });

  const resultText = fs.readFileSync(results[0].outFile, "utf8");
  assert.equal(results[0].ok, true);
  assert.match(resultText, /这个功能需要另一台电脑，它当前离线/);
});
