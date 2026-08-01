import { test } from "node:test";
import assert from "node:assert/strict";
import { formatApiUpcomingList, selectDueReminders } from "../src/canvas/reminders.mjs";

const nowMs = Date.UTC(2026, 0, 1, 0, 0, 0);

function assignment(uid, hoursUntilDue) {
  return {
    uid,
    title: uid,
    courseCode: "TEST1001",
    dueMs: nowMs + (hoursUntilDue * 3600000),
    url: ""
  };
}

test("selectDueReminders chooses the smallest matching threshold", () => {
  const { reminders, sentState } = selectDueReminders([
    assignment("due-50", 50),
    assignment("due-20", 20),
    assignment("due-3", 3),
    assignment("due-100", 100),
    assignment("overdue", -1)
  ], nowMs, null);

  assert.deepEqual(reminders.map(({ uid, thresholdH }) => [uid, thresholdH]), [
    ["due-50", 72],
    ["due-20", 24],
    ["due-3", 6]
  ]);
  assert.deepEqual(sentState, {
    "due-50": [72],
    "due-20": [24],
    "due-3": [6]
  });
});

test("selectDueReminders deduplicates sent thresholds and returns new state", () => {
  const inputState = {
    "due-20": [24]
  };

  const { reminders, sentState } = selectDueReminders([
    assignment("due-20", 20)
  ], nowMs, inputState);

  assert.deepEqual(reminders, []);
  assert.deepEqual(inputState, {
    "due-20": [24]
  });
  assert.notEqual(sentState, inputState);
  assert.notEqual(sentState["due-20"], inputState["due-20"]);
  assert.deepEqual(sentState, {
    "due-20": [24]
  });
});

test("formatApiUpcomingList includes course, remaining time, submission, and points", () => {
  const output = formatApiUpcomingList([{
    courseCode: "ENGR1001",
    courseName: "Systems Engineering",
    id: 9,
    name: "Group assessment",
    dueAtMs: nowMs + (50 * 3600000),
    url: "",
    submitted: false,
    pointsPossible: 30
  }], nowMs);

  assert.equal(output.includes("[ENGR1001] Group assessment"), true);
  assert.equal(output.includes("还有2天2小时"), true);
  assert.equal(output.includes("未提交"), true);
  assert.equal(output.includes("30 分"), true);
});
