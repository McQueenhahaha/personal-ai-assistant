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
      courseCode: "AERO2356",
      courseName: "Flight Mechanics",
      id: 10,
      name: "Homework",
      dueAtMs: nowMs + 86400000,
      url: "https://canvas.test/assignments/10",
      submitted: false,
      pointsPossible: 20
    }]
  });

  assert.equal(output.includes("[AERO2356] Homework"), true);
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
        courseCode: "AERO2356",
        dueMs: nowMs + 86400000,
        url: "https://canvas.test/assignments/10"
      }],
      reason: ""
    })
  });

  assert.equal(output.includes("Fallback homework [AERO2356]"), true);
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
