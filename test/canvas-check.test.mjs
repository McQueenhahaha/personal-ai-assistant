import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CanvasApiError } from "../src/canvas/api.mjs";
import { runCanvasDue } from "../src/canvas-check.mjs";

const nowMs = Date.parse("2026-08-01T00:00:00Z");

test("runCanvasDue formats the richer API assignment fields", async () => {
  const output = await runCanvasDue({
    now: nowMs,
    listUpcoming: async () => [{
      courseCode: "ENGR1001",
      courseName: "Flight Mechanics",
      id: 10,
      name: "Homework",
      dueAtMs: nowMs + 86400000,
      url: "https://canvas.test/assignments/10",
      submitted: false,
      pointsPossible: 20
    }]
  });

  assert.equal(output.includes("[ENGR1001] Homework"), true);
  assert.equal(output.includes("未提交"), true);
  assert.equal(output.includes("20 分"), true);
  assert.equal(output.includes("降级模式"), false);
});

test("runCanvasDue falls back to ICS and labels degraded mode", async () => {
  const output = await runCanvasDue({
    now: nowMs,
    listUpcoming: async () => {
      throw new Error("API offline");
    },
    loadIcs: async () => ({
      assignments: [{
        uid: "event-assignment-10",
        title: "Fallback homework",
        courseCode: "ENGR1001",
        dueMs: nowMs + 86400000,
        url: "https://canvas.test/assignments/10"
      }],
      reason: ""
    })
  });

  assert.equal(output.includes("Fallback homework [ENGR1001]"), true);
  assert.equal(output.includes("降级模式"), true);
  assert.equal(output.includes("数据来自 ICS"), true);
});

test("runCanvasDue sends and deduplicates a 401 alert before loading ICS", async (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "canvas-due-401-"));
  const tokenAlertStateFile = path.join(tempDir, "token-alert.json");
  const order = [];
  const options = {
    now: nowMs,
    send: async () => order.push("alert"),
    tokenAlertStateFile,
    listUpcoming: async () => {
      throw new CanvasApiError("unauthorized", { status: 401 });
    },
    loadIcs: async () => {
      order.push("ics");
      return { assignments: [], reason: "" };
    }
  };
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));

  await runCanvasDue(options);
  await runCanvasDue(options);

  assert.deepEqual(order, ["alert", "ics", "ics"]);
});

test("按了 /stop 之后 Canvas 检查必须跳过，/due 查询照常回答", async (t) => {
  // 急停在这条路上一直等于没有：Canvas 检查照跑、照发提醒。
  // 学校检查早就在 runSchoolCheckCli 开头查了 isPaused()，只有它漏着。
  const { runCanvasCheck } = await import("../src/canvas-check.mjs");
  const { writePauseState } = await import("../src/state/pause.mjs");

  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pai-canvas-pause-"));
  const previousRoot = process.env.PROJECT_ROOT;
  process.env.PROJECT_ROOT = root;
  t.after(() => {
    if (previousRoot === undefined) delete process.env.PROJECT_ROOT;
    else process.env.PROJECT_ROOT = previousRoot;
    fs.rmSync(root, { recursive: true, force: true });
  });

  writePauseState("stop", root);

  let listed = 0;
  const sent = [];
  const count = await runCanvasCheck({
    now: nowMs,
    send: async (text) => { sent.push(text); },
    listUpcoming: async () => { listed += 1; return []; },
    loadIcs: async () => []
  });

  assert.equal(count, 0);
  assert.equal(sent.length, 0, "暂停期间不该发任何提醒");
  assert.equal(listed, 0, "暂停期间连查都不该查");

  // /due 是用户主动问的，暂停期间也该回答 —— 刻意没在那条路上加早退。
  const due = await runCanvasDue({
    now: nowMs,
    listUpcoming: async () => [],
    loadIcs: async () => []
  });
  assert.equal(typeof due, "string");
});
